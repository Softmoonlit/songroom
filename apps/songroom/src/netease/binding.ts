import { randomBytes } from "node:crypto";
import { v7 } from "uuid";
import { and, eq, gt } from "drizzle-orm";
import type { AppDatabase } from "../db/database.js";
import { neteaseAuthorization, session } from "../db/schema.js";
import { canonicalDigest, validateCommandKey } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import { BusinessError } from "../shared/errors.js";
import type { NeteaseBindingView, QrFlowView } from "../shared/netease-contracts.js";
import type { AdapterInput, AdapterResult, NeteaseAdapter } from "./protocol.js";
import { CredentialVault } from "./credentials.js";

import type { SessionPrincipal } from "../auth.js";
const FLOW_LIFETIME_MS = 5 * 60_000;
type Authorization = typeof neteaseAuthorization.$inferSelect;
type Flow = {
  id: string;
  principal: SessionPrincipal;
  generation: number;
  expiresAt: number;
  status: QrFlowView["status"];
  key?: string;
  qrImage: string | null;
  identity: QrFlowView["identity"];
  cookie?: string;
  authorization: string;
  busy: boolean;
  deviceId: string;
  timer?: NodeJS.Timeout;
  confirmationKey?: string;
};

export class NeteaseBinding {
  readonly #flows = new Map<string, Flow>();
  #generation = 0;
  #stopped = false;

  constructor(readonly database: AppDatabase, readonly adapter: NeteaseAdapter, readonly vault: CredentialVault, readonly now = () => Date.now()) {
    for (const row of database.select().from(neteaseAuthorization).all()) {
      vault.decrypt(row.credentials, { authorizationId: row.id, accountId: row.accountId, generation: row.generation });
    }
  }

  #authorization(userId: string): Authorization | undefined {
    return this.database.select().from(neteaseAuthorization).where(eq(neteaseAuthorization.userId, userId)).get();
  }

  #authorizationVersion(userId: string): string {
    const row = this.#authorization(userId);
    return canonicalDigest(row ? [row.id, row.accountId, row.generation, row.status] : null);
  }

  #discardFlow(userId: string): void {
    const flow = this.#flows.get(userId);
    if (!flow) return;
    clearTimeout(flow.timer);
    delete flow.cookie;
    delete flow.key;
    flow.qrImage = null;
    this.#flows.delete(userId);
  }

  #assertSession(principal: SessionPrincipal): void {
    if (this.#stopped) throw new BusinessError(503, "APP_DRAINING", "服务正在停止，请稍后再试");
    const active = this.database.select({ id: session.id }).from(session).where(and(eq(session.id, principal.sessionId), eq(session.userId, principal.userId), gt(session.expiresAt, new Date(this.now())))).get();
    if (!active) {
      const flow = this.#flows.get(principal.userId);
      if (flow?.principal.sessionId === principal.sessionId) this.#discardFlow(principal.userId);
      throw new BusinessError(401, "SESSION_REQUIRED", "请重新登录点歌台");
    }
  }

  #acceptCommand(principal: SessionPrincipal, key: string, kind: "start" | "confirm", flowId?: string) {
    const command = { accountId: principal.userId, key,
      digest: canonicalDigest({ intent: kind, sessionId: principal.sessionId, ...(kind === "confirm" ? { flowId } : {}) }) };
    return this.database.transaction(tx => {
      this.#assertSession(principal);
      const existing = readCommandResource(tx, command, this.now());
      if (existing) return { flowId: existing, replay: true };
      if (kind === "start" && this.#authorization(principal.userId)) throw new BusinessError(409, "NETEASE_ALREADY_BOUND", "已绑定网易云账号，本页仅提供首次绑定");
      const receipt = recordCommandResource(tx, command, flowId ?? v7(), this.now());
      return { flowId: receipt.resourceId, replay: receipt.replay };
    });
  }

  readBinding(principal: SessionPrincipal): NeteaseBindingView {
    this.#assertSession(principal);
    const row = this.#authorization(principal.userId);
    return row ? { binding: { id: row.id, identity: { accountId: row.accountId, nickname: row.nickname }, status: "active" }, allowedActions: [] }
      : { binding: null, allowedActions: ["startQr"] };
  }

  assertAuthorization(principal: SessionPrincipal, authorizationId: string, version?: string): void {
    this.#assertSession(principal);
    const row = this.#authorization(principal.userId);
    if (!row) throw new BusinessError(409, "NETEASE_AUTH_REQUIRED", "请先完成网易云授权");
    if (row.id !== authorizationId || (version !== undefined && version !== this.#authorizationVersion(principal.userId))) {
      throw new BusinessError(409, "AUTHORIZATION_CHANGED", "网易云授权已变化，请重新确认身份");
    }
  }

  async verifyAuthorization(principal: SessionPrincipal, authorizationId: string): Promise<string> {
    this.assertAuthorization(principal, authorizationId);
    const row = this.#authorization(principal.userId)!;
    const version = this.#authorizationVersion(principal.userId);
    const cookie = this.vault.decrypt(row.credentials, { authorizationId: row.id, accountId: row.accountId, generation: row.generation });
    const result = await this.adapter.call({ operation: "identity", cookie, expectedAccountId: row.accountId });
    this.assertAuthorization(principal, authorizationId, version);
    if (!result.ok) throw new BusinessError(502, result.error.code, "无法核实当前网易云授权，请检查授权后再建房");
    if (result.data.accountId !== row.accountId) throw new BusinessError(409, "ACCOUNT_MISMATCH", "网易云账号与当前绑定不一致，请重新确认授权");
    return version;
  }

  #current(principal: SessionPrincipal, id: string): Flow {
    this.#assertSession(principal);
    const flow = this.#flows.get(principal.userId);
    if (!flow || flow.id !== id || flow.principal.sessionId !== principal.sessionId) {
      throw new BusinessError(404, "QR_FLOW_UNAVAILABLE", "扫码流程不可用，请在发起扫码的会话中重新开始");
    }
    if (flow.expiresAt <= this.now()) {
      this.#discardFlow(principal.userId);
      throw new BusinessError(409, "QR_FLOW_EXPIRED", "二维码已过期，请重新开始扫码");
    }
    if (flow.authorization !== this.#authorizationVersion(principal.userId) && flow.status !== "completed") {
      this.#discardFlow(principal.userId);
      throw new BusinessError(409, "AUTHORIZATION_CHANGED", "授权状态已变化，请重新开始扫码");
    }
    return flow;
  }

  #assertCurrent(flow: Flow): void {
    const current = this.#current(flow.principal, flow.id);
    if (current.generation !== flow.generation) throw new BusinessError(409, "QR_FLOW_UNAVAILABLE", "扫码流程已被替代");
  }

  #view(flow: Flow): QrFlowView {
    return { id: flow.id, expiresAt: new Date(flow.expiresAt).toISOString(), status: flow.status, qrImage: flow.qrImage, identity: flow.identity,
      allowedActions: flow.status === "awaitingConfirmation" ? ["confirm"] : flow.status === "completed" ? [] : ["check"] };
  }

  readFlow(principal: SessionPrincipal, id: string): QrFlowView {
    return this.#view(this.#current(principal, id));
  }

  async #call<I extends AdapterInput>(input: I, flow: Flow): Promise<Extract<AdapterResult<I["operation"]>, { ok: true }>["data"]> {
    const result = await this.adapter.call({ ...input, deviceId: flow.deviceId });
    if (!result.ok) throw new BusinessError(502, result.error.code, "网易云暂时无法完成此次请求，请根据授权状态处理");
    return result.data;
  }

  async start(principal: SessionPrincipal, key: string): Promise<QrFlowView> {
    this.#assertSession(principal);
    validateCommandKey(key, this.now());
    const command = this.#acceptCommand(principal, key, "start");
    if (command.replay) return this.readFlow(principal, command.flowId);
    const flow: Flow = { id: command.flowId, principal, generation: ++this.#generation, expiresAt: this.now() + FLOW_LIFETIME_MS, status: "waiting", qrImage: null, identity: null,
      authorization: this.#authorizationVersion(principal.userId), busy: true, deviceId: randomBytes(26).toString("hex").toUpperCase() };
    this.#discardFlow(principal.userId);
    this.#flows.set(principal.userId, flow);
    // 此计时器只销毁过期授权材料；结果提交仍独立核验会话、代次与绝对有效期。
    flow.timer = setTimeout(() => {
      if (this.#flows.get(principal.userId) === flow) this.#discardFlow(principal.userId);
    }, FLOW_LIFETIME_MS).unref();
    try {
      const qrKey = await this.#call({ operation: "qrKey" }, flow);
      this.#assertCurrent(flow);
      flow.key = qrKey.key;
      const qr = await this.#call({ operation: "qrCreate", key: qrKey.key }, flow);
      this.#assertCurrent(flow);
      flow.qrImage = qr.image;
      return this.#view(flow);
    } catch (error) {
      if (this.#flows.get(principal.userId) === flow) this.#discardFlow(principal.userId);
      throw error;
    } finally { flow.busy = false; }
  }

  async check(principal: SessionPrincipal, id: string): Promise<QrFlowView> {
    const flow = this.#current(principal, id);
    if (flow.status === "completed") throw new BusinessError(409, "QR_FLOW_USED", "扫码流程已完成");
    if (flow.status === "awaitingConfirmation") return this.#view(flow);
    if (flow.busy || !flow.key) throw new BusinessError(409, "QR_FLOW_BUSY", "正在检查扫码状态，请稍候");
    flow.busy = true;
    try {
      const result = await this.#call({ operation: "qrCheck", key: flow.key }, flow);
      this.#assertCurrent(flow);
      if (result.status === "expired") {
        this.#discardFlow(principal.userId);
        throw new BusinessError(409, "QR_FLOW_EXPIRED", "二维码已过期，请重新开始扫码");
      }
      if (result.status !== "authorized") {
        flow.status = result.status;
        return this.#view(flow);
      }
      const identity = await this.#call({ operation: "identity", cookie: result.cookie }, flow);
      this.#assertCurrent(flow);
      const current = this.#authorization(principal.userId);
      if (current && current.accountId !== identity.accountId) {
        this.#discardFlow(principal.userId);
        throw new BusinessError(409, "ACCOUNT_MISMATCH", "扫码账号与当前绑定不一致，原绑定已保留");
      }
      flow.cookie = result.cookie;
      flow.identity = { accountId: identity.accountId, nickname: identity.name };
      flow.status = "awaitingConfirmation";
      flow.qrImage = null;
      delete flow.key;
      return this.#view(flow);
    } finally { flow.busy = false; }
  }

  async confirm(principal: SessionPrincipal, id: string, key: string): Promise<NeteaseBindingView> {
    const flow = this.#current(principal, id);
    validateCommandKey(key, this.now());
    this.#acceptCommand(principal, key, "confirm", id);
    if (flow.status === "completed") {
      if (flow.confirmationKey === key) return this.readBinding(principal);
      throw new BusinessError(409, "QR_FLOW_USED", "扫码流程已完成，不能重复使用");
    }
    if (flow.busy) throw new BusinessError(409, "QR_FLOW_BUSY", "正在确认授权，请稍候");
    if (flow.status !== "awaitingConfirmation" || !flow.cookie || !flow.identity) throw new BusinessError(409, "QR_NOT_CONFIRMED", "请先扫码并检查真实账号身份");
    flow.busy = true;
    try {
      const identity = await this.#call({ operation: "identity", cookie: flow.cookie, expectedAccountId: flow.identity.accountId }, flow);
      this.#assertCurrent(flow);
      if (identity.accountId !== flow.identity.accountId) throw new BusinessError(409, "ACCOUNT_MISMATCH", "真实网易云账号已变化，请重新扫码");
      this.database.transaction(tx => {
        this.#assertCurrent(flow);
        const existing = this.#authorization(principal.userId);
        if (existing) throw new BusinessError(409, "NETEASE_ALREADY_BOUND", "已绑定网易云账号，当前扫码流程不能更新授权");
        const authorizationId = v7();
        const credentials = this.vault.encrypt(flow.cookie!, { authorizationId, accountId: identity.accountId, generation: 1 });
        const inserted = tx.insert(neteaseAuthorization).values({ id: authorizationId, userId: principal.userId, accountId: identity.accountId, nickname: identity.name, generation: 1, status: "active", credentials }).onConflictDoNothing().returning({ id: neteaseAuthorization.id }).get();
        if (!inserted) throw new BusinessError(409, "NETEASE_ACCOUNT_OWNED", "此网易云账号已绑定其他点歌台账号");
      });
      flow.status = "completed";
      flow.confirmationKey = key;
      delete flow.cookie;
      flow.qrImage = null;
      return this.readBinding(principal);
    } finally { flow.busy = false; }
  }

  clear(): void {
    this.#stopped = true;
    for (const userId of this.#flows.keys()) this.#discardFlow(userId);
  }
}

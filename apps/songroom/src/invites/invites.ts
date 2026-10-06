import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import type { AppDatabase } from "../db/database.js";
import { joinApplication, retiredRoomInvite, room, roomInvite, roomMembership } from "../db/schema.js";
import {
  inviteCode, inviteResetCommand, joinApplicationCommand, withdrawApplicationCommand, applicationDecisionCommand, type approvalDisabledReason,
  type InviteResetCommand, type InviteView, type JoinApplicationCommand, type JoinApplicationView, type roomApplicationsView
} from "../shared/invite-contracts.js";
import { BusinessError } from "../shared/errors.js";
import type { z } from "zod";

function inviteDigest(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function applicationView(application: Omit<JoinApplicationView, "allowedActions" | "disabledReasons">): JoinApplicationView {
  return { ...application, allowedActions: application.status === "pending" ? ["withdrawApplication"] : [],
    disabledReasons: application.status === "pending" ? {} : { withdrawApplication: "APPLICATION_NOT_PENDING" } };
}

export class Invites {
  constructor(readonly database: AppDatabase, readonly now = () => Date.now()) {}

  #pendingCount(roomId: string): number {
    return this.database.select({ value: count() }).from(joinApplication)
      .where(and(eq(joinApplication.roomId, roomId), eq(joinApplication.status, "pending"))).get()!.value;
  }

  #isMember(userId: string, roomId: string): boolean {
    return !!this.database.select({ id: roomMembership.id }).from(roomMembership)
      .where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
  }

  #ownerInvite(userId: string, roomId: string) {
    const current = this.database.select({ code: roomInvite.code, generation: roomInvite.generation, version: room.version })
      .from(roomInvite).innerJoin(room, eq(room.id, roomInvite.roomId))
      .where(and(eq(room.id, roomId), eq(room.ownerUserId, userId))).get();
    if (!current || !this.#isMember(userId, roomId)) {
      throw new BusinessError(404, "INVITE_FORBIDDEN", "只有当前房主可查看或重置邀请");
    }
    return current;
  }

  #resolveInvite(code: string) {
    const current = this.database.select({ roomId: room.id, name: room.name, generation: roomInvite.generation })
      .from(roomInvite).innerJoin(room, eq(room.id, roomInvite.roomId)).where(eq(roomInvite.code, code)).get();
    if (current) return current;
    if (this.database.select({ digest: retiredRoomInvite.digest }).from(retiredRoomInvite)
      .where(eq(retiredRoomInvite.digest, inviteDigest(code))).get()) {
      throw new BusinessError(409, "INVITE_RESET", "邀请已重置，请向房主索取当前邀请码");
    }
    throw new BusinessError(404, "INVITE_INVALID", "邀请码无效");
  }

  #applicationRows(userId: string, applicationId?: string) {
    return this.database.select({ version: room.version, id: joinApplication.id, room: { id: room.id, name: room.name },
      nickname: joinApplication.nickname, status: joinApplication.status })
      .from(joinApplication).innerJoin(room, eq(room.id, joinApplication.roomId))
      .where(and(eq(joinApplication.userId, userId), applicationId ? eq(joinApplication.id, applicationId) : eq(joinApplication.status, "pending")))
      .orderBy(asc(joinApplication.id));
  }

  #readInvite(userId: string, roomId: string): InviteView {
    return { ...this.#ownerInvite(userId, roomId), pendingCount: this.#pendingCount(roomId), allowedActions: ["copyInvite", "resetInvite"], disabledReasons: {} };
  }

  readInvite(userId: string, roomId: string): InviteView {
    return this.database.transaction(() => this.#readInvite(userId, roomId), { behavior: "immediate" });
  }

  reset(userId: string, roomId: string, input: InviteResetCommand): InviteView {
    const command = inviteResetCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "resetInvite", { roomId, version: command.version }, this.now());
    return this.database.transaction(tx => {
      const current = this.#ownerInvite(userId, roomId);
      // 重放只读取当前邀请，不再旋转邀请码；仍重新核验房主权限。
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) return this.#readInvite(userId, replay);
      if (command.version !== current.version) {
        throw new BusinessError(409, "INVITE_VERSION_CONFLICT", "房间或待处理申请已变化，请重新读取邀请并确认影响数量");
      }
      tx.insert(retiredRoomInvite).values({ roomId, digest: inviteDigest(current.code) }).run();
      let code: string;
      do {
        // 十个 base64url 字符各有六位随机熵，且不重新使用任何仍可识别的旧码。
        code = randomBytes(8).toString("base64url").slice(0, 10);
      } while (tx.select({ roomId: roomInvite.roomId }).from(roomInvite).where(eq(roomInvite.code, code)).get()
        || tx.select({ digest: retiredRoomInvite.digest }).from(retiredRoomInvite).where(eq(retiredRoomInvite.digest, inviteDigest(code))).get());
      tx.update(roomInvite).set({ code, generation: current.generation + 1 }).where(eq(roomInvite.roomId, roomId)).run();
      tx.update(joinApplication).set({ status: "cancelled" }).where(and(eq(joinApplication.roomId, roomId),
        eq(joinApplication.inviteGeneration, current.generation), eq(joinApplication.status, "pending"))).run();
      tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
      recordCommandResource(tx, prepared, roomId, this.now());
      return this.#readInvite(userId, roomId);
    }, { behavior: "immediate" });
  }

  #assertOwner(userId: string, roomId: string) {
    const owner = this.database.select({ ownerUserId: room.ownerUserId }).from(room).where(eq(room.id, roomId)).get();
    if (!owner || owner.ownerUserId !== userId || !this.#isMember(userId, roomId)) {
      throw new BusinessError(404, "APPLICATION_FORBIDDEN", "只有当前房主可管理该房间申请");
    }
  }

  #ownerApplication(userId: string, roomId: string, applicationId: string) {
    this.#assertOwner(userId, roomId);
    const application = this.database.select().from(joinApplication)
      .where(and(eq(joinApplication.roomId, roomId), eq(joinApplication.id, applicationId))).get();
    if (!application) throw new BusinessError(404, "APPLICATION_UNAVAILABLE", "该房间没有此申请");
    return application;
  }

  #approvalDisabledReason(application: typeof joinApplication.$inferSelect): z.infer<typeof approvalDisabledReason> | null {
    const invitation = this.database.select().from(roomInvite).where(eq(roomInvite.roomId, application.roomId)).get();
    if (!invitation || invitation.generation !== application.inviteGeneration) return "INVITE_RESET";
    if (this.#isMember(application.userId, application.roomId)) return "ALREADY_MEMBER";
    if (this.database.select({ id: roomMembership.id }).from(roomMembership).where(and(
      eq(roomMembership.roomId, application.roomId), eq(roomMembership.nickname, application.nickname))).get()) return "NICKNAME_TAKEN";
    if (this.database.select({ value: count() }).from(roomMembership).where(eq(roomMembership.roomId, application.roomId)).get()!.value >= 10) return "ROOM_MEMBER_LIMIT";
    if (this.database.select({ value: count() }).from(roomMembership).where(eq(roomMembership.userId, application.userId)).get()!.value >= 10) return "JOINED_ROOM_LIMIT";
    return null;
  }

  readPending(userId: string, roomId: string): z.infer<typeof roomApplicationsView> {
    return this.database.transaction(() => {
      this.#assertOwner(userId, roomId);
      const applications = this.database.select().from(joinApplication)
        .where(and(eq(joinApplication.roomId, roomId), eq(joinApplication.status, "pending"))).orderBy(asc(joinApplication.id)).all();
      const version = this.database.select({ value: room.version }).from(room).where(eq(room.id, roomId)).get()!.value;
      return { version, applications: applications.map((application): z.infer<typeof roomApplicationsView>["applications"][number] => {
        const reason = this.#approvalDisabledReason(application);
        return { id: application.id, nickname: application.nickname,
          allowedActions: reason ? ["rejectApplication"] : ["approveApplication", "rejectApplication"],
          disabledReasons: reason ? { approveApplication: reason } : {} };
      }), allowedActions: ["reviewApplications"], disabledReasons: {} };
    }, { behavior: "immediate" });
  }

  decide(userId: string, roomId: string, applicationId: string, input: z.infer<typeof applicationDecisionCommand>): JoinApplicationView {
    const command = applicationDecisionCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "decideJoinApplication", { roomId, applicationId, decision: command.decision }, this.now());
    return this.database.transaction(tx => {
      const application = this.#ownerApplication(userId, roomId, applicationId);
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) return this.readApplication(application.userId, replay);
      if (application.status !== "pending") throw new BusinessError(409, "APPLICATION_NOT_PENDING", "申请已处理，请刷新待审批列表");
      let status: typeof joinApplication.$inferSelect.status = command.decision === "reject" && this.#approvalDisabledReason(application) === "NICKNAME_TAKEN"
        ? "nickname_conflict" : "rejected";
      if (command.decision === "approve") {
        const reason = this.#approvalDisabledReason(application);
        if (reason === "NICKNAME_TAKEN") status = "nickname_conflict";
        else {
          if (reason) throw new BusinessError(409, reason, "申请当前不满足加入条件，请刷新待审批列表");
          tx.insert(roomMembership).values({ id: v7(), roomId, userId: application.userId, nickname: application.nickname }).run();
          status = "approved";
        }
      }
      tx.update(joinApplication).set({ status }).where(eq(joinApplication.id, applicationId)).run();
      tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
      recordCommandResource(tx, prepared, applicationId, this.now());
      return this.readApplication(application.userId, applicationId);
    }, { behavior: "immediate" });
  }

  inspect(userId: string, input: string) {
    const code = inviteCode.parse(input);
    return this.database.transaction(() => {
      const current = this.#resolveInvite(code);
      const pending = this.database.select({ id: joinApplication.id }).from(joinApplication)
        .where(and(eq(joinApplication.roomId, current.roomId), eq(joinApplication.userId, userId), eq(joinApplication.status, "pending"))).get();
      return { room: { id: current.roomId, name: current.name },
        application: pending ? this.readApplication(userId, pending.id) : null, isMember: this.#isMember(userId, current.roomId) };
    }, { behavior: "immediate" });
  }

  submit(userId: string, input: JoinApplicationCommand): JoinApplicationView {
    const command = joinApplicationCommand.parse(input);
    const { idempotencyKey, ...content } = command;
    // 摘要包含邀请码，但回执只持久保存摘要与资源 ID，绝不保存明文命令。
    const prepared = prepareCommand(userId, idempotencyKey, "submitJoinApplication", content, this.now());
    return this.database.transaction(tx => {
      const current = this.#resolveInvite(command.code);
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) return this.readApplication(userId, replay);
      if (this.#isMember(userId, current.roomId)) {
        throw new BusinessError(409, "ALREADY_MEMBER", "你已是该房间的成员");
      }
      if (tx.select({ id: joinApplication.id }).from(joinApplication).where(and(eq(joinApplication.roomId, current.roomId),
        eq(joinApplication.userId, userId), eq(joinApplication.status, "pending"))).get()) {
        throw new BusinessError(409, "APPLICATION_PENDING", "你已有该房间的待处理申请");
      }
      const accountCount = tx.select({ value: count() }).from(joinApplication)
        .where(and(eq(joinApplication.userId, userId), eq(joinApplication.status, "pending"))).get()!.value;
      if (accountCount >= 3) throw new BusinessError(409, "ACCOUNT_APPLICATION_LIMIT", "每个账号最多有 3 份待处理申请");
      if (this.#pendingCount(current.roomId) >= 10) throw new BusinessError(409, "ROOM_APPLICATION_LIMIT", "该房间已有 10 份待处理申请");
      const applicationId = v7();
      tx.insert(joinApplication).values({ id: applicationId, roomId: current.roomId, userId,
        nickname: command.nickname, inviteGeneration: current.generation }).run();
      tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, current.roomId)).run();
      recordCommandResource(tx, prepared, applicationId, this.now());
      return this.readApplication(userId, applicationId);
    }, { behavior: "immediate" });
  }

  readList(userId: string): { applications: JoinApplicationView[] } {
    return { applications: this.#applicationRows(userId).all().map(applicationView) };
  }

  readApplication(userId: string, applicationId: string): JoinApplicationView {
    const application = this.#applicationRows(userId, applicationId).get();
    if (!application) throw new BusinessError(404, "APPLICATION_UNAVAILABLE", "申请不存在或不属于当前账号");
    return applicationView(application);
  }

  withdraw(userId: string, applicationId: string, input: { idempotencyKey: string }): JoinApplicationView {
    const command = withdrawApplicationCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "withdrawJoinApplication", { applicationId }, this.now());
    return this.database.transaction(tx => {
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) return this.readApplication(userId, replay);
      const application = this.readApplication(userId, applicationId);
      // 已撤回或被邀请重置取消的终态保持原状态，不再递增版本。
      if (application.status === "pending") {
        tx.update(joinApplication).set({ status: "withdrawn" }).where(and(eq(joinApplication.id, applicationId),
          eq(joinApplication.userId, userId), eq(joinApplication.status, "pending"))).run();
        tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, application.room.id)).run();
      }
      recordCommandResource(tx, prepared, applicationId, this.now());
      return this.readApplication(userId, applicationId);
    }, { behavior: "immediate" });
  }
}

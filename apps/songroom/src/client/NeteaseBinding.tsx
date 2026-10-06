import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import type { z } from "zod";
import { neteaseBindingView, qrFlowView, type QrFlowView } from "../shared/netease-contracts";

const errorMessages: Record<string, string> = {
  SESSION_REQUIRED: "点歌台会话已失效，请重新登录。",
  QR_FLOW_EXPIRED: "二维码已过期，请重新开始扫码。",
  QR_FLOW_UNAVAILABLE: "此扫码流程已失效，请在发起扫码的会话中重新开始。",
  QR_FLOW_USED: "此扫码流程已完成，请重新读取绑定状态。",
  QR_FLOW_BUSY: "扫码状态正在检查或确认，请稍后再试。",
  QR_NOT_CONFIRMED: "请先在网易云中确认授权，再检查扫码状态。",
  AUTHORIZATION_CHANGED: "网易云绑定状态已变化，请重新读取绑定状态。",
  IDEMPOTENCY_KEY_EXPIRED: "操作标识已过期，请重新提交。",
  IDEMPOTENCY_CONFLICT: "操作标识已用于其他会话，请重新开始扫码。",
  NETEASE_ACCOUNT_OWNED: "此网易云账号已绑定其他点歌台账号。",
  NETEASE_ALREADY_BOUND: "已绑定网易云账号，请重新读取绑定状态。",
  ACCOUNT_EMPTY: "暂时无法核实网易云账号身份，请重新扫码。",
  ACCOUNT_MISMATCH: "扫码账号身份不一致，原绑定已保留，请重新扫码。",
  AUTH_UNAVAILABLE: "网易云授权不可用，请重新开始扫码。",
  TARGET_PERMISSION: "网易云未允许此次操作，请检查账号授权。",
  RATE_LIMITED: "网易云请求受到限制，请稍后再试。",
  NETWORK_ERROR: "暂时无法连接网易云，请稍后再试。",
  MODULE_ERROR: "网易云暂时无法完成请求，请稍后再试。",
  DEADLINE: "网易云请求超时，请稍后再试。",
  PROCESS_ERROR: "授权服务暂时不可用，请稍后再试。",
  PARSE_ERROR: "暂时无法确认网易云返回的结果，请稍后再试。",
  INVALID_INPUT: "请求未被接受，请重新开始扫码。",
  INTEGRITY_ERROR: "授权服务暂时不可用，请联系服务器管理员。",
  TOO_MANY_REQUESTS: "请求过于频繁，请稍后再试。"
};

class BindingRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}
function errorMessage(error: unknown): string {
  return error instanceof BindingRequestError && errorMessages[error.code]
    ? errorMessages[error.code]
    : "暂时无法完成请求，请稍后重试。";
}
async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`/api/netease${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const code = typeof payload === "object" && payload !== null && "error" in payload
      && typeof payload.error === "object" && payload.error !== null && "code" in payload.error
      && typeof payload.error.code === "string" ? payload.error.code : "UNKNOWN";
    throw new BindingRequestError(code);
  }
  return schema.parse(payload);
}

export function NeteaseBinding({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const bindingKey = ["netease-binding", sessionId];
  const bindingQuery = useQuery({
    queryKey: bindingKey,
    queryFn: ({ signal }) => request("/binding", neteaseBindingView, signal),
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false
  });
  // QR material belongs only to this mounted session component, never a query or storage.
  const [flow, setFlow] = useState<QrFlowView | null>(null);
  const [pending, setPending] = useState<"start" | "check" | "confirm" | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const startKey = useRef<string | null>(null);
  const confirmKey = useRef<string | null>(null);
  useEffect(() => () => {
    generation.current += 1;
    controller.current?.abort();
  }, []);

  async function act(action: "start" | "check" | "confirm") {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current;
    const stillCurrent = () => current === generation.current && !abort.signal.aborted;
    setPending(action);
    setMessage("");
    if (action === "start") setFlow(null);
    try {
      if (action === "confirm" && flow) {
        confirmKey.current ??= uuidv7();
        const binding = await request(`/qr-flows/${flow.id}/confirm`, neteaseBindingView, abort.signal, { idempotencyKey: confirmKey.current });
        if (!stillCurrent()) return;
        // Cancel a concurrent binding read so it cannot replace this confirmed result.
        await queryClient.cancelQueries({ queryKey: bindingKey });
        if (!stillCurrent()) return;
        queryClient.setQueryData(bindingKey, binding);
        setFlow(null);
        confirmKey.current = null;
      } else {
        if (action === "start") startKey.current ??= uuidv7();
        const nextFlow = action === "start"
          ? await request("/qr-flows", qrFlowView, abort.signal, { idempotencyKey: startKey.current })
          : await request(`/qr-flows/${flow!.id}/check`, qrFlowView, abort.signal, {});
        if (!stillCurrent()) return;
        setFlow(nextFlow);
        if (action === "start") {
          startKey.current = null;
          confirmKey.current = null;
        }
        if (nextFlow.status === "completed") {
          setFlow(null);
          void bindingQuery.refetch();
        }
      }
    } catch (error) {
      if (stillCurrent()) {
        if (error instanceof BindingRequestError) {
          if (action === "start") startKey.current = null;
          if (error.code === "IDEMPOTENCY_KEY_EXPIRED") confirmKey.current = null;
          if ([
            "QR_FLOW_EXPIRED", "QR_FLOW_UNAVAILABLE", "QR_FLOW_USED", "AUTHORIZATION_CHANGED",
            "SESSION_REQUIRED", "ACCOUNT_EMPTY", "ACCOUNT_MISMATCH", "AUTH_UNAVAILABLE", "IDEMPOTENCY_CONFLICT", "NETEASE_ALREADY_BOUND"
          ].includes(error.code)) {
            setFlow(null);
            startKey.current = null;
            confirmKey.current = null;
          }
          if (["QR_FLOW_USED", "AUTHORIZATION_CHANGED", "ACCOUNT_MISMATCH", "NETEASE_ALREADY_BOUND"].includes(error.code)) {
            void bindingQuery.refetch();
          }
        }
        setMessage(errorMessage(error));
      }
    } finally {
      if (stillCurrent()) setPending(null);
    }
  }

  const binding = bindingQuery.data?.binding;
  return (
    <section className="settings-card netease-binding" aria-labelledby="netease-heading">
      <h2 id="netease-heading">网易云账号</h2>
      <p className="field-help">绑定后，你创建的全部房间共用这份网易云授权。</p>
      {bindingQuery.isPending ? <p role="status">正在读取网易云绑定…</p> : bindingQuery.isError ? (
        <>
          <p className="form-message" role="alert">{errorMessage(bindingQuery.error)}</p>
          <button className="secondary-button" type="button" disabled={bindingQuery.isFetching} onClick={() => void bindingQuery.refetch()}>重新读取绑定状态</button>
        </>
      ) : binding ? (
        <>
          <p className="netease-status" role="status">已绑定网易云账号</p>
          <Identity identity={binding.identity} />
        </>
      ) : (
        <>
          <p>尚未绑定网易云账号</p>
          {flow && (
            <div className="netease-flow">
              <p role="status">{flow.status === "awaitingConfirmation" ? "身份已核实，请确认要绑定的账号。" : flow.status === "scanned" ? "已扫码，请在网易云中确认授权，再检查状态。" : "请用网易云音乐 App 扫码并确认授权。"}</p>
              {flow.qrImage && <img className="netease-qr" src={flow.qrImage} alt="网易云授权二维码" />}
              <p className="field-help">二维码有效至 <time dateTime={flow.expiresAt}>{new Date(flow.expiresAt).toLocaleTimeString("zh-CN")}</time>，过期后请重新扫码。</p>
              {flow.identity && <Identity identity={flow.identity} />}
              {flow.allowedActions.includes("check") && (
                <button className="primary-button" type="button" disabled={pending !== null} onClick={() => void act("check")}>{pending === "check" ? "检查中…" : "检查扫码状态"}</button>
              )}
              {flow.identity && flow.allowedActions.includes("confirm") && (
                <button className="primary-button" type="button" disabled={pending !== null} onClick={() => void act("confirm")}>{pending === "confirm" ? "确认中…" : "确认绑定此网易云账号"}</button>
              )}
            </div>
          )}
          {bindingQuery.data?.allowedActions.includes("startQr") && (
            <button className="secondary-button" type="button" disabled={pending === "start" || pending === "confirm"} onClick={() => void act("start")}>
              {pending === "start" ? "正在生成二维码…" : flow ? "重新扫码（替代当前流程）" : "开始扫码绑定"}
            </button>
          )}
        </>
      )}
      {message && <p className="form-message" role="alert">{message}</p>}
    </section>
  );
}

function Identity({ identity }: { identity: NonNullable<QrFlowView["identity"]> }) {
  return <dl className="netease-identity"><div><dt>网易云昵称</dt><dd>{identity.nickname || "未设置昵称"}</dd></div><div><dt>网易云账号 ID</dt><dd>{identity.accountId}</dd></div></dl>;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { v7 as uuidv7 } from "uuid";
import {
  roomCreateCommand,
  roomCreateView,
  roomSummary,
  type RoomCreateCommand
} from "../shared/room-contracts";
import { errorMessage, errorMessages, queryOptions, request, RoomRequestError } from "./room-http";
import { QueryError } from "./RoomQueryError";

export function RoomCreatePage({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["room-create", sessionId],
    queryFn: ({ signal }) => request("/create-view", roomCreateView, signal),
    ...queryOptions
  });
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [confirmedAuthorizationId, setConfirmedAuthorizationId] = useState<string | null>(null);
  const [validation, setValidation] = useState("");
  const [lastCommand, setLastCommand] = useState<RoomCreateCommand | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const mutation = useMutation({
    mutationFn: (command: RoomCreateCommand) => {
      controller.current = new AbortController();
      return request("", roomSummary, controller.current.signal, command);
    },
    retry: false,
    onError: error => {
      if (controller.current?.signal.aborted) return;
      if (
        error instanceof RoomRequestError &&
        ["IDEMPOTENCY_KEY_EXPIRED", "IDEMPOTENCY_CONFLICT"].includes(error.code)
      )
        setLastCommand(null);
      if (
        error instanceof RoomRequestError &&
        ["AUTHORIZATION_CHANGED", "ACCOUNT_MISMATCH", "AUTH_UNAVAILABLE", "NETEASE_AUTH_REQUIRED"].includes(
          error.code
        )
      )
        setConfirmedAuthorizationId(null);
    },
    onSuccess: async room => {
      if (controller.current?.signal.aborted) return;
      await queryClient.invalidateQueries({ queryKey: ["rooms", sessionId] });
      if (!controller.current?.signal.aborted) navigate(`/rooms/${room.id}`);
    }
  });
  const authorization = query.data?.authorization;
  const allowed = !!authorization && query.data?.allowedActions.includes("createRoom");
  const confirmed = !!authorization && confirmedAuthorizationId === authorization.id;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorization || !allowed || !confirmed || mutation.isPending) return;
    const parsed = roomCreateCommand.safeParse({
      idempotencyKey: lastCommand?.idempotencyKey ?? uuidv7(),
      authorizationId: authorization.id,
      name,
      nickname
    });
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]?.message ?? "请检查输入。");
      return;
    }
    const previousMatches =
      lastCommand &&
      lastCommand.name === parsed.data.name &&
      lastCommand.nickname === parsed.data.nickname &&
      lastCommand.authorizationId === parsed.data.authorizationId;
    const command = previousMatches ? lastCommand : { ...parsed.data, idempotencyKey: uuidv7() };
    setValidation("");
    setLastCommand(command);
    mutation.mutate(command);
  }
  function reloadIdentity() {
    setConfirmedAuthorizationId(null);
    mutation.reset();
    void query.refetch();
  }
  return (
    <section className="rooms-page" aria-labelledby="create-room-heading">
      <Link className="back-link" to="/rooms">
        <ArrowLeft size={17} aria-hidden="true" />
        返回房间列表
      </Link>
      <div className="page-heading">
        <h1 id="create-room-heading">创建房间</h1>
        <p>房间创建后你将成为房主。建房不会创建网易云歌单。</p>
      </div>
      {query.isPending ? (
        <p role="status">正在读取网易云身份…</p>
      ) : query.isError ? (
        <QueryError error={query.error} retrying={query.isFetching} retry={reloadIdentity} />
      ) : (
        <form className="settings-card room-create-form" onSubmit={submit}>
          {authorization && (
            <>
              <h2>用于此房间的网易云账号</h2>
              <dl className="netease-identity">
                <div>
                  <dt>网易云昵称</dt>
                  <dd>{authorization.identity.nickname || "未设置昵称"}</dd>
                </div>
                <div>
                  <dt>网易云账号 ID</dt>
                  <dd>{authorization.identity.accountId}</dd>
                </div>
              </dl>
            </>
          )}
          {!allowed && (
            <>
              <p role="status">
                {query.data.disabledReason
                  ? errorMessages[query.data.disabledReason]
                  : "暂时无法创建房间，请稍后重试。"}
              </p>
              <Link className="text-link" to="/account">
                前往账号设置
              </Link>
            </>
          )}
          {allowed && (
            <>
              <label>
                房间名称
                <input
                  value={name}
                  disabled={mutation.isPending}
                  onChange={event => setName(event.target.value)}
                  required
                  autoComplete="off"
                />
                <span className="field-help">1 到 16 个字符，房间名称可以重复。</span>
              </label>
              <label>
                我的房间昵称
                <input
                  value={nickname}
                  disabled={mutation.isPending}
                  onChange={event => setNickname(event.target.value)}
                  required
                  autoComplete="off"
                />
                <span className="field-help">1 到 12 个字符，只用于这个房间。</span>
              </label>
              <label className="identity-confirmation">
                <input
                  type="checkbox"
                  disabled={mutation.isPending}
                  checked={confirmed}
                  onChange={event =>
                    setConfirmedAuthorizationId(event.target.checked ? authorization!.id : null)
                  }
                />
                确认使用此网易云账号创建房间
              </label>
              <button
                className="primary-button"
                type="submit"
                disabled={!confirmed || mutation.isPending || query.isFetching}
              >
                {mutation.isPending ? "创建中…" : "创建并进入房间"}
              </button>
            </>
          )}
          {validation && (
            <p className="form-message" role="alert">
              {validation}
            </p>
          )}
          {mutation.isError && (
            <>
              <p className="form-message" role="alert">
                {errorMessage(mutation.error)}
              </p>
              <button className="secondary-button" type="button" onClick={reloadIdentity}>
                重新读取网易云身份
              </button>
            </>
          )}
        </form>
      )}
    </section>
  );
}

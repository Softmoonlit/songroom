import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, Music2 } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { v7 as uuidv7 } from "uuid";
import { FUTURE_PLATFORMS, getMusicPlatform } from "./music-platforms";
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
  const [selectedAuthorizationId, setSelectedAuthorizationId] = useState<string | null>(null);
  const initialSelectedRef = useRef(false);
  const [validation, setValidation] = useState("");
  const [lastCommand, setLastCommand] = useState<RoomCreateCommand | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const authorization = query.data?.authorization;
  const allowed = !!authorization && query.data?.allowedActions.includes("createRoom");

  // 当存在有效授权且具备建房权限时，初始默认选中该账号作为播放源
  useEffect(() => {
    if (authorization && allowed && !initialSelectedRef.current) {
      initialSelectedRef.current = true;
      setSelectedAuthorizationId(authorization.id);
    }
  }, [authorization, allowed]);

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
        setSelectedAuthorizationId(null);
    },
    onSuccess: async room => {
      if (controller.current?.signal.aborted) return;
      await queryClient.invalidateQueries({ queryKey: ["rooms", sessionId] });
      if (!controller.current?.signal.aborted) navigate(`/rooms/${room.id}`);
    }
  });

  const neteasePlatform = getMusicPlatform("netease");
  const confirmed = !!authorization && selectedAuthorizationId === authorization.id;
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
    initialSelectedRef.current = false;
    setSelectedAuthorizationId(null);
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
      </div>
      {query.isPending ? (
        <p role="status">正在读取网易云身份…</p>
      ) : query.isError ? (
        <QueryError error={query.error} retrying={query.isFetching} retry={reloadIdentity} />
      ) : (
        <form className="settings-card room-create-form" onSubmit={submit}>
          <div className="source-account-selection-section">
            <h2>选择房间播放源账号</h2>
            {!allowed ? (
              <div className="playback-source-unbound">
                <p role="status">
                  {query.data.disabledReason
                    ? errorMessages[query.data.disabledReason]
                    : "暂时无法创建房间，请稍后重试。"}
                </p>
                <Link className="text-link" to="/account">
                  前往账号设置
                </Link>
              </div>
            ) : (
              <div className="playback-source-list" role="radiogroup" aria-label="选择房间播放源账号">
                <label
                  className={`playback-source-card selectable ${confirmed ? "selected" : ""}`}
                  htmlFor="playback-source-netease"
                >
                  <div className="playback-source-radio-col">
                    <input
                      id="playback-source-netease"
                      type="radio"
                      name="playbackSource"
                      value={authorization.id}
                      checked={confirmed}
                      disabled={mutation.isPending}
                      onChange={() => setSelectedAuthorizationId(authorization.id)}
                      aria-label={`${neteasePlatform.name} - ${authorization.identity.nickname || "未设置昵称"}`}
                    />
                  </div>
                  <div className="playback-source-content">
                    <div className="playback-source-header">
                      <div className="playback-source-title">
                        <span className="platform-icon" aria-hidden="true">
                          <Music2 size={16} />
                        </span>
                        <strong>{neteasePlatform.name}</strong>
                      </div>
                      <span className="platform-badge active">已授权</span>
                    </div>
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
                  </div>
                </label>

                {/* 预留未来平台单选卡片扩展位 */}
                {FUTURE_PLATFORMS.slice(0, 1).map(platform => (
                  <div key={platform.id} className="playback-source-card placeholder" aria-disabled="true">
                    <div className="playback-source-radio-col">
                      <input
                        type="radio"
                        disabled
                        aria-disabled="true"
                        name="playbackSource"
                        aria-label={`${platform.name}（即将支持）`}
                      />
                    </div>
                    <div className="playback-source-content">
                      <div className="playback-source-header">
                        <div className="playback-source-title">
                          <span className="platform-icon placeholder" aria-hidden="true">
                            <Music2 size={16} />
                          </span>
                          <strong>{platform.name}</strong>
                        </div>
                        <span className="platform-badge coming-soon">{platform.statusText}</span>
                      </div>
                      <p className="platform-placeholder-hint">暂未开放此平台授权</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {allowed && (
            <>
              <div className="room-create-fields">
                <label>
                  房间名称
                  <input
                    value={name}
                    disabled={mutation.isPending}
                    placeholder="输入房间名称（1 到 16 个字符）"
                    onChange={event => setName(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
                <label>
                  我的房间昵称
                  <input
                    value={nickname}
                    disabled={mutation.isPending}
                    placeholder="输入你在房间内的昵称（1 到 12 个字符）"
                    onChange={event => setNickname(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
              </div>
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

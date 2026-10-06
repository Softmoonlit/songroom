import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Music2 } from "lucide-react";
import { v7 as uuidv7 } from "uuid";
import { publicPlaylistView, type PublicPlaylistCreateCommand, type PublicPlaylistView } from "../shared/public-playlist-contracts";
import { errorMessage, queryOptions, request, RoomRequestError } from "./room-http";
import { QueryError } from "./RoomQueryError";

const operationMessages: Record<NonNullable<PublicPlaylistView["operation"]>["status"], string> = {
  queued: "已排队，等待创建公共歌单。",
  processing: "正在创建公共歌单。",
  awaitingConfirmation: "创建结果待确认，可能已在网易云创建。请勿重试创建。",
  waitingAuthorization: "正在等待房主恢复网易云授权。",
  needsAdministrator: "创建结果需要管理员处理，请联系管理员，不能重试创建。",
  succeeded: "公共歌单已创建并绑定。",
  failed: "创建明确失败，请查看当前可用操作。",
  stopped: "创建操作已停止。"
};
const disabledMessages = {
  OWNER_ONLY: "只有房主可以创建公共歌单。",
  NETEASE_AUTH_REQUIRED: "请房主先在账号设置中绑定有效的网易云账号。",
  PUBLIC_PLAYLIST_EXISTS: "此房间已经绑定公共歌单。",
  OPERATION_PENDING: "已有未完成的创建操作，不能再次创建。"
};

export function PublicPlaylistPane({ sessionId, roomId, active }: { sessionId: string; roomId: string; active: boolean }) {
  const client = useQueryClient();
  const queryKey = ["room-public-playlist", sessionId, roomId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => request(`/${roomId}/public-playlist`, publicPlaylistView, signal), enabled: active, ...queryOptions });
  const [command, setCommand] = useState<PublicPlaylistCreateCommand | null>(null);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const mutation = useMutation({
    mutationFn: async (body: PublicPlaylistCreateCommand) => {
      controller.current = new AbortController();
      await client.cancelQueries({ queryKey });
      return request(`/${roomId}/public-playlist`, publicPlaylistView, controller.current.signal, body);
    },
    retry: false,
    onSuccess: view => {
      if (controller.current?.signal.aborted) return;
      client.setQueryData(queryKey, view);
      setCommand(null);
      setMessage("");
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      setMessage(errorMessage(failure));
      if (failure instanceof RoomRequestError) {
        // 过期键已被服务端拒绝；其他失败保留原键，避免响应丢失后产生新的创建意图。
        if (failure.code === "IDEMPOTENCY_KEY_EXPIRED") setCommand(null);
        void client.invalidateQueries({ queryKey });
      }
    }
  });
  if (query.isPending) return <><h2>公共歌单</h2><p role="status">正在读取公共歌单状态…</p></>;
  if (query.isError) return <><h2>公共歌单</h2><QueryError error={query.error} retrying={query.isFetching} retry={() => void query.refetch()} /></>;
  const view = query.data;
  return <>
    <h2>公共歌单</h2>
    <div className="empty-card">
      <Music2 size={27} aria-hidden="true" />
      {view.playlist ? <>
        <h3>{view.playlist.name}</h3>
        <dl className="netease-identity"><div><dt>网易云歌单 ID</dt><dd>{view.playlist.id}</dd></div></dl>
      </> : <>
        <h3>尚未创建公共歌单</h3>
        <p>创建房间不会自动创建公共歌单。由房主按需创建此房间专用的公共歌单，名称为 songroom-房间名-公共。</p>
      </>}
      {view.operation && <p className="netease-status" role="status">{operationMessages[view.operation.status]}</p>}
      {view.disabledReason && <p className="field-help">{disabledMessages[view.disabledReason]}</p>}
      {view.allowedActions.includes("createPublicPlaylist") && <button className="primary-button" type="button" disabled={mutation.isPending || query.isFetching || view.disabledReason !== null} onClick={() => {
        if (mutation.isPending || view.disabledReason) return;
        const next = command ?? { idempotencyKey: uuidv7() };
        setCommand(next);
        setMessage("");
        mutation.mutate(next);
      }}>{mutation.isPending ? "正在提交创建…" : "创建公共歌单"}</button>}
      <button className="secondary-button" type="button" disabled={query.isFetching || mutation.isPending} onClick={() => void query.refetch()}>{query.isFetching ? "正在更新状态…" : "更新状态"}</button>
      {message && <p className="form-message" role="alert">{message}</p>}
    </div>
  </>;
}

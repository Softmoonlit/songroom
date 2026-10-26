import type { OperationData } from "../netease/protocol.js";

/** 私密属性不影响房主主动分配；云端状态和归属仍须有效。 */
export function isPersonalPlaylistSource(
  playlist: Pick<OperationData<"playlistDetail">["playlist"], "creatorId" | "subscribed" | "status">,
  accountId: string
): boolean {
  return playlist.status === 0 && (playlist.creatorId === accountId || playlist.subscribed);
}

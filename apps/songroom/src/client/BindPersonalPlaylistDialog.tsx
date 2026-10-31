import { useEffect, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Disc3, Music, X } from "lucide-react";
import {
  favoritePlaylistCandidatesView,
  personalPlaylistView,
  type FavoritePlaylistCandidate
} from "../shared/personal-playlist-contracts.js";
import { errorMessage, queryOptions, request } from "./room-http.js";

export interface BindPersonalPlaylistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  roomId: string;
  hasPersonalPlaylist: boolean;
  onSuccess?: () => void;
}

export function BindPersonalPlaylistDialog({
  open,
  onOpenChange,
  sessionId,
  roomId,
  hasPersonalPlaylist,
  onSuccess
}: BindPersonalPlaylistDialogProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");

  const candidatesQuery = useQuery({
    queryKey: ["personal-playlist-candidates", sessionId, roomId],
    queryFn: ({ signal }) =>
      request(`/${roomId}/personal-playlist/candidates`, favoritePlaylistCandidatesView, signal),
    enabled: open,
    ...queryOptions
  });

  useEffect(() => {
    if (open) {
      setSelectedId(null);
      setSubmitError("");
    }
  }, [open]);

  const bindMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) {
        throw new Error("请先选择要绑定的歌单");
      }
      return request(
        `/${roomId}/personal-playlist/bind`,
        personalPlaylistView,
        undefined,
        { playlistId: selectedId }
      );
    },
    retry: false,
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-members", sessionId, roomId] });
      void queryClient.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
      onSuccess?.();
    },
    onError: failure => {
      setSubmitError(errorMessage(failure));
    }
  });

  const title = hasPersonalPlaylist ? "更换个人歌单" : "绑定个人歌单";
  const confirmText = hasPersonalPlaylist ? "确认更换" : "确认绑定";
  const pendingText = hasPersonalPlaylist ? "正在更换…" : "正在绑定…";

  const candidates = candidatesQuery.data?.candidates ?? [];
  const candidateGroups = [
    { sourceType: "liked", title: "我喜欢的音乐" },
    { sourceType: "created", title: "自建歌单" },
    { sourceType: "favorite", title: "收藏歌单" }
  ].map(group => ({
    ...group,
    playlists: candidates.filter(playlist => playlist.sourceType === group.sourceType)
  })).filter(group => group.playlists.length > 0);

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content
          className="destructive-dialog candidate-playlist-dialog"
          onEscapeKeyDown={event => {
            if (bindMutation.isPending) event.preventDefault();
          }}
        >
          <div className="destructive-dialog-header">
            <AlertDialog.Title className="destructive-dialog-title">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="dialog-close-btn"
                aria-label="关闭"
                disabled={bindMutation.isPending}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </AlertDialog.Cancel>
          </div>

          <AlertDialog.Description className="destructive-dialog-desc">
            从你当前已授权网易云账号的收藏歌单、自建歌单（含私密）或“我喜欢的音乐”中选择一个作为当前房间的只读点歌来源。
          </AlertDialog.Description>

          <div className="candidate-playlists-body">
            {candidatesQuery.isPending && (
              <p className="loading-hint" role="status">正在拉取歌单候选…</p>
            )}

            {candidatesQuery.isError && (
              <div className="candidate-error-box" role="alert">
                <p>{errorMessage(candidatesQuery.error)}</p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void candidatesQuery.refetch()}
                >
                  重新拉取
                </button>
              </div>
            )}

            {candidatesQuery.isSuccess && candidates.length === 0 && (
              <div className="candidate-empty-box">
                <Disc3 size={36} className="empty-icon" aria-hidden="true" />
                <p className="empty-title">暂无可用的歌单</p>
                <p className="empty-hint">
                  未找到可读取的自建歌单、收藏歌单或“我喜欢的音乐”。请在网易云音乐客户端中确认歌单后重新加载。
                </p>
              </div>
            )}

            {candidatesQuery.isSuccess && candidates.length > 0 && (
              <div className="candidate-playlists-groups" role="radiogroup" aria-label="歌单列表">
                {candidateGroups.map(group => (
                  <section
                    key={group.sourceType}
                    role="group"
                    aria-labelledby={`candidate-group-${group.sourceType}`}
                  >
                    <h3 className="candidate-playlist-group-title" id={`candidate-group-${group.sourceType}`}>
                      {group.title}
                      <span className="candidate-playlist-group-count">{group.playlists.length}</span>
                    </h3>
                    <ul className="candidate-playlists-list" role="presentation">
                      {group.playlists.map((playlist: FavoritePlaylistCandidate) => {
                        const isSelected = selectedId === playlist.id;
                        return (
                          <li key={playlist.id} role="none">
                            <button
                              type="button"
                              role="radio"
                              aria-checked={isSelected}
                              className={`candidate-playlist-card ${isSelected ? "selected" : ""}`}
                              onClick={() => setSelectedId(playlist.id)}
                            >
                              <div className="candidate-playlist-cover">
                                {playlist.coverImgUrl ? (
                                  <img
                                    src={playlist.coverImgUrl}
                                    alt={playlist.name}
                                    loading="lazy"
                                    onError={e => {
                                      (e.currentTarget as HTMLElement).style.display = "none";
                                    }}
                                  />
                                ) : (
                                  <div className="cover-fallback" aria-hidden="true">
                                    <Music size={20} />
                                  </div>
                                )}
                              </div>
                              <div className="candidate-playlist-info">
                                <span className="candidate-playlist-name">{playlist.name}</span>
                                <span className="candidate-playlist-meta">
                                  {playlist.trackCount} 首歌曲
                                  {playlist.creatorNickname ? ` · by ${playlist.creatorNickname}` : ""}
                                </span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>

          {submitError && (
            <div className="error-banner" role="alert">
              {submitError}
            </div>
          )}

          <div className="destructive-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="secondary-button"
                disabled={bindMutation.isPending}
              >
                取消
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className="primary-button"
              disabled={!selectedId || bindMutation.isPending || candidates.length === 0}
              onClick={() => bindMutation.mutate()}
            >
              {bindMutation.isPending ? pendingText : confirmText}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

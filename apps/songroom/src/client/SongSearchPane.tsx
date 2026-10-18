import { useState, useRef, useEffect, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X, Plus, RotateCw, AlertCircle, Music, Clock } from "lucide-react";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import {
  searchInitiatedResponse,
  searchView,
  type SongCandidate
} from "../shared/song-search-contracts.js";
import {
  personalPlaylistView,
  personalSongAddResponse,
  personalSongOperationView,
  type PersonalSongOperationView
} from "../shared/personal-playlist-contracts.js";
import { queryOptions, request, RoomRequestError } from "./room-http.js";
import { Toast, type ToastData } from "./Toast.js";
import {
  getFriendlyPersonalSongAdditionErrorMessage,
  getFriendlyPersonalSongAdditionStatusMessage,
  getFriendlySearchErrorMessage
} from "./song-search-messages.js";

export interface SongSearchPaneProps {
  sessionId: string;
  roomId: string;
  active: boolean;
  onNavigateToPersonal: () => void;
}

const IN_FLIGHT_STATUSES: ReadonlySet<PersonalSongOperationView["status"]> = new Set([
  "queued",
  "processing",
  "awaitingConfirmation",
  "waitingAuthorization",
  "needsAdministrator"
]);

export function SongSearchPane({
  sessionId,
  roomId,
  active,
  onNavigateToPersonal
}: SongSearchPaneProps) {
  const [searchQueryText, setSearchQueryText] = useState("");
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [searchLocalError, setSearchLocalError] = useState("");
  const [addingSongId, setAddingSongId] = useState<string | null>(null);
  const [additionError, setAdditionError] = useState("");
  const [toast, setToast] = useState<ToastData | null>(null);

  const additionStorageKey = `songroom:personal-song-addition:${roomId}`;

  // 初始化尝试从 sessionStorage 恢复当前房间未完成操作
  const [activeOperationId, setActiveOperationId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(`songroom:personal-song-addition:${roomId}`) || null;
    } catch {
      return null;
    }
  });

  const setPersistedOperationId = (opId: string | null) => {
    setActiveOperationId(opId);
    try {
      if (opId) sessionStorage.setItem(additionStorageKey, opId);
      else sessionStorage.removeItem(additionStorageKey);
    } catch {
      // 忽略存储异常
    }
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchGeneration = useRef(0);
  const currentRoomId = useRef(roomId);
  currentRoomId.current = roomId;
  const queryClient = useQueryClient();

  // 房间切换时重置搜索现场，并从对应房间的存储中恢复未完成操作
  useEffect(() => {
    searchGeneration.current += 1;
    setActiveSearchId(null);
    setSearchQueryText("");
    setSearchLocalError("");
    setAddingSongId(null);
    setAdditionError("");
    setToast(null);
    try {
      setActiveOperationId(sessionStorage.getItem(`songroom:personal-song-addition:${roomId}`) || null);
    } catch {
      setActiveOperationId(null);
    }
  }, [roomId]);

  // 读取个人歌单配置状态与快照
  const personalQuery = useQuery({
    queryKey: ["room-personal-playlist", sessionId, roomId],
    queryFn: ({ signal }) => request(`/${roomId}/personal-playlist`, personalPlaylistView, signal),
    enabled: active,
    ...queryOptions
  });

  const hasPersonalPlaylist = Boolean(personalQuery.data?.playlist);
  const personalTracks = personalQuery.data?.snapshot?.tracks ?? [];
  const personalSongIds = new Set(personalTracks.map(t => t.songId));

  // 搜索查询
  const searchQuery = useQuery({
    queryKey: ["song-search", activeSearchId],
    queryFn: ({ signal }) => request(`/${roomId}/search/${activeSearchId}`, searchView, signal),
    enabled: Boolean(activeSearchId && active),
    refetchInterval: q => (q.state.data?.status === "searching" ? 2500 : false),
    ...queryOptions
  });

  // 监听异步添加个人歌单操作
  const additionOperationQuery = useQuery({
    queryKey: ["personal-song-addition-operation", activeOperationId],
    queryFn: ({ signal }) =>
      request(`/${roomId}/personal-playlist/songs/${activeOperationId}`, personalSongOperationView, signal),
    enabled: Boolean(activeOperationId && active),
    refetchInterval: q =>
      q.state.data?.status && IN_FLIGHT_STATUSES.has(q.state.data.status)
        ? 2500
        : false,
    ...queryOptions
  });

  // 查询失败（如操作不存在）时清空持久化 ID
  useEffect(() => {
    if (additionOperationQuery.error) {
      setPersistedOperationId(null);
    }
  }, [additionOperationQuery.error]);

  // 处理异步添加操作状态变化
  useEffect(() => {
    if (!additionOperationQuery.data) return;
    const op = additionOperationQuery.data;
    if (op.status === "succeeded") {
      setPersistedOperationId(null);
      setAddingSongId(null);
      setToast({
        id: uuidv7(),
        message: personalSongIds.has(op.songId)
          ? `《${op.name}》已在个人歌单`
          : `《${op.name}》已加入个人歌单`,
        type: "success"
      });
      void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, roomId] });
    } else if (op.status === "failed" || op.status === "stopped") {
      setPersistedOperationId(null);
      setAddingSongId(null);
      setAdditionError(getFriendlyPersonalSongAdditionErrorMessage(op.errorCode));
    }
  }, [additionOperationQuery.data, queryClient, sessionId, roomId]);

  // 发起搜索
  const searchMutation = useMutation({
    mutationFn: ({ queryText, targetRoomId }: { queryText: string; targetRoomId: string; generation: number }) =>
      request(`/${targetRoomId}/search`, searchInitiatedResponse, undefined, { query: queryText }),
    onSuccess: (data, variables) => {
      if (variables.generation !== searchGeneration.current || variables.targetRoomId !== currentRoomId.current) return;
      setActiveSearchId(data.searchId);
    },
    onError: (failure, variables) => {
      if (variables.generation !== searchGeneration.current || variables.targetRoomId !== currentRoomId.current) return;
      const code = failure instanceof RoomRequestError ? failure.code : null;
      setSearchLocalError(getFriendlySearchErrorMessage(code));
    }
  });

  // 加载更多
  const moreMutation = useMutation({
    mutationFn: async (variables: { searchId: string; targetRoomId: string; generation: number }) => {
      const queryKey = ["song-search", variables.searchId];
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, (previous: z.infer<typeof searchView> | undefined) =>
        previous ? { ...previous, status: "searching", errorCode: null } : previous
      );
      return request(
        `/${variables.targetRoomId}/search/${variables.searchId}/more`,
        searchInitiatedResponse,
        undefined,
        undefined,
        "POST"
      );
    },
    onSuccess: (_data, variables) => {
      if (variables.generation !== searchGeneration.current || variables.targetRoomId !== currentRoomId.current) return;
      void queryClient.invalidateQueries({ queryKey: ["song-search", variables.searchId] });
    },
    onError: (failure, variables) => {
      if (variables.generation !== searchGeneration.current || variables.targetRoomId !== currentRoomId.current) return;
      const code = failure instanceof RoomRequestError ? failure.code : null;
      setSearchLocalError(getFriendlySearchErrorMessage(code));
      void queryClient.invalidateQueries({ queryKey: ["song-search", variables.searchId] });
    }
  });

  // 添加单曲到个人歌单
  const addSongMutation = useMutation({
    mutationFn: async (variables: {
      candidate: SongCandidate;
      targetRoomId: string;
      generation: number;
      wasAlreadyInPersonal: boolean;
    }) => {
      setAdditionError("");
      setAddingSongId(variables.candidate.id);
      const res = await request(
        `/${variables.targetRoomId}/personal-playlist/songs`,
        personalSongAddResponse,
        undefined,
        {
          idempotencyKey: uuidv7(),
          songId: variables.candidate.id,
          name: variables.candidate.name,
          artists: variables.candidate.artists,
          album: variables.candidate.album
        }
      );
      return { response: res, variables };
    },
    onSuccess: ({ response: data, variables }) => {
      if (variables.generation !== searchGeneration.current || variables.targetRoomId !== currentRoomId.current) return;
      const op = data.operation;
      if (op.status === "succeeded") {
        setAddingSongId(null);
        setPersistedOperationId(null);
        setToast({
          id: uuidv7(),
          message:
            variables.wasAlreadyInPersonal || personalSongIds.has(variables.candidate.id)
              ? `《${variables.candidate.name}》已在个人歌单`
              : `《${variables.candidate.name}》已加入个人歌单`,
          type: "success"
        });
        // 乐观同步当前缓存快照，避免立即重复点击时仍显示为未添加
        queryClient.setQueryData(
          ["room-personal-playlist", sessionId, roomId],
          (prev: z.infer<typeof personalPlaylistView> | undefined) => {
            if (!prev || !prev.snapshot) return prev;
            if (prev.snapshot.tracks.some(t => t.songId === variables.candidate.id)) return prev;
            return {
              ...prev,
              snapshot: {
                ...prev.snapshot,
                trackCount: prev.snapshot.trackCount + 1,
                tracks: [
                  ...prev.snapshot.tracks,
                  {
                    position: prev.snapshot.tracks.length,
                    songId: variables.candidate.id,
                    name: variables.candidate.name,
                    artists: variables.candidate.artists,
                    album: variables.candidate.album
                  }
                ]
              }
            };
          }
        );
        void queryClient.invalidateQueries({ queryKey: ["room-personal-playlist", sessionId, roomId] });
      } else if (op.status === "failed" || op.status === "stopped") {
        setAddingSongId(null);
        setPersistedOperationId(null);
        setAdditionError(getFriendlyPersonalSongAdditionErrorMessage(op.errorCode));
      } else {
        // queued / processing / awaitingConfirmation / waitingAuthorization / needsAdministrator
        setPersistedOperationId(op.id);
      }
    },
    onError: (failure, variables) => {
      if (variables.generation !== searchGeneration.current || variables.targetRoomId !== currentRoomId.current) return;
      setAddingSongId(null);
      const code = failure instanceof RoomRequestError ? failure.code : null;
      setAdditionError(getFriendlyPersonalSongAdditionErrorMessage(code));
    }
  });

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    const q = searchQueryText.trim();
    if (!q) return;
    const generation = ++searchGeneration.current;
    setActiveSearchId(null);
    setSearchLocalError("");
    setAdditionError("");
    moreMutation.reset();
    searchMutation.mutate({ queryText: q, targetRoomId: roomId, generation });
  }

  function handleLoadMore() {
    if (!activeSearchId || moreMutation.isPending || searchQuery.data?.status === "searching") return;
    setSearchLocalError("");
    moreMutation.mutate({ searchId: activeSearchId, targetRoomId: roomId, generation: searchGeneration.current });
  }

  function handleClearSearch() {
    setSearchQueryText("");
    searchInputRef.current?.focus();
  }

  function handleAddSong(candidate: SongCandidate) {
    if (!hasPersonalPlaylist || addSongMutation.isPending || addingSongId) return;
    const wasAlreadyInPersonal = personalSongIds.has(candidate.id);
    addSongMutation.mutate({
      candidate,
      targetRoomId: roomId,
      generation: searchGeneration.current,
      wasAlreadyInPersonal
    });
  }

  const candidates = searchQuery.data?.songs ?? [];
  const isSearching = searchMutation.isPending || searchQuery.data?.status === "searching";
  const searchError = searchLocalError || (searchQuery.data?.errorCode ? getFriendlySearchErrorMessage(searchQuery.data.errorCode) : "");

  const activeOp = additionOperationQuery.data;
  const isAdditionPending = activeOp && IN_FLIGHT_STATUSES.has(activeOp.status);

  return (
    <div className="song-search-pane" role="region" aria-label="搜索歌曲页面">
      <div className="search-pane-header">
        <h1 className="search-pane-heading">搜索歌曲</h1>
      </div>

      {/* 未配置个人歌单醒目提示条 */}
      {!personalQuery.isPending && !hasPersonalPlaylist && (
        <div className="search-personal-missing-banner" role="status" aria-label="未配置个人歌单提示">
          <div className="banner-content">
            <AlertCircle size={18} className="banner-icon" aria-hidden="true" />
            <div className="banner-text">
              <span className="banner-title">尚未配置个人歌单</span>
              <span className="banner-desc">你可以搜索浏览歌曲，但无法添加。请先在「我的歌单」创建专用歌单。</span>
            </div>
          </div>
          <button
            type="button"
            className="secondary-button banner-action-btn"
            onClick={onNavigateToPersonal}
          >
            前往我的歌单
          </button>
        </div>
      )}

      {/* 异步添加操作在途状态横幅 */}
      {isAdditionPending && activeOp && (
        <div className={`addition-status-banner status-${activeOp.status}`} role="status">
          <div className="status-banner-content">
            {activeOp.status === "queued" || activeOp.status === "processing" ? (
              <RotateCw size={16} className="spin-icon" aria-hidden="true" />
            ) : activeOp.status === "awaitingConfirmation" ? (
              <Clock size={16} aria-hidden="true" />
            ) : (
              <AlertCircle size={16} aria-hidden="true" />
            )}
            <span>{getFriendlyPersonalSongAdditionStatusMessage(activeOp.status, activeOp.name)}</span>
          </div>
        </div>
      )}

      {/* 添加错误提示 */}
      {additionError && (
        <div className="search-error-banner" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{additionError}</span>
          <button
            type="button"
            className="error-dismiss-btn"
            onClick={() => setAdditionError("")}
            aria-label="关闭错误提示"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 搜索工具栏 */}
      <div className="search-toolbar-card" role="search" aria-label="全网单曲搜索">
        <form className="search-form" onSubmit={handleSearchSubmit}>
          <div className="search-input-wrapper">
            <Search size={16} className="search-input-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              className="search-input"
              placeholder="搜索歌名、歌手或专辑…"
              value={searchQueryText}
              onChange={e => setSearchQueryText(e.target.value)}
              aria-label="搜索歌曲"
            />
            {searchQueryText && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={handleClearSearch}
                aria-label="清空搜索词"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            type="submit"
            className="primary-button search-submit-btn"
            disabled={!searchQueryText.trim() || isSearching}
          >
            {isSearching ? "搜索中…" : "搜索"}
          </button>
        </form>
      </div>

      {/* 搜索错误提示 */}
      {searchError && (
        <div className="search-error-banner" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{searchError}</span>
        </div>
      )}

      {/* 搜索中微状态 */}
      {isSearching && candidates.length === 0 && (
        <div className="search-loading-state" role="status">
          <RotateCw size={18} className="spin-icon" aria-hidden="true" />
          <span>正在搜索歌曲…</span>
        </div>
      )}

      {/* 搜索结果展示 */}
      {!activeSearchId && !isSearching && (
        <div className="search-empty-guide" role="region" aria-label="搜索指南">
          <div className="search-guide-icon-wrapper" aria-hidden="true">
            <Music size={28} />
          </div>
          <h2>搜索并存入个人歌单</h2>
          <p>输入关键词搜索全网歌曲，一键存入你的专用个人歌单，再从「我的歌单」点歌到房间公共歌单。</p>
        </div>
      )}

      {activeSearchId && !isSearching && candidates.length === 0 && !searchError && (
        <div className="search-empty-state" role="status">
          <p>未找到匹配的歌曲，请尝试更换关键词。</p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="search-results-section" role="region" aria-label="搜索结果">
          <div className="search-results-header">
            <span className="results-count-text">
              找到 <strong>{candidates.length}</strong> 首候选歌曲
            </span>
          </div>

          <div className="search-candidate-list" role="list" aria-label="候选歌曲列表">
            {candidates.map((song, index) => {
              const isThisAdding = addingSongId === song.id;
              const isAnyAdding = Boolean(addingSongId || isAdditionPending);
              const isAlreadyInPersonal = personalSongIds.has(song.id);
              const addDisabled = !hasPersonalPlaylist || isAnyAdding;
              const buttonTitle = !hasPersonalPlaylist
                ? "尚未配置个人歌单，无法添加歌曲"
                : isAlreadyInPersonal
                ? "已在个人歌单，再次点击可确认"
                : "添加到个人歌单";

              return (
                <div key={`${song.id}-${index}`} className="search-candidate-item" role="listitem">
                  <span className="candidate-index" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="candidate-info">
                    <span className="candidate-name" title={song.name}>
                      {song.name}
                    </span>
                    <span
                      className="candidate-meta"
                      title={`${song.artists.join(" / ")}${song.album ? ` · ${song.album}` : ""}`}
                    >
                      {song.artists.join(" / ")}
                      {song.album && <span className="candidate-album"> · {song.album}</span>}
                    </span>
                  </div>
                  <div className="candidate-actions">
                    <button
                      type="button"
                      className="secondary-button candidate-add-btn"
                      disabled={addDisabled}
                      onClick={() => handleAddSong(song)}
                      title={buttonTitle}
                      aria-label={
                        !hasPersonalPlaylist
                          ? `添加《${song.name}》（尚未配置个人歌单）`
                          : `添加《${song.name}》到个人歌单`
                      }
                    >
                      {isThisAdding ? (
                        <>
                          <RotateCw size={14} className="spin-icon" aria-hidden="true" />
                          <span>添加中…</span>
                        </>
                      ) : (
                        <>
                          <Plus size={14} aria-hidden="true" />
                          <span>添加</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {searchQuery.data?.hasMore && (
            <div className="search-load-more-wrap">
              <button
                type="button"
                className="secondary-button search-load-more-btn"
                disabled={moreMutation.isPending || isSearching}
                onClick={handleLoadMore}
              >
                {moreMutation.isPending ? "正在加载更多…" : "加载更多"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Toast 轻量正反馈 */}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, X, Check, RotateCw, Music2, AlertCircle } from "lucide-react";
import { z } from "zod";
import {
  searchInitiatedResponse,
  searchView,
  type SongCandidate
} from "../shared/song-search-contracts.js";
import { queryOptions, request } from "./room-http.js";
import { getFriendlySongRequestErrorMessage } from "./song-request-messages.js";

export interface SongRequestDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  active: boolean;
  isRequesting: boolean;
  onConfirmSongRequest: (candidate: SongCandidate) => void;
  requestErrorMessage?: string;
  operationStatusMessage?: string;
  clearRequestErrorMessage?: () => void;
}

export function SongRequestDrawer({
  isOpen,
  onClose,
  roomId,
  active,
  isRequesting,
  operationStatusMessage,
  onConfirmSongRequest,
  requestErrorMessage,
  clearRequestErrorMessage
}: SongRequestDrawerProps) {
  const [searchQueryText, setSearchQueryText] = useState("");
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<SongCandidate | null>(null);
  const [searchLocalError, setSearchLocalError] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 打开抽屉时聚焦输入框
  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    } else {
      setSelectedCandidate(null);
      setSearchLocalError("");
    }
  }, [isOpen]);

  // 按 Esc 键关闭
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // 搜索查询（由 SSE 失效通知驱动重查，附带低频兜底）
  const searchQuery = useQuery({
    queryKey: ["song-search", activeSearchId],
    queryFn: ({ signal }) => request(`/${roomId}/search/${activeSearchId}`, searchView, signal),
    enabled: Boolean(activeSearchId && active && isOpen),
    refetchInterval: q => (q.state.data?.status === "searching" ? 10000 : false),
    ...queryOptions
  });

  const searchMutation = useMutation({
    mutationFn: async (queryText: string) => {
      setSelectedCandidate(null);
      setSearchLocalError("");
      clearRequestErrorMessage?.();
      return request(`/${roomId}/search`, searchInitiatedResponse, undefined, { query: queryText });
    },
    onSuccess: data => {
      setActiveSearchId(data.searchId);
    },
    onError: failure => {
      const code = failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string"
        ? failure.code
        : null;
      setSearchLocalError(getFriendlySongRequestErrorMessage(code));
    }
  });

  const cancelSearchMutation = useMutation({
    mutationFn: async (searchId: string) => {
      return request(`/${roomId}/search/${searchId}`, z.strictObject({ ok: z.literal(true) }), undefined, undefined, "DELETE");
    }
  });

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    const q = searchQueryText.trim();
    if (!q) return;
    searchMutation.mutate(q);
  }

  function handleCancelSearch() {
    if (activeSearchId) {
      cancelSearchMutation.mutate(activeSearchId);
    }
    setActiveSearchId(null);
    setSelectedCandidate(null);
    setSearchQueryText("");
    setSearchLocalError("");
    clearRequestErrorMessage?.();
  }

  if (!isOpen) return null;

  const candidates = searchQuery.data?.songs ?? [];
  const displayError = requestErrorMessage || searchLocalError;

  return (
    <>
      <div
        className="request-drawer-overlay"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="request-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="网易云点歌"
      >
        <div className="drawer-header">
          <div className="drawer-header-text">
            <h3 className="drawer-title" id="request-drawer-title">网易云全网点歌</h3>
            <p className="drawer-subtitle">搜索网易云音乐曲库，点播到当前房间公共歌单</p>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="关闭点歌面板"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* 搜索工具栏 */}
        <div className="drawer-search-bar" role="search" aria-label="直接单曲搜索">
          <form className="drawer-search-form" onSubmit={handleSearchSubmit}>
            <div className="drawer-search-input-wrapper">
              <Search size={16} className="search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                className="drawer-search-input"
                placeholder="输入歌名或歌手直接点歌…"
                value={searchQueryText}
                onChange={e => setSearchQueryText(e.target.value)}
                disabled={searchMutation.isPending || isRequesting}
                aria-label="搜索单曲关键词"
              />
            </div>
            <button
              type="submit"
              className="primary-button drawer-search-submit-btn"
              disabled={!searchQueryText.trim() || searchMutation.isPending || isRequesting}
            >
              {searchMutation.isPending ? "搜索中…" : "搜索"}
            </button>
            {activeSearchId && (
              <button
                type="button"
                className="secondary-button drawer-search-cancel-btn"
                onClick={handleCancelSearch}
                disabled={isRequesting}
                aria-label="取消搜索"
              >
                取消搜索
              </button>
            )}
          </form>
        </div>

        {/* 抽屉内容主体 */}
        <div className="drawer-content-body">
          {/* 排队与同步中温和进度提示 */}
          {isRequesting && operationStatusMessage && (
            <div className="drawer-feedback-banner drawer-info" role="status">
              <RotateCw size={16} className="spin-icon banner-icon" aria-hidden="true" />
              <span>{operationStatusMessage}</span>
            </div>
          )}

          {/* 温和情感化错误提示 */}
          {displayError && (
            <div className="drawer-feedback-banner drawer-error" role="alert">
              <AlertCircle size={16} className="banner-icon" aria-hidden="true" />
              <span>{displayError}</span>
            </div>
          )}

          {/* 搜索进行中 */}
          {(searchMutation.isPending || searchQuery.isLoading || searchQuery.data?.status === "searching") && (
            <div className="drawer-searching-state" role="status">
              <RotateCw size={18} className="spin-icon" aria-hidden="true" />
              <span>正在搜索网易云单曲…</span>
            </div>
          )}

          {/* 搜索失败与网络错误 */}
          {searchQuery.data?.status === "failed" && (
            <div className="drawer-feedback-banner drawer-error" role="alert">
              <AlertCircle size={16} className="banner-icon" aria-hidden="true" />
              <span>{getFriendlySongRequestErrorMessage(searchQuery.data.errorCode)}</span>
            </div>
          )}
          {searchQuery.isError && (
            <div className="drawer-feedback-banner drawer-error" role="alert">
              <AlertCircle size={16} className="banner-icon" aria-hidden="true" />
              <span>{getFriendlySongRequestErrorMessage("NETWORK_ERROR")}</span>
            </div>
          )}

          {/* 搜索完成但无候选单曲 */}
          {activeSearchId && searchQuery.data?.status === "completed" && candidates.length === 0 && (
            <div className="drawer-empty-search">
              <p className="search-empty-text">未找到相关单曲，请尝试其他关键词。</p>
            </div>
          )}

          {/* 搜索结果候选列表 */}
          {activeSearchId && searchQuery.data?.status === "completed" && candidates.length > 0 && !selectedCandidate && (
            <div className="drawer-candidates-container">
              <p className="drawer-candidates-count">找到 {candidates.length} 首候选歌曲</p>
              <ul className="candidate-list" role="listbox" aria-label="搜索候选列表">
                {candidates.map(song => (
                  <li
                    key={song.id}
                    role="option"
                    aria-selected={false}
                    tabIndex={0}
                    className="candidate-item"
                    onClick={() => setSelectedCandidate(song)}
                    onKeyDown={(e: KeyboardEvent<HTMLLIElement>) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedCandidate(song);
                      }
                    }}
                  >
                    <div className="candidate-info">
                      <span className="candidate-name">{song.name}</span>
                      <span className="candidate-meta">
                        {song.artists.join(" / ")}{song.album ? ` · ${song.album}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button candidate-select-btn"
                      onClick={e => {
                        e.stopPropagation();
                        setSelectedCandidate(song);
                      }}
                    >
                      选择
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 已选单曲卡片与确认点歌 */}
          {selectedCandidate && (
            <div className="selected-song-panel" role="region" aria-label="已选单曲">
              <div className="selected-song-header">
                <span className="selected-tag">已选单曲</span>
              </div>
              <div className="selected-song-info">
                <strong className="selected-song-name">{selectedCandidate.name}</strong>
                <span className="selected-song-meta">
                  {selectedCandidate.artists.join(" / ")}{selectedCandidate.album ? ` · ${selectedCandidate.album}` : ""}
                </span>
              </div>
              <div className="selected-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setSelectedCandidate(null)}
                  disabled={isRequesting}
                >
                  <X size={15} aria-hidden="true" />
                  取消选择
                </button>
                <button
                  type="button"
                  className="primary-button song-request-confirm-btn"
                  onClick={() => onConfirmSongRequest(selectedCandidate)}
                  disabled={isRequesting}
                >
                  {isRequesting ? (
                    <>
                      <RotateCw size={14} className="spin-icon" aria-hidden="true" />
                      <span>点歌中…</span>
                    </>
                  ) : (
                    <>
                      <Check size={15} aria-hidden="true" />
                      <span>确认点歌</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 未发起搜索时的引导状态 */}
          {!activeSearchId && !searchMutation.isPending && (
            <div className="drawer-empty-guide">
              <div className="drawer-disc-wrapper" aria-hidden="true">
                <Music2 size={32} />
              </div>
              <h4>挑选歌曲点入房间</h4>
              <p>输入歌名或歌手，网易云音乐海量曲库随心点播，与室友同步聆听。</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

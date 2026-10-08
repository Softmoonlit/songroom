import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, CheckCircle2, ChevronRight, Clock, Mail, Music2, Sparkles, UserPlus } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { v7 as uuidv7 } from "uuid";
import {
  inviteCode,
  inviteInspectView,
  joinApplicationCommand,
  joinApplicationView,
  type JoinApplicationCommand
} from "../shared/invite-contracts.js";
import { useInviteContext } from "./InviteContext.js";
import { InviteError } from "./InviteError.js";
import { inviteRequest } from "./invite-http.js";
import { RoomRequestError } from "./room-http.js";

export function JoinPage({ sessionId }: { sessionId: string }) {
  const { code, setCode } = useInviteContext();
  const [input, setInput] = useState(code);
  const [validation, setValidation] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const validCode = inviteCode.safeParse(code).success;

  useEffect(() => {
    setInput(code);
    const parsed = inviteCode.safeParse(code);
    setValidation(code && !parsed.success ? parsed.error.issues[0]!.message : "");
  }, [code]);

  useEffect(() => {
    if (!validCode) {
      codeInput.current?.focus();
    }
  }, [validCode]);

  function handleInspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanCode = input.trim();
    const parsed = inviteCode.safeParse(cleanCode);
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]!.message);
      return;
    }
    setValidation("");
    setCode(parsed.data);
  }

  function handleResetCode() {
    setCode("");
    setInput("");
    setValidation("");
  }

  return (
    <section className="rooms-page join-page-wrapper" aria-labelledby="join-heading">
      <Link className="back-link" to="/rooms">
        <ArrowLeft size={16} aria-hidden="true" />
        返回房间列表
      </Link>

      <div className="join-invitation-container">
        <div className="invitation-card">
          <div className="invitation-card-header">
            <div className="invitation-seal" aria-hidden="true">
              <Mail size={24} />
            </div>
            <h1 id="join-heading" className="invitation-title">房间加入邀请函</h1>
            <p className="invitation-subtitle">
              受邀室友提交申请后，经房主审批即可加入房间协作点歌
            </p>
          </div>

          {!validCode ? (
            <form className="invitation-code-form" onSubmit={handleInspect} noValidate>
              <div className="invitation-input-group">
                <label htmlFor="invite-code-input" className="invitation-label">
                  邀请码
                </label>
                <input
                  id="invite-code-input"
                  ref={codeInput}
                  className="invitation-code-input"
                  value={input}
                  placeholder="例如：abc_123-XY"
                  maxLength={10}
                  onChange={event => setInput(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>

              {validation && (
                <p className="form-message" role="alert">
                  {validation}
                </p>
              )}

              <button className="primary-button invitation-submit-btn" type="submit" aria-label="查看邀请">
                <span>查验邀请函</span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </form>
          ) : (
            <JoinInspection
              key={code}
              code={code}
              sessionId={sessionId}
              onResetCode={handleResetCode}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function JoinInspection({
  code,
  sessionId,
  onResetCode
}: {
  code: string;
  sessionId: string;
  onResetCode: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["invite-inspect", sessionId, code],
    queryFn: ({ signal }) => inviteRequest("/invites/inspect", inviteInspectView, signal, { code }),
    retry: false
  });

  const [nickname, setNickname] = useState("");
  const [validation, setValidation] = useState("");
  const [lastCommand, setLastCommand] = useState<JoinApplicationCommand | null>(null);
  const nicknameInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (query.data && !query.data.isMember && !query.data.application) {
      nicknameInput.current?.focus();
    }
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (command: JoinApplicationCommand) => {
      controller.current = new AbortController();
      return inviteRequest(
        "/join-applications",
        joinApplicationView,
        controller.current.signal,
        command
      );
    },
    retry: false,
    onSuccess: application => {
      if (controller.current?.signal.aborted) return;
      void queryClient.invalidateQueries({ queryKey: ["join-applications", sessionId] });
      queryClient.setQueryData(["join-application", sessionId, application.id], application);
      void navigate(`/application/${application.id}`);
    },
    onError: failure => {
      if (
        failure instanceof RoomRequestError &&
        ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_KEY_EXPIRED"].includes(failure.code)
      ) {
        setLastCommand(null);
      }
    }
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !query.data || query.data.isMember || query.data.application) return;

    const parsed = joinApplicationCommand.safeParse({
      code,
      nickname,
      idempotencyKey: lastCommand?.idempotencyKey ?? uuidv7()
    });

    if (!parsed.success) {
      setValidation(parsed.error.issues[0]!.message);
      return;
    }

    const command =
      lastCommand?.nickname === parsed.data.nickname
        ? lastCommand
        : { ...parsed.data, idempotencyKey: uuidv7() };
    setLastCommand(command);
    setValidation("");
    mutation.mutate(command);
  }

  function handleReload() {
    mutation.reset();
    void query.refetch();
  }

  if (query.isError) {
    return (
      <div className="invitation-error-wrapper">
        <InviteError error={query.error} retry={handleReload} />
        <button type="button" className="text-button secondary-action" onClick={onResetCode}>
          更换其他邀请码
        </button>
      </div>
    );
  }

  if (!query.data) {
    return (
      <div className="invitation-inspecting-state" role="status">
        <Clock size={20} className="spin" aria-hidden="true" />
        <span>正在读取邀请函内容…</span>
      </div>
    );
  }

  const view = query.data;

  return (
    <div className="invitation-details-container">
      <div className="invitation-room-badge">
        <div className="invitation-room-icon" aria-hidden="true">
          <Music2 size={20} />
        </div>
        <div className="invitation-room-info">
          <span className="invitation-room-hint">邀请你加入房间</span>
          <h2 className="invitation-room-name">{view.room.name}</h2>
        </div>
      </div>

      {view.isMember ? (
        <div className="invitation-status-box member-already" role="status">
          <CheckCircle2 size={24} className="status-box-icon" aria-hidden="true" />
          <div className="status-box-content">
            <h3 className="status-box-title">你已经是这个房间的成员</h3>
            <p className="status-box-desc">无需重复申请，可以直接前往房间点歌。</p>
          </div>
          <Link className="primary-button status-box-action" to={`/rooms/${view.room.id}`}>
            进入房间
          </Link>
        </div>
      ) : view.application ? (
        <div className="invitation-status-box pending-already" role="status">
          <Clock size={24} className="status-box-icon" aria-hidden="true" />
          <div className="status-box-content">
            <h3 className="status-box-title">已有这个房间的待处理申请</h3>
            <p className="status-box-desc">
              拟用昵称「{view.application.nickname}」，正在等待房主审批。
            </p>
          </div>
          <Link
            className="primary-button status-box-action"
            to={`/application/${view.application.id}`}
          >
            查看原申请
          </Link>
        </div>
      ) : (
        <form className="invitation-nickname-form" onSubmit={handleSubmit} noValidate>
          <div className="invitation-input-group">
            <label htmlFor="join-nickname-input" className="invitation-label">
              拟用房间昵称
            </label>
            <input
              id="join-nickname-input"
              ref={nicknameInput}
              className="invitation-nickname-input"
              value={nickname}
              disabled={mutation.isPending}
              placeholder="1 到 12 个字符"
              onChange={event => setNickname(event.target.value)}
              autoComplete="off"
            />
            <span className="invitation-field-help">
              仅在当前房间内展示，审批期间不会占用昵称。
            </span>
          </div>

          {validation && (
            <p className="form-message" role="alert">
              {validation}
            </p>
          )}

          <div className="invitation-actions">
            <button
              className="primary-button invitation-submit-btn"
              type="submit"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <span>正在提交申请…</span>
              ) : (
                <>
                  <UserPlus size={16} aria-hidden="true" />
                  <span>提交加入申请</span>
                </>
              )}
            </button>

            <button
              type="button"
              className="text-button change-code-btn"
              onClick={onResetCode}
              disabled={mutation.isPending}
            >
              更换其他邀请码
            </button>
          </div>

          {mutation.isError && <InviteError error={mutation.error} retry={handleReload} />}
        </form>
      )}
    </div>
  );
}

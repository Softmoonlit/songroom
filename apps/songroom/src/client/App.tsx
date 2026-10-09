import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, ChevronDown, CircleAlert, CircleCheck, LogOut, Music2, Settings, UserRound } from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router";
import { healthResponse, type HealthResponse } from "../shared/contracts";
import { NeteaseBinding } from "./NeteaseBinding";
import { RoomsPage, PublicPlaylistCleanups } from "./Rooms";
import { RoomCreatePage } from "./RoomCreatePage";
import { RoomPage } from "./RoomWorkspace";
import { InviteProvider, JoinEntry, useInviteContext } from "./InviteContext";
import { JoinPage } from "./JoinPage";
import { ApplicationPage } from "./ApplicationPage";
import { useEventStream } from "./useEventStream";

type SessionData = {
  session: { id: string; expiresAt: string };
  user: { id: string; name: string; email: string; emailVerified: boolean };
};
type AuthMode = "sign-in" | "sign-up";
type ActionResult = { ok: true; data?: unknown } | { ok: false; message: string };

const statusLabels: Record<HealthResponse["status"], string> = {
  starting: "启动中",
  ready: "运行正常",
  draining: "正在停止",
  stopped: "已停止"
};

const authErrorMessages: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确，请重试。",
  INVALID_EMAIL: "请输入有效的邮箱地址。",
  INVALID_PASSWORD: "密码不正确，请检查后重试。",
  PASSWORD_TOO_SHORT: "密码至少需要 8 个字符。",
  PASSWORD_TOO_LONG: "密码不能超过 128 个字符。",
  USER_ALREADY_EXISTS: "该邮箱已注册，请登录或使用其他邮箱。",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "该邮箱已注册，请登录或使用其他邮箱。",
  EMAIL_NOT_VERIFIED: "邮箱尚未验证，请联系服务器管理员。",
  SESSION_EXPIRED: "账号会话已过期，请重新登录。",
  UNAUTHORIZED: "账号会话无效，请重新登录。",
  TOO_MANY_REQUESTS: "请求过于频繁，请稍后重试。",
  INTERNAL_SERVER_ERROR: "服务暂时不可用，请稍后重试。",
  SERVICE_UNAVAILABLE: "服务暂时不可用，请稍后重试。"
};

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/status", {
    headers: { Accept: "application/json" },
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error(`health request failed: ${response.status}`);
  return healthResponse.parse(await response.json());
}

async function fetchSession(): Promise<SessionData | null> {
  const response = await fetch("/api/auth/get-session", {
    headers: { Accept: "application/json" },
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error(`session request failed: ${response.status}`);
  return await response.json() as SessionData | null;
}

async function authAction(path: string, body: unknown): Promise<ActionResult> {
  try {
    const response = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    if (response.ok) {
      return { ok: true, data: await response.json().catch(() => undefined) };
    }
    if (response.status === 429) {
      return { ok: false, message: "请求过于频繁，请稍后重试。" };
    }
    if (response.status >= 500) {
      return { ok: false, message: "服务暂时不可用，请稍后重试。" };
    }
    const payload = await response.json().catch(() => undefined) as {
      code?: string;
      error?: { code?: string };
    } | undefined;
    const code = payload?.code ?? payload?.error?.code;
    return {
      ok: false,
      message: (code && authErrorMessages[code]) || "请求未被接受，请检查输入后重试。"
    };
  } catch {
    return { ok: false, message: "服务暂时不可用，请稍后重试。" };
  }
}

export function App() {
  return <InviteProvider><AppContent /></InviteProvider>;
}

function AppContent() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false
  });
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: fetchSession,
    retry: false,
    refetchOnWindowFocus: false
  });

  useEventStream(Boolean(sessionQuery.data));

  async function onAuthenticated(): Promise<void> {
    const result = await sessionQuery.refetch({ throwOnError: true });
    if (!result.data) throw new Error("Session was not restored after authentication");
  }

  const protection = {
    pending: sessionQuery.isPending,
    failed: sessionQuery.isError,
    retrying: sessionQuery.isFetching,
    session: sessionQuery.data,
    onRetry: () => void sessionQuery.refetch()
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/" aria-label="SongRoom 首页">
          <span className="brand-mark" aria-hidden="true">
            <Music2 size={22} strokeWidth={2.4} />
          </span>
          <span className="brand-name">SongRoom</span>
        </Link>
        <div className="header-actions">
          <HealthStatus query={healthQuery} />
          {sessionQuery.data && <UserCapsule user={sessionQuery.data.user} />}
        </div>
      </header>

      <main className="main-content">
        <Routes>
          <Route
            path="/"
            element={<Landing session={sessionQuery.data} onAuthenticated={onAuthenticated} />}
          />
          <Route
            path="/login"
            element={<AuthPage key="sign-in" mode="sign-in" onAuthenticated={onAuthenticated} />}
          />
          <Route
            path="/register"
            element={<AuthPage key="sign-up" mode="sign-up" onAuthenticated={onAuthenticated} />}
          />
          <Route
            path="/rooms"
            element={
              <Protected {...protection}>
                {sessionQuery.data && <RoomsPage key={sessionQuery.data.session.id} sessionId={sessionQuery.data.session.id} accountName={sessionQuery.data.user.name} />}
              </Protected>
            }
          />
          <Route path="/join" element={<JoinEntry><Protected {...protection}>{sessionQuery.data && <JoinPage key={sessionQuery.data.session.id} sessionId={sessionQuery.data.session.id} />}</Protected></JoinEntry>} />
          <Route path="/application/:applicationId" element={<Protected {...protection}>{sessionQuery.data && <ApplicationPage sessionId={sessionQuery.data.session.id} />}</Protected>} />
          <Route path="/rooms/new" element={<Protected {...protection}>{sessionQuery.data && <RoomCreatePage key={sessionQuery.data.session.id} sessionId={sessionQuery.data.session.id} />}</Protected>} />
          <Route path="/rooms/:roomId" element={<Protected {...protection}>{sessionQuery.data && <RoomPage sessionId={sessionQuery.data.session.id} />}</Protected>} />
          <Route
            path="/account"
            element={
              <Protected {...protection}>
                <AccountPage session={sessionQuery.data} />
              </Protected>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <footer className="app-footer">
        <span>SongRoom</span>
        <span aria-hidden="true">·</span>
        <span>宿舍音乐共享与协作点歌</span>
      </footer>
    </div>
  );
}

type HealthQuery = ReturnType<typeof useQuery<HealthResponse, Error>>;

function HealthStatus({ query }: { query: HealthQuery }) {
  const status = query.data?.status;
  const isError = query.isError;
  const isReady = status === "ready";
  const label = query.isPending ? "读取中" : isError ? "暂不可用" : status ? statusLabels[status] : "未知";
  const stateClass = isError ? "error" : isReady ? "ready" : "pending";

  return (
    <div
      className={`health-dot ${stateClass}`}
      title={`服务状态：${label}`}
    >
      <span className="dot-indicator" aria-hidden="true" />
      <span className="sr-only">服务状态：{label}</span>
      {!isReady && <span className="health-dot-label" aria-hidden="true">{label}</span>}
      {isError && (
        <button
          type="button"
          className="secondary-button health-retry-button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? "重试中" : "重新读取状态"}
        </button>
      )}
    </div>
  );
}

function UserCapsule({ user }: { user: SessionData["user"] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const capsuleRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (capsuleRef.current && !capsuleRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  async function handleSignOut() {
    setSignOutError(null);
    const result = await authAction("/sign-out", {});
    if (!result.ok) {
      setSignOutError(result.message);
      return;
    }
    setIsOpen(false);
    window.location.assign("/");
  }

  const initial = (user.name || "用").trim().slice(0, 1).toUpperCase();

  return (
    <div
      ref={capsuleRef}
      className={`user-capsule ${isOpen ? "open" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="user-capsule-trigger"
        onClick={() => setIsOpen(open => !open)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="账号菜单"
      >
        <span className="user-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="user-name">{user.name}</span>
        <ChevronDown size={14} className="capsule-chevron" aria-hidden="true" />
      </button>

      <div
        className={`user-dropdown ${isOpen ? "visible" : ""}`}
        aria-label="账号操作"
      >
        <div className="user-dropdown-profile">
          <span className="dropdown-user-name">{user.name}</span>
          <span className="dropdown-user-email">{user.email}</span>
        </div>
        {signOutError && (
          <p className="dropdown-error" role="alert">
            {signOutError}
          </p>
        )}
        <div className="user-dropdown-divider" aria-hidden="true" />
        <Link
          to="/account"
          className="user-dropdown-item"
          onClick={() => setIsOpen(false)}
        >
          <Settings size={15} aria-hidden="true" />
          <span>账号设置</span>
        </Link>
        <button
          type="button"
          className="user-dropdown-item danger"
          onClick={() => void handleSignOut()}
        >
          <LogOut size={15} aria-hidden="true" />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  );
}

function Landing({ session, onAuthenticated }: {
  session?: SessionData | null;
  onAuthenticated: () => Promise<void>;
}) {
  if (session) return <Navigate to="/rooms" replace />;

  return (
    <section className="home-page" aria-labelledby="welcome-heading">
      <div className="hero-copy">
        <h1 id="welcome-heading">SongRoom 点歌台</h1>
        <p className="hero-subtitle">和室友一起点歌</p>
      </div>
      <div className="auth-card">
        <AuthPage mode="sign-in" compact onAuthenticated={onAuthenticated} />
        <div className="auth-card-foot">
          <span>还没有点歌台账号？</span>
          <Link className="text-link" to="/register">立即注册</Link>
        </div>
      </div>
    </section>
  );
}

function AuthPage({ mode, onAuthenticated, compact = false }: {
  mode: AuthMode;
  onAuthenticated: () => Promise<void>;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const { returningToJoin } = useInviteContext();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const signingUp = mode === "sign-up";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage("");
    setPending(true);
    try {
      const result = await authAction(
        signingUp ? "/sign-up/email" : "/sign-in/email",
        signingUp ? { name, email, password } : { email, password }
      );
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      await onAuthenticated();
      navigate(returningToJoin ? "/join" : "/rooms");
    } catch {
      setMessage("认证已成功，但暂时无法读取账号会话，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={`auth-page ${compact ? "compact" : ""}`} aria-labelledby="auth-heading">
      {!compact && (
        <Link className="back-link" to="/">
          <ArrowLeft size={17} aria-hidden="true" />
          返回首页
        </Link>
      )}
      <div className="auth-heading">
        {compact ? <h2 id="auth-heading">登录</h2> : <h1 id="auth-heading">{signingUp ? "创建点歌台账号" : "登录点歌台"}</h1>}
        {returningToJoin && <p>认证后继续填写房间加入申请。</p>}
      </div>
      <form className="auth-form" onSubmit={submit} noValidate>
        {signingUp && (
          <label>
            账号称呼
            <input
              name="name"
              value={name}
              onChange={event => setName(event.target.value)}
              required
              autoComplete="name"
              maxLength={100}
            />
          </label>
        )}
        <label>
          邮箱
          <input
            name="email"
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            required
            minLength={8}
            maxLength={128}
            autoComplete={signingUp ? "new-password" : "current-password"}
          />
          <span className="field-help">密码长度为 8 到 128 个字符。</span>
        </label>
        {message && (
          <p className="form-message" role="alert">
            <CircleAlert size={17} aria-hidden="true" />
            {message}
          </p>
        )}
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "提交中…" : returningToJoin ? signingUp ? "注册并继续申请" : "登录并继续申请" : signingUp ? "注册并进入房间列表" : "登录"}
        </button>
      </form>
      <div className="auth-links">
        {signingUp ? (
          <>
            <span>已有账号？</span>
            <Link className="text-link" to="/login">返回登录</Link>
          </>
        ) : (
          <>
            <span>还没有账号？</span>
            <Link className="text-link" to="/register">注册账号</Link>
          </>
        )}
        <span className="forgot-password">忘记密码？请通过既定线下渠道联系服务器管理员。</span>
      </div>
    </section>
  );
}

function Protected({ pending, failed, retrying, session, onRetry, children }: {
  pending: boolean;
  failed: boolean;
  retrying: boolean;
  session?: SessionData | null;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (pending) {
    return <section className="page-loading" aria-live="polite">正在恢复账号会话…</section>;
  }
  if (failed) {
    return (
      <section className="page-loading">
        <p className="form-message" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          暂时无法读取账号会话，请重试。
        </p>
        <button className="secondary-button" type="button" onClick={onRetry} disabled={retrying}>
          {retrying ? "重试中…" : "重新读取会话"}
        </button>
      </section>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AccountPage({ session }: { session?: SessionData | null }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(session?.user.name ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [pending, setPending] = useState(false);
  if (!session) return null;

  async function updateName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const result = await authAction("/update-user", { name });
    setPending(false);
    setMessageError(!result.ok);
    setMessage(result.ok ? "账号称呼已更新。" : result.message);
    if (result.ok) {
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const result = await authAction("/change-password", { currentPassword, newPassword });
    setPending(false);
    setMessageError(!result.ok);
    setMessage(result.ok ? "密码已更新，其他设备会话仍然有效。" : result.message);
    if (result.ok) {
      setCurrentPassword("");
      setNewPassword("");
    }
  }

  async function signOut(): Promise<void> {
    setPending(true);
    const result = await authAction("/sign-out", {});
    if (!result.ok) {
      setMessageError(true);
      setMessage(result.message);
      setPending(false);
      return;
    }
    window.location.assign("/");
  }

  return (
    <section className="account-page" aria-labelledby="account-heading">
      <Link className="back-link" to="/rooms">
        <ArrowLeft size={16} aria-hidden="true" />
        返回房间列表
      </Link>
      <div className="page-heading">
        <h1 id="account-heading">账号设置</h1>
      </div>
      <div className="settings-grid">
        <form className="settings-card" onSubmit={updateName}>
          <h2>个人资料</h2>
          <label>
            称呼
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="输入账号称呼"
              required
              maxLength={100}
              autoComplete="name"
            />
          </label>
          <label>
            登录邮箱
            <input value={session.user.email} readOnly aria-readonly="true" />
          </label>
          <button className="primary-button" type="submit" disabled={pending}>保存称呼</button>
        </form>
        <form className="settings-card" onSubmit={changePassword}>
          <h2>修改密码</h2>
          <label>
            当前密码
            <input
              type="password"
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
              placeholder="输入当前密码"
              required
              autoComplete="current-password"
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              placeholder="8-128位新密码"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <button className="primary-button" type="submit" disabled={pending}>更新密码</button>
        </form>
      </div>
      <NeteaseBinding key={session.session.id} sessionId={session.session.id} />
      <PublicPlaylistCleanups sessionId={session.session.id} />
      {message && (
        <p
          className={`form-message account-message ${messageError ? "error" : ""}`}
          role={messageError ? "alert" : "status"}
        >
          <CircleCheck size={17} aria-hidden="true" />
          {message}
        </p>
      )}
      <div className="account-logout">
        <button className="logout-button" type="button" onClick={() => void signOut()} disabled={pending}>
          <LogOut size={17} aria-hidden="true" />
          退出当前设备
        </button>
      </div>
    </section>
  );
}

function NotFound() {
  return (
    <section className="not-found" aria-labelledby="not-found-heading">
      <div className="not-found-icon" aria-hidden="true">
        <CircleAlert size={30} />
      </div>
      <p className="eyebrow">页面未找到</p>
      <h1 id="not-found-heading">404</h1>
      <p>这个地址没有对应的 SongRoom 页面。</p>
      <Link className="home-link" to="/">
        <ArrowLeft size={18} aria-hidden="true" />
        返回首页
      </Link>
    </section>
  );
}

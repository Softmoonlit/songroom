import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, LogOut, Music2, UserRound } from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router";
import { healthResponse, type HealthResponse } from "../shared/contracts";
import { NeteaseBinding } from "./NeteaseBinding";
import { RoomsPage } from "./Rooms";
import { RoomCreatePage } from "./RoomCreatePage";
import { RoomPage } from "./RoomWorkspace";

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
          {sessionQuery.data && <UserMenu user={sessionQuery.data.user} />}
        </div>
      </header>

      <main className="main-content">
        <Routes>
          <Route
            path="/"
            element={
              <Landing
                session={sessionQuery.data}
                health={healthQuery.data}
                isHealthError={healthQuery.isError}
                isHealthRetrying={healthQuery.isFetching}
                onRetry={() => void healthQuery.refetch()}
                onAuthenticated={onAuthenticated}
              />
            }
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
        <span>同源安全登录</span>
      </footer>
    </div>
  );
}

type HealthQuery = ReturnType<typeof useQuery<HealthResponse, Error>>;

function HealthStatus({ query }: { query: HealthQuery }) {
  const status = query.data?.status;
  const label = query.isPending ? "读取中" : query.isError ? "暂不可用" : status ? statusLabels[status] : "未知";
  const stateClass = query.isError ? "error" : status === "ready" ? "ready" : "pending";

  return (
    <div className={`health-status ${stateClass}`} aria-label={`应用状态：${label}`} aria-live="polite">
      <span aria-hidden="true">●</span>
      <span className="health-label">应用状态</span>
      <strong>{label}</strong>
    </div>
  );
}

function UserMenu({ user }: { user: SessionData["user"] }) {
  return (
    <nav className="user-menu" aria-label="账号导航">
      <span className="user-greeting">
        <UserRound size={16} aria-hidden="true" />
        {user.name}
      </span>
      <Link to="/rooms">我的房间</Link>
      <Link to="/account">账号设置</Link>
    </nav>
  );
}

function Landing({ session, health, isHealthError, isHealthRetrying, onRetry, onAuthenticated }: {
  session?: SessionData | null;
  health?: HealthResponse;
  isHealthError: boolean;
  isHealthRetrying: boolean;
  onRetry: () => void;
  onAuthenticated: () => Promise<void>;
}) {
  if (session) return <Navigate to="/rooms" replace />;

  return (
    <section className="home-page" aria-labelledby="welcome-heading">
      <div className="hero-copy">
        <p className="eyebrow">
          <Music2 size={16} aria-hidden="true" />
          SongRoom
        </p>
        <h1 id="welcome-heading">SongRoom 点歌台</h1>
        <p className="hero-subtitle">和室友一起点歌</p>
        <p className="hero-description">
          账号与房间功能正在交付。使用一个点歌台账号恢复你的房间身份，在熟悉的设备之间继续分享想听的歌。
        </p>
      </div>
      <div className="auth-card">
        <AuthPage mode="sign-in" compact onAuthenticated={onAuthenticated} />
        <div className="auth-card-foot">
          <span>还没有点歌台账号？</span>
          <Link className="text-link" to="/register">立即注册</Link>
        </div>
      </div>
      <div className={`status-card ${isHealthError ? "error" : health?.status === "ready" ? "ready" : "pending"}`}>
        <div className="status-card-icon" aria-hidden="true">
          {isHealthError ? <CircleAlert size={25} /> : <CircleCheck size={25} />}
        </div>
        <div className="status-card-copy">
          <p className="eyebrow">服务状态</p>
          <h2>
            {isHealthError ? "暂时无法连接服务" : health?.status === "ready" ? "应用已准备就绪" : "正在确认应用状态"}
          </h2>
          <p>
            {isHealthError ? "暂时无法读取应用状态，请稍后重试。" : "账号、房间与点歌功能在可信同源入口中运行。"}
          </p>
        </div>
        {isHealthError && (
          <button className="secondary-button" type="button" onClick={onRetry} disabled={isHealthRetrying}>
            {isHealthRetrying ? "重试中" : "重新读取状态"}
          </button>
        )}
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
      navigate("/rooms");
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
        <p className="eyebrow">
          <UserRound size={16} aria-hidden="true" />
          点歌台账号
        </p>
        <h1 id="auth-heading">{signingUp ? "创建点歌台账号" : "登录点歌台"}</h1>
        <p>{signingUp ? "注册后会自动登录并进入你的房间列表。" : "使用注册时的邮箱和密码继续。"}</p>
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
          {pending ? "提交中…" : signingUp ? "注册并进入房间列表" : "登录"}
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
      <div className="page-heading">
        <p className="eyebrow">
          <UserRound size={16} aria-hidden="true" />
          账号设置
        </p>
        <h1 id="account-heading">管理你的点歌台账号</h1>
        <p>账号称呼可以修改并允许重复。邮箱是唯一登录标识，当前版本不提供修改入口。</p>
      </div>
      <div className="settings-grid">
        <form className="settings-card" onSubmit={updateName}>
          <h2>账号称呼</h2>
          <label>
            称呼
            <input
              value={name}
              onChange={event => setName(event.target.value)}
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
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <p className="field-help">修改密码不会自动撤销其他设备会话。</p>
          <button className="primary-button" type="submit" disabled={pending}>更新密码</button>
        </form>
      </div>
      <NeteaseBinding key={session.session.id} sessionId={session.session.id} />
      {message && (
        <p
          className={`form-message account-message ${messageError ? "error" : ""}`}
          role={messageError ? "alert" : "status"}
        >
          <CircleCheck size={17} aria-hidden="true" />
          {message}
        </p>
      )}
      <button className="logout-button" type="button" onClick={() => void signOut()} disabled={pending}>
        <LogOut size={17} aria-hidden="true" />
        退出当前设备
      </button>
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

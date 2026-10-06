import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, CircleAlert, CircleCheck, LoaderCircle, Music2 } from "lucide-react";
import { Link, Route, Routes } from "react-router";
import { healthResponse, type HealthResponse } from "../shared/contracts";

const statusLabels: Record<HealthResponse["status"], string> = {
  starting: "启动中",
  ready: "运行正常",
  draining: "正在停止",
  stopped: "已停止"
};

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/status", {
    headers: { Accept: "application/json" },
    credentials: "same-origin"
  });

  if (!response.ok) {
    throw new Error(`health request failed: ${response.status}`);
  }

  return healthResponse.parse(await response.json());
}

export function App() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false
  });

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/" aria-label="SongRoom 首页">
          <span className="brand-mark" aria-hidden="true"><Music2 size={22} strokeWidth={2.4} /></span>
          <span className="brand-name">SongRoom</span>
        </Link>
        <HealthStatus query={healthQuery} />
      </header>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Home health={healthQuery.data} isError={healthQuery.isError} isRetrying={healthQuery.isFetching} onRetry={() => void healthQuery.refetch()} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <footer className="app-footer">
        <span>SongRoom</span>
        <span aria-hidden="true">·</span>
        <span>基础运行环境</span>
      </footer>
    </div>
  );
}

type HealthQuery = ReturnType<typeof useQuery<HealthResponse, Error>>;

function HealthStatus({ query }: { query: HealthQuery }) {
  const status = query.data?.status;
  const label = query.isPending
    ? "读取中"
    : query.isError
      ? "暂不可用"
      : status
        ? statusLabels[status]
        : "未知";
  const stateClass = query.isError ? "error" : status === "ready" ? "ready" : "pending";
  const Icon = query.isError ? CircleAlert : status === "ready" ? CircleCheck : LoaderCircle;

  return (
    <div className={`health-status ${stateClass}`} aria-label={`应用状态：${label}`} aria-live="polite">
      <Icon className={query.isPending ? "spin" : undefined} size={17} aria-hidden="true" />
      <span className="health-label">应用状态</span>
      <strong>{label}</strong>
    </div>
  );
}

function Home({ health, isError, isRetrying, onRetry }: { health?: HealthResponse; isError: boolean; isRetrying: boolean; onRetry: () => void }) {
  const isReady = health?.status === "ready";
  const statusClass = isError ? "error" : isReady ? "ready" : "pending";

  return (
    <section className="home-page" aria-labelledby="welcome-heading">
      <div className="hero-copy">
        <p className="eyebrow"><Activity size={16} aria-hidden="true" />SongRoom</p>
        <h1 id="welcome-heading">SongRoom 点歌台</h1>
        <p className="hero-description">
          和室友一起分享想听的歌。账号和房间功能将逐步加入，先从可靠的基础服务开始。
        </p>
      </div>

      <div className={`status-card ${statusClass}`} aria-labelledby="status-heading">
        <div className="status-card-icon" aria-hidden="true">
          {isError ? <CircleAlert size={25} /> : isReady ? <CircleCheck size={25} /> : <Activity size={25} />}
        </div>
        <div className="status-card-copy">
          <p className="eyebrow">服务状态</p>
          <h2 id="status-heading">
            {isError ? "暂时无法连接服务" : isReady ? "应用已准备就绪" : "正在确认应用状态"}
          </h2>
          <p>
            {isError ? "暂时无法读取应用状态，请稍后重试。" : health ? "应用状态已确认，可以继续使用。" : "正在读取应用状态。"}
          </p>
        </div>
        <div className="status-card-actions">
          <span className={`status-pill ${statusClass}`}>
            {isError ? "暂不可用" : health ? statusLabels[health.status] : "读取中"}
          </span>
          {isError && (
            <button className="retry-button" type="button" onClick={onRetry} disabled={isRetrying}>
              {isRetrying ? "重试中" : "重新读取状态"}
            </button>
          )}
        </div>
      </div>

      <div className="delivery-card">
        <div className="delivery-icon" aria-hidden="true"><Music2 size={22} /></div>
        <div>
          <h2>账号与房间功能正在交付</h2>
          <p>当前版本提供应用基础壳和服务状态。登录、账号管理、房间与点歌功能将在后续版本中逐步加入。</p>
        </div>
      </div>
    </section>
  );
}

function NotFound() {
  return (
    <section className="not-found" aria-labelledby="not-found-heading">
      <div className="not-found-icon" aria-hidden="true"><CircleAlert size={30} /></div>
      <p className="eyebrow">页面未找到</p>
      <h1 id="not-found-heading">404</h1>
      <p>这个地址没有对应的 SongRoom 页面。</p>
      <Link className="home-link" to="/"><ArrowLeft size={18} aria-hidden="true" />返回首页</Link>
    </section>
  );
}

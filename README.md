# SongRoom 点歌台

同源 TypeScript 应用基础：Fastify 提供 JSON、健康检查和 Vite 构建的 React SPA，SQLite 使用真实文件与 WAL。当前交付基础运行边界；账号认证、房间和网易云能力由后续工单实现。

## 本地运行

使用 Node.js **24.21.0** 与 pnpm **12.9.1**。运行时检查和 `engine-strict` 会拒绝其他 Node.js 版本。所有直接依赖精确锁定，安装时使用锁文件。

```bash
pnpm install --frozen-lockfile
cp songroom.config.example.json songroom.config.json
chmod 600 songroom.config.json
export SONGROOM_CONFIG="$PWD/songroom.config.json"
pnpm db:init
pnpm db:check
pnpm build
pnpm start
```

浏览器打开 `http://127.0.0.1:3000`。`SONGROOM_CONFIG` 只指定配置文件路径；配置中的路径以配置文件目录为基准。配置文件必须由当前用户持有，仅当前用户可读写。普通启动缺少配置、数据库、正确 schema 或客户端构建产物时失败，不会初始化、迁移、生成密钥或返回空白页面。

生产入口必须配置精确 HTTPS origin，应用只监听 `127.0.0.1` 并仅信任本机代理。公网 Caddy、可信证书、systemd 和真实机器资源由部署工单验收，本地运行通过不代表可以上线。数据库与私有配置须放在静态资源目录之外。后续认证签名和上游凭据密钥只通过受限文件接入。

## 数据库维护

`pnpm db:init` 独占创建数据库并应用仓库中的 Drizzle 迁移，重复初始化拒绝覆盖。`pnpm db:migrate` 只显式迁移已有数据库；命令先占用与应用相同的回环端口，应用运行中或端口占用时拒绝执行。迁移期间应保持 systemd 停止；不增加数据库租约或分布式锁。

`pnpm db:check` 只读检查迁移记录、schema、数据库完整性及 WAL；它不会创建数据库或修改业务状态。生产环境可以直接使用编译后的命令：

```bash
node apps/songroom/dist/cli.js db check
node apps/songroom/dist/cli.js db migrate
```

普通启动只打开已有数据库并校验，外键和锁等待超时在每个运行连接上启用。不要把数据库初始化当作数据丢失后的自动恢复。

## 开发和验证

```bash
pnpm typecheck
pnpm --filter @songroom/app test src/commands/commands.test.ts
pnpm test
pnpm --filter @songroom/app exec playwright install chromium
pnpm test:e2e
```

Vitest 覆盖公开规则、真实临时 SQLite 和同源 HTTP。Playwright 独立初始化临时数据库并启动完整应用，检查 320、900、1440px 的布局、键盘焦点、浏览器错误和 HTTP 行为。测试数据不会进入生产数据库。

`/healthz` 无副作用，就绪返回 200，启动或排空返回 503。`/api/status` 返回共享 Zod 契约的运行状态。应用成功监听后才切换到就绪；第二实例因端口冲突失败。SIGINT/SIGTERM 进入排空、拒绝新变更请求、等待 HTTP 完成并关闭数据库。

HTML 与 JSON 使用 `no-store`；Vite 内容哈希资产由 `@fastify/static` 提供一年 immutable 缓存，标准安全头由 `@fastify/helmet` 提供。普通日志只记录请求关联 ID、路由模板、状态、耗时和稳定错误码，未来生产由 journald 限量保存。

## 后续实现约束

端点使用共享 Zod schema 推导类型，Fastify 薄适配统一校验与序列化。业务实体、操作和幂等键使用 UUIDv7；网易云标识保持不透明字符串。命令规则按点歌台账号定域，以规范内容摘要识别重放：本地新命令 200，异步新命令 202，重放 200，内容冲突或超过 24 小时及超过一分钟未来偏差的键 409。具体业务命令必须在其受理事务中查询并保存最小防重记录；本票不增加通用命令 HTTP 入口或通用任务载荷。

受审 Enhanced vendor 源码、补丁与隔离调用由网易云接入工单纳入 workspace。当前基础应用没有上游入口，部署不会下载或运行未经补丁的代码。

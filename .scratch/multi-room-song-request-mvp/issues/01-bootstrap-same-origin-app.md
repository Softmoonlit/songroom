# 01: 建立可运行的同源应用

**What to build:** 交付一个可初始化、迁移、自检、启动并在浏览器中打开的 SongRoom 同源应用，为后续账号和房间功能提供真实 SQLite、HTTP、SPA 与自动化测试运行边界。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 应用使用规格锁定的 Node.js、pnpm、TypeScript、Fastify、React、Vite、SQLite、Drizzle、Zod、测试工具及批准的窄依赖，所有直接依赖均精确锁定且部署时不会隐式升级。
- [x] 单个 Fastify 进程在同一来源提供 JSON 接口、无副作用健康检查、SPA HTML 与带内容哈希的静态资源，并为 HTML、JSON 和静态资源应用规格要求的缓存策略。
- [x] `@fastify/static` 和 `@fastify/helmet` 承担静态资源及标准安全响应头；未引入 SSR、容器、Redis、通用任务队列、通用状态机或完整 UI 框架。
- [x] 应用通过薄的 Fastify/Zod 适配统一请求校验、响应序列化和类型推导，不安装会强制引入未使用 Swagger/OpenAPI peer 的类型提供器，也不维护第二套手写 DTO。
- [x] 应用实体、持久操作和客户端幂等键统一使用服务端校验的 UUIDv7 文本标识；网易云账号、歌单和歌曲 ID 只作为不透明字符串保存和传输，不建立数值列、数值范围或算术假设。
- [x] 共用业务命令契约要求按点歌台账号定域的 UUIDv7 幂等键与规范摘要，拒绝超过 24 小时或明显来自未来的键；纯本地命令同步返回，需要云端的异步新操作返回 202，同键同内容返回原结果或操作且异步重放为 200，同键不同内容或过期键返回 409 和稳定业务码。Better Auth 原生端点、搜索及无副作用刷新不使用业务幂等键。
- [x] SPA 使用固定 React Router 管理路由、TanStack Query 管理服务端 read model 和缓存失效、Lucide React 提供熟悉的图标；房间导航和未提交草稿只用房间级 React 内存，不引入 Redux 或通用客户端状态机。
- [x] 数据库只能由显式初始化创建、只能在应用停止时显式迁移，并提供只读自检；普通启动遇到数据库缺失、schema 版本不符或必要配置无效时明确失败而不自动修复。
- [x] SQLite 启用外键、WAL 和合理的等待锁超时；测试数据库也由真实迁移建立，不使用内存数据库代替生产事务行为。
- [x] 应用启动、就绪、拒绝新命令和优雅停止拥有可观察状态，第二实例因监听冲突失败，不建立数据库租约或分布式锁。
- [x] 浏览器在 320px、900px 和 1440px 可打开稳定的应用壳，不出现空白、横向溢出或控件重叠；基础样式包含可见焦点和稳定尺寸约束。
- [x] Vitest 可运行纯规则和真实临时 SQLite 测试，Playwright 可启动完整同源应用并从公开 HTTP 与浏览器页面观察行为。
- [x] 自动化覆盖初始化、迁移、自检、重复启动、错误 schema、静态资源缓存、安全响应头及正常优雅停止。


## Comments

### 实现完成：同源应用运行边界

正式应用位于 `apps/songroom`。运行时固定 Node.js 24.21.0 与 pnpm 12.9.1，直接依赖精确锁定；构建产物包含 React SPA、Node ESM 服务端和真实 Drizzle 迁移文件。

数据库由 `db init` 独占创建，`db migrate` 在占用应用监听端口的停机边界执行，`db check` 只读检查版本、迁移哈希与时间戳、表结构、WAL、完整性及外键。普通启动不建库、不迁移、不修复错误 schema。迁移前缺少版本表或版本行也直接拒绝，保持原数据库不变。

Fastify 提供同源健康检查、JSON 状态查询和 SPA。共享 Zod schema 统一请求校验、响应序列化、UUIDv7 及错误契约；公共命令规则包含账号定域、规范摘要、24 小时时限、60 秒未来容差、200/202 重放语义及稳定 409 业务码。具体业务防重记录将随实际命令在受理事务内持久化，本票不引入通用命令入口。

应用壳通过 React Router 与 TanStack Query 展示真实服务状态，使用 Lucide 图标与可见焦点；未放置虚构房间、第二期个人歌单入口或假业务数据。账号认证、房间与受审 Enhanced vendor 实现仍由对应后续票承接，当前没有上游执行入口。

最终验证结果：

- `pnpm install --frozen-lockfile` 与 peer 检查通过。
- `pnpm build` 与前端、服务端及测试代码的 `pnpm typecheck` 通过。
- 完整 Vitest：7 个测试文件、29 项测试通过，覆盖纯规则、真实临时 SQLite、HTTP、重复实例和真实服务进程 SIGTERM。
- 完整 Playwright：6 项测试通过，覆盖 320、900、1440px、无横向溢出、键盘焦点、404 返回、无应用脚本错误、状态读取失败和重试恢复、缓存及安全响应头。
- 编译产物 smoke：`init / migrate / check / health / HTML / SIGTERM` 全部通过。
- 双轴代码评审：Standards 无发现；Spec 发现的迁移前版本缺失问题已修复并经回归与复核关闭，最终无未解决发现。

启动配置与运行步骤见根目录 `README.md`。实际 VPS、可信 HTTPS、Caddy 和 systemd 的生产验收由部署票承担；本票验证结果不代表已经上线。

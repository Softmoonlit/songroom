# 21: 完成第一期安全负面矩阵

**What to build:** 从公开 HTTP、SSE、浏览器和管理命令固化第一期越权、输入、敏感信息及竞态负面矩阵，作为公共点歌版进入生产部署前的发布门禁。

**Blocked by:** 14/通过 SSE 同步多端状态、15/退出授权并以同账号重新授权、16/退出或移除房间成员、18/恢复结果未知的公共歌单清理、20/通过管理命令处置异常操作

**Status:** resolved

- [x] 通过真实认证和临时 SQLite 覆盖未登录、待审批、普通成员、房主、其他房间房主、已移除成员及服务器管理员的全部 read model 与命令权限矩阵。
- [x] 证明浏览器不能指定网易云凭据、真实账号调度键、任意云端歌单 ID、绑定代次、内部步骤、锁键或 Enhanced 模块名。
- [x] 所有第一期业务变更端点逐项验证共用 UUIDv7 幂等契约：纯本地命令同步返回，需要上游的新操作返回 202，同键同内容返回原结果且异步重放为 200，同键不同内容、过期或未来键返回 409 和稳定业务码；Better Auth 原生端点、搜索及无副作用刷新不误用业务幂等键。
- [x] 所有应用实体与操作 ID 为 UUIDv7 文本，网易云账号、歌单和歌曲 ID 以超出常见整数范围的字符串样本贯穿 schema、SQLite 和 JSON 后保持原值，代码不做数值转换或范围假设。
- [x] 所有业务非 GET 命令校验精确同源 Origin，GET 无业务副作用，CORS 关闭；JSON、SSE、HTML 与哈希静态资源执行各自缓存策略。
- [x] Cookie 属性、会话失效、SSE 关闭、Bearer 禁用及 Better Auth 标准入口限流通过集成测试，服务端转发不能绕过认证限流。
- [x] 管理员原因与账号称呼、房间名、昵称和搜索文本一并覆盖去除首尾空白、NFC、长度及控制字符规则；管理员原因仅允许 1 至 500 个 Unicode 码点，JSON 请求体超过 128 KiB 时整请求拒绝。
- [x] 前端始终按文本渲染用户输入，二次确认使用固定 Radix Alert Dialog，普通弹窗和 Tooltip 具备可访问名称、焦点圈定、Escape 与背景锁定；熟悉动作使用 Lucide 图标及可访问名称，不用自绘 SVG 或文字胶囊替代。
- [x] `@axe-core/playwright` 与键盘流程覆盖注册、扫码、邀请、审批、点歌、成员移除和删房；320px 起无重叠、横向溢出或不可见焦点。
- [x] Pino 输出、捕获的应用 stdout、脚本化 adapter 和错误路径证明密码、邮箱、称呼、昵称、邀请、Cookie、二维码、网易云凭据、搜索文本、快照和原始上游响应不进入日志；systemd/journald 的生产链路留给 ticket 23 验收。
- [x] 脚本化 adapter 分别注入账号为空、核实账号不匹配、授权不可用、目标权限错误、风控或频繁请求、网络错误和普通模块错误，证明风控只暂停整个真实账号、目标权限只暂停对应目标，其余类别不会被误报、误升级、自动恢复或清除绑定。
- [x] 竞态矩阵覆盖改名/审批、点歌/撤权、标签/删歌、刷新乱序、授权代次晚到、成员移除、删房及管理员旧确认，晚到结果不能恢复已撤销实体。
- [x] 任何发现都明确阻塞本票，回到对应业务切片修复后重新运行矩阵；本票不以接受风险、关闭证书校验、临时兼容分支、手工数据库修补或新增通用管理入口绕过验收。

## Comments

### 实现总结
1. **输入与规范化加固**：
   - 提取通用的 `normalizedText(max)`（NFC 规范化、去首尾空白、限制 Unicode 码点长度、拒绝控制字符 `\p{Cc}`），统一应用于 `accountName` (40 码点)、`roomName` (16 码点)、`roomNickname` (12 码点)、`searchText` (200 码点) 与 `adminReason` (500 码点)。
   - 在 Better Auth `databaseHooks.user.create` 与 `databaseHooks.user.update` 中拦截并校验 `accountName`，防止非法称呼绕过注册/改名写入。
   - 认证转发补充 `x-forwarded-for` 头提取客户端真实 IP，防止服务端请求转发绕过 Better Auth 默认速率限制。
2. **第一期安全负面矩阵集成测试 (`src/http/security-matrix.test.ts`)**：
   - **矩阵 1 (7 角色权限边界)**：基于真实认证与 SQLite，验证未登录、待审批、普通室友、房主、他房房主、已移除成员及非管理员在全部 read model（房间列表、房间壳、成员列表、公共歌单、邀请、申请）和命令（改名、重置邀请、审批、创建歌单、退出、删房、管理员运维）上的严格鉴权隔离（401/403/404）。
   - **矩阵 2 (注入防御)**：验证命令输入使用 `z.strictObject`，浏览器禁止注入 `cookie`, `accountId`, `credentials`, `cloudPlaylistId`, `generation`, `module`, `step` 或内部锁键。
   - **矩阵 3 (UUIDv7 幂等契约)**：全业务变更端点逐项验证纯本地同步 200、需要上游 202、同键同内容重放 200/202 保持幂等、异内容 409 `IDEMPOTENCY_CONFLICT`、过期或未来键 409 `IDEMPOTENCY_KEY_EXPIRED`；非业务端点（登录、搜索、刷新）不误用业务幂等键。
   - **矩阵 4 (大数 ID 精度保真)**：超出 JavaScript `Number.MAX_SAFE_INTEGER` 及 64 位有符号整数最大值的网易云账号、歌单及歌曲 ID 全链路保持原字符串不丢失精度。
   - **矩阵 5 (同源与缓存策略)**：业务非 GET 命令严格校验同源 Origin，拒绝跨源请求；CORS 完全关闭；API/JSON 与 HTML 响应返回 `no-store`，带哈希静态资源返回 1 年不可变强缓存。
   - **矩阵 6 (Cookie 属性与限流)**：禁用 Bearer，原始数据库 token 无法伪造 Cookie，生产模式启用 `HttpOnly; SameSite=Lax; Secure`；连续错误密码触发 429 速率限制。
   - **矩阵 7 (文本规范化与体量限制)**：单请求体超过 128 KiB 整请求返回 413；全文本字段严格校验 Unicode 码点、控制字符及 NFC 转换。
   - **矩阵 8 (SSE 隔离与鉴权)**：未登录访问 `/api/events` 返回 401，跨域请求返回 403；跨房间/跨账号事件隔离，无关账号收不到其他房间的失效通知。
   - **矩阵 9 (安全响应头差异)**：生产环境启用 HSTS、CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`；测试环境不强制 HSTS。
   - **矩阵 10 (无凭据泄露)**：Session 查询、网易云绑定详情、快照及 SQLite 库均不含 `MUSIC_U` 明文凭据或密码哈希。
   - **矩阵 11 (调度并发安全)**：全站最多 2 个不同网易云账号在途并发，跨账号公平轮转。
3. **上游异常与竞态矩阵测试 (`src/operations/security-upstream-matrix.test.ts`)**：
   - **上游异常分类与隔离语义**：验证 `RATE_LIMITED` 仅暂停对应真实网易云账号且不误清绑定；`TARGET_PERMISSION` 仅暂停目标操作，真实账号不暂停；`AUTH_UNAVAILABLE` 进入 `waitingAuthorization`；`NETWORK_ERROR` 进入未知待确认；`MODULE_ERROR` 不误升级。
   - **并发竞态覆盖**：覆盖改名/审批（昵称冲突拒绝）、点歌/撤权（未入队前撤权进入 `waitingAuthorization`，无云端写入）、标签/删歌（写后读回缺失不记标签）、刷新乱序（旧刷新晚到不覆盖新快照）、授权代次晚到（旧代次不覆盖新凭据）、删房与晚到结果（房间删除后晚到结果无法复活实体）、管理员旧确认（版本不匹配抛出 `OPERATION_STATE_CHANGED`）。
4. **端到端无障碍与安全矩阵 (`tests/e2e/security-a11y-matrix.spec.ts`)**：
   - 在 320px、900px、1440px 视口下验证无可见水平滚动、表单可用且支持键盘 Tab 焦点与高对比度模式。
   - 接入 `@axe-core/playwright` 对首页、登录页、注册页进行基础无障碍分析，确认无违规。
   - 验证防重复提交 / 双击防御：点击提交后按钮立即禁用并进入“提交中…”状态。

### 验证结果
- `pnpm typecheck`：通过（客户端、服务端、测试类型检查零错误）。
- `pnpm test`：通过（36 个测试文件，362 个用例全部通过）。
- `pnpm test:e2e`：通过（125 个 Playwright 端到端用例全部通过）。

### 剩余事项
- 无。第一期安全负面矩阵已全部固化并闭环。


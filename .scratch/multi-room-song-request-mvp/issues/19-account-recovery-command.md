# 19: 通过管理命令恢复点歌台账号

**What to build:** 让服务器管理员在线下核实用户身份后，通过具权 HTTPS 会话为原点歌台账号设置新密码并撤销其全部旧会话，而不建设邮件找回或绕过 Better Auth。

**Blocked by:** 02/完成点歌台账号闭环

**Status:** resolved

- [x] 首个管理员只通过 Better Auth 的受限 `adminUserIds` 配置声明：操作员先正常注册并经鉴权取得本人用户 ID，不能直接修改认证数据库授予权限。
- [x] 管理命令只连接配置的浏览器可信 HTTPS 入口，发送精确可信 Origin，不关闭证书校验，也不提供明文 HTTP 或不安全 loopback Cookie 例外。
- [x] 使用固定 `@inquirer/prompts` 从 TTY 隐藏读取管理员邮箱和密码；非 TTY、取消、信号中断或无法隐藏输入时安全退出且不执行变更。
- [x] 使用规格固定的 `tough-cookie` 与 `fetch-cookie` 管理 Cookie jar，完成标准邮箱登录、当前会话核验和后续管理请求；不接受粘贴 Cookie、Bearer token 或 SSH 身份作为管理员鉴权。
- [x] 恢复前要求管理员填写已通过既有线下渠道核实的目标和原因；原因去除首尾空白、规范为 Unicode NFC、拒绝控制字符且为 1 至 500 个码点，仅凭登录邮箱、房间昵称或邀请不足以自动证明身份。
- [x] 设定新密码和撤销目标账号全部会话分别调用 Better Auth 原生接口并分别显示、记录结果；任一步失败不得假报完整恢复。
- [x] 不实现临时密码首次强制改密、邮件找回、自定义密码表或直接数据库设密。
- [x] 命令完成或失败后主动退出本次管理员 CLI 会话并清空内存 Cookie 与密码材料，不将凭据、Cookie、新密码或目标邮箱写入日志。
- [x] 最小审计保存管理员内部标识、目标内部标识、动作、原因、时间和两个原生步骤结果，不保存密码或会话值。
- [x] 完整 HTTP 测试覆盖具权成功、无权管理员、错误密码、证书/Origin 错误、非 TTY、设密成功但撤销失败、旧会话失效和新密码登录。

## Comments

### 实现说明

1. **Better Auth 原生管理员集成与端点收敛**：
   - 配置引入 `adminUserIds`（默认为空数组），在 `auth.ts` 中注册 Better Auth 官方 `admin` 插件。
   - 在 Fastify `/api/auth/*` 中建立严格白名单路由限制，仅允许访问规范要求的原生设密 (`/api/auth/admin/set-user-password`) 与会话撤销 (`/api/auth/admin/revoke-user-sessions`) 接口，其余管理接口（用户列表、封禁、角色设置、冒充等）均返回 404，严格杜绝 scope creep。
2. **交互式管理 CLI (`AdminClient` / `runAccountRecovery` / `runAdminWhoami`)**：
   - 依赖固定包 `@inquirer/prompts@8.7.3`、`tough-cookie@6.0.2`、`fetch-cookie@3.2.0`。
   - 严格要求交互式 TTY 环境，非 TTY 环境安全退出，不进行网络或数据库操作。
   - 协议强制要求浏览器可信 HTTPS 入口，严格验证 TLS 证书，禁止明文 HTTP。发送请求一律携带配置的精确可信 `origin`。
   - 针对核实原因执行 Unicode NFC 规范化、去除首尾空白、过滤控制字符（`\p{Cc}`）并限制 1 到 500 个码点；密码限制 8 到 128 字符。
   - 采用标准邮箱密码登录与会话核验，确认该用户属于配置的受限管理员；分别执行设密与撤销会话，两步结果独立核验，任一步失败绝不假报完整恢复。
   - 顶层 `try ... finally` 保证在成功、失败、异常或退出后，均向服务端发送 `sign-out` 注销 CLI 具权会话，并彻底清空内存 CookieJar、密码及凭据材料。
3. **最小数据库审计与迁移**：
   - 新增 `admin_audit_log` 表（schema 版本 19，迁移 `0018_admin_audit_log.sql`），记录管理员 ID、目标用户 ID、动作、原因、两步执行结果与时间戳。严格不含密码明文、哈希、Cookie、Token 或邮箱等敏感信息。
   - 审计写入失败显式报错，防止假报成功。
4. **统一命令调度与文档更新**：
   - `cli.ts` 调度 `admin whoami` 和 `admin recover-account`，支持 `pnpm admin:whoami` 与 `pnpm admin:recover`。
   - 示例配置 `songroom.config.example.json` 与 `README.md` 同步补充操作与安全约束说明。

### 验证结果

- **类型检查**：`pnpm typecheck` 全部通过。
- **单元与 HTTP 测试**：`pnpm test` 全套 33 个测试文件、327 项测试全部通过，包括：
  - 规范化、控制字符过滤、长度边界校验；
  - 非 TTY、明文 HTTP、自签名不受信证书拦截；
  - 错误密码、未配置管理员账号、目标不存在等边界；
  - 原生设密成功但撤销会话失败时的部分完成报告与审计记录；
  - 具权管理员成功恢复目标密码、旧会话失效、新密码登录及最小审计验证；
  - 未白名单开放管理端点 404 拦截、审计写入失败显式报错、CLI 会话服务端 sign-out 及精确 Origin 验证。
- **E2E 浏览器测试**：`pnpm test:e2e` 120 项 Playwright 测试全部通过。
- **构建测试**：`pnpm build` 顺利产出客户端产物与服务端编译代码。
- **代码审查**：通过 `code-review` 技能完成两轴审查并闭环全部反馈。

### 剩余事项

无。

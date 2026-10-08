# SongRoom 点歌台

同源 TypeScript 应用：Fastify 提供 JSON、健康检查和 Vite 构建的 React SPA，SQLite 使用真实文件与 WAL。当前支持点歌台账号认证、账号设置、安全扫码绑定网易云，以及创建、列出和进入房间；邀请审批与公共点歌由后续工单实现。

## 本地运行

使用 Node.js **24.21.0** 与 pnpm **12.9.1**。运行时检查和 `engine-strict` 会拒绝其他 Node.js 版本。所有直接依赖精确锁定，安装时使用锁文件。

```bash
pnpm install --frozen-lockfile
cp songroom.config.example.json songroom.config.json
chmod 600 songroom.config.json
install -d -m 700 private
(umask 077; openssl rand -out private/netease-credentials.key 32)
export SONGROOM_CONFIG="$PWD/songroom.config.json"
pnpm db:init
pnpm db:check
pnpm build
pnpm start
```

浏览器打开 `http://127.0.0.1:3000`。`SONGROOM_CONFIG` 只指定配置文件路径；配置中的路径以配置文件目录为基准。配置文件必须由当前用户持有，仅当前用户可读写。普通启动缺少配置、数据库、正确 schema 或客户端构建产物时失败，不会初始化、迁移、生成密钥或返回空白页面。

生产入口必须配置精确 HTTPS origin，应用只监听 `127.0.0.1` 并仅信任本机代理。公网 Caddy、可信证书、systemd 和真实机器资源由部署工单验收，本地运行通过不代表可以上线。数据库、私有配置、凭据密钥和运行临时目录须放在静态资源目录之外。`credentialKeyPath` 指向当前用户持有、权限为 0600 或 0400 的独立 32 字节二进制主密钥文件；禁止重新生成或替换已有密钥。密钥缺失、权限错误及已有凭据无法解密时启动失败。`authSecret` 保存在受限配置文件中，两类密钥均不得放入环境变量或命令行。

## 生产部署与运维

SongRoom 第一期生产运行包采用单台公网 VPS 单体架构，由 systemd 保证唯一应用进程，Caddy 作为唯一公网入口：
- **生产配置与单元文件**：
  - `deploy/systemd/songroom.service`：受限专用系统用户（`songroom`）与 systemd 安全沙箱（`NoNewPrivileges`、`ProtectSystem=strict`、目录权限隔离、35 秒优雅停机上限）。
  - `deploy/systemd/songroom-journald.conf`：本机结构化日志限量保留配置（上限 100 MiB、最长保留 7 天、速率限制）。
  - `deploy/caddy/Caddyfile`：公网可信 HTTPS 入口反向代理，提供浏览器默认受信任证书自动签发与续期、128 KiB 请求体限制及代理头传递。
  - `deploy/songroom.config.production.json`：生产私有配置文件基准模板。
- **精简运维清单与操作手册**：
  - 完整的部署初始化、服务启停与排空、前后端原子发布升级、管理员声明、线下账号恢复、异常任务处置、原账号手工清理核验、风控恢复、密钥缺失处置及数据库灾难边界，详见 [`docs/operations.md`](docs/operations.md)。

## 数据库维护

`pnpm db:init` 独占创建数据库并应用仓库中的 Drizzle 迁移，重复初始化拒绝覆盖。`pnpm db:migrate` 只显式迁移已有数据库；命令先占用与应用相同的回环端口，应用运行中或端口占用时拒绝执行。迁移期间应保持 systemd 停止；不增加数据库租约或分布式锁。

`pnpm db:check` 只读检查迁移记录、schema、数据库完整性及 WAL；它不会创建数据库或修改业务状态。生产环境可以直接使用编译后的命令：

```bash
node apps/songroom/dist/cli.js db check
node apps/songroom/dist/cli.js db migrate
```

普通启动只打开已有数据库并校验，外键和锁等待超时在每个运行连接上启用。不要把数据库初始化当作数据丢失后的自动恢复。

## 账号恢复与管理命令

SongRoom 采用 Better Auth 原生密码认证，不提供公网邮件找回或临时密码改密。用户遗忘密码时，由管理员线下充分核实身份后，通过交互式管理 CLI 调用 Better Auth 原生设密与会话撤销接口完成恢复。

### 管理员声明与核验

管理员权限不通过直接修改数据库授予，而通过配置文件中的 `adminUserIds` 受限白名单声明：
1. 操作员先在点歌台正常注册账号。
2. 运行管理员身份核验命令，输入本人邮箱与密码：
   ```bash
   pnpm admin:whoami
   # 生产环境：
   node apps/songroom/dist/cli.js admin whoami
   ```
3. 取得本人内部用户 ID（User ID）后，写入 `songroom.config.json` 的 `adminUserIds` 数组，并重启服务。

### 线下账号恢复流程

在交互式终端中执行账号恢复命令：
```bash
pnpm admin:recover
# 或：
node apps/songroom/dist/cli.js admin recover-account
```

**操作与安全约束：**
- **交互终端限制**：命令必须在交互式 TTY 终端中运行；非 TTY 或批处理环境自动安全退出且不执行任何变更。
- **协议与证书**：只连接配置中经过浏览器可信验证的 HTTPS 入口，严格执行 TLS 证书校验，拒绝明文 HTTP。
- **线下核实原因**：输入 1 到 500 字符的核实原因，系统自动规范化为 Unicode NFC 并剔除控制字符。
- **目标与密码**：输入目标用户内部标识（User ID）及 8 到 128 字符的新密码，终端使用掩码输入，确认后才执行。
- **双接口原子与分别核验**：先调用原生 `setUserPassword` 设置新密码，成功后再调用原生 `revokeUserSessions` 撤销该账号全部已有会话；任何一步失败均如实反馈，绝不假报完整恢复。
- **最小数据库审计**：向数据库 `admin_audit_log` 写入本次恢复的管理员 ID、目标用户 ID、操作原因及各步骤结果；日志严格不包含密码明文、哈希、Cookie、Token 或邮箱等敏感信息。
- **临时凭据注销**：恢复完成后，CLI 自动调用 `sign-out` 撤销本次管理命令会话，并彻底清空内存 Cookie 与密码数据。

## 开发和验证

```bash
pnpm typecheck
pnpm --filter @songroom/app test src/commands/commands.test.ts
pnpm test
pnpm --filter @songroom/app exec playwright install chromium
pnpm test:e2e
```

Vitest 覆盖公开规则、真实临时 SQLite 和同源 HTTP。Playwright 独立初始化临时数据库并启动完整应用，检查 320、900、1440px 的布局、键盘焦点、浏览器错误和 HTTP 行为。浏览器测试启动器只注入离线脚本化网易云 adapter，注册、授权确认、建房和查询仍走真实同源接口；不会访问真实网易云，测试数据不会进入生产数据库。

`/healthz` 无副作用，就绪返回 200，启动或排空返回 503。`/api/status` 返回共享 Zod 契约的运行状态。应用成功监听后才切换到就绪；第二实例因端口冲突失败。SIGINT/SIGTERM 进入排空、拒绝新变更请求、等待 HTTP 完成并关闭数据库。

HTML 与 JSON 使用 `no-store`；Vite 内容哈希资产由 `@fastify/static` 提供一年 immutable 缓存，标准安全头由 `@fastify/helmet` 提供。普通日志只记录请求关联 ID、路由模板、状态、耗时和稳定错误码，未来生产由 journald 限量保存。

## 后续实现约束

端点使用共享 Zod schema 推导类型，Fastify 薄适配统一校验与序列化。业务实体、操作和幂等键使用 UUIDv7；Better Auth 账号标识与网易云标识保持不透明字符串。命令规则按点歌台账号定域，以规范内容摘要识别重放：本地新命令 200，异步新命令 202，重放 200，内容冲突或超过 24 小时及超过一分钟未来偏差的键 409。具体业务命令必须在其受理事务中查询并保存最小防重记录，不增加通用命令 HTTP 入口或通用任务载荷。扫码流程属于短命授权资源：相同标识只读取原流程，原流程过期、被替代、启动失败或重启丢失后返回不可用；防重记录保留到标识自身的 24 小时有效期结束，禁止重新创建流程。

## 房间工作区

完成网易云绑定后，在“我的房间”选择“创建房间”，填写房间名和自己的房间昵称，确认页面显示的网易云身份后提交。服务端重新核实授权身份，在一个 SQLite 事务内检查容量并创建房间、房主成员和邀请；建房不创建云端歌单。房间名可重复，昵称去除首尾空白并规范为 NFC，同房间唯一且区分大小写。

每账号最多自建 3 个房间、归属 10 个房间，全站最多 20 个房间。达到上限拒绝新增，保留已有数据。房间列表和成员查询仅按当前会话的服务端成员关系返回可见数据；不会返回账号邮箱、真实房主账号或完整邀请。

进入房间默认打开“公共歌单”，当前一级入口只有“公共歌单”“房间成员”“房间设置”。宽屏固定侧栏，窄屏固定底部三栏；每个入口在当前房间内存中保留页面与滚动位置，重按当前入口回顶，离开房间后清除。虚拟键盘行为在自动化中模拟公开 viewport 事件，真实手机验收由部署工单承接。当前可查看成员昵称与角色，改房间名、成员身份管理和邀请审批由后续票实现。

已有数据库升级本版本前须停止应用并执行 `pnpm db:migrate`，本版 schema 版本为 5。

## 网易云首次绑定

登录后进入“账号设置”，开始扫码，用网易云 App 授权后点击“检查扫码状态”。页面展示服务端核实的真实账号 ID 与昵称，点击确认才保存授权。二维码有效期为五分钟，同账号新流程立即替代旧流程；读取、检查及完成都要求原 Better Auth 会话有效。浏览器只能提交操作标识，不能提交凭据、真实账号 ID 或授权代次。

一个点歌台账号只能绑定一个网易云账号，同一真实账号不能归属两个点歌台账号。已绑定后本版本不提供退出授权、重新授权或换号入口。授权凭据以 AES-256-GCM 逐条加密，绑定 ID、真实账号 ID 与凭据代次参与认证；临时二维码与未确认候选凭据不持久化，重启后须新开扫码流程，旧操作标识不会再次执行。

受审 vendor 位于 `packages/vendor/netease-cloud-music-api-enhanced`，固定 4.40.1 与源码 `a8c781fd64faab17fedfd46e0615a2609307f163`。仓库只保留批准能力所需源码，附许可证、来源、上游锁与生产补丁完整性记录；应用启动及调用前检查完整性，构建只复制仓库内文件。每次调用使用独立 CommonJS 子进程、0700 私有临时目录、最小环境、显式 Cookie 和 25 秒硬截止，原始 stdout/stderr 丢弃，结果经 IPC schema 校验。部署不下载替代源码。

离线契约用真实固定 vendor、请求层与隔离 worker 验证单次写入、错误分类和进程隔离。浏览器测试验证扫码交互；完整 HTTP 测试使用真实 Better Auth 与 SQLite 验证授权边界。真实网易云与目标 VPS 的验收由后续部署工单完成。

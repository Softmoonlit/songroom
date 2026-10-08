# SongRoom 第一期生产运行与运维手册

本文档为平台运营者提供在单台公网 VPS 上部署、初始化、自检、启停、升级及处置异常的完整操作规范与精简运维清单。

---

## 1. 架构与安全运行基线

- **单实例长期进程**：生产使用 systemd 管理唯一长期 Node.js 应用进程，同进程包含 HTTP 服务、持久操作状态机与上游调度协调；严禁使用 Docker、多实例并发、独立 worker 服务、数据库租约或自动故障切换。
- **公网入口与网络隔离**：应用仅监听本机回环地址 `127.0.0.1:3000`，不直接向公网暴露端口；Caddy 作为唯一步入公网的反向代理，负责提供浏览器默认受信任的 HTTPS、精确 Origin、代理信任（`trustProxy: ["127.0.0.1"]`）与自动证书续期。
- **目录与权限受限隔离**：
  - 代码与前端资产：`/opt/songroom/current`（只读，属主 root/songroom）
  - 持久化数据库：`/var/lib/songroom/data/songroom.sqlite`（读写，严格 0600，属主 songroom）
  - 私有凭据主密钥：`/var/lib/songroom/private/netease-credentials.key`（只读，严格 0400，属主 songroom）
  - 生产私有配置文件：`/etc/songroom/config.json`（只读，严格 0600 或 0400，属主 songroom）
  - 运行时临时工作目录：`/run/songroom`（读写，0700，属主 songroom，由 systemd `RuntimeDirectory` 维护并映射 `TMPDIR`）
  - **静态资源隔离**：数据库、密钥文件与运行临时目录必须严格位于前端静态资源目录（`staticRoot`）之外，禁止使用符号链接。应用系统用户在运行期只拥有持久数据目录（`/var/lib/songroom/data`）与运行临时目录（`/run/songroom`）的写权限，代码、配置及密钥目录均为只读挂载。
- **密钥保管规则**：凭据主密钥（32 字节二进制）与 Better Auth 签名密钥（32 字符以上字符串）必须稳定保存在独立受限私有文件与配置文件中，严禁进入环境变量、命令行参数、代码仓库、数据库或日志输出。
- **日志与审计边界**：应用结构化日志输出至 stdout，由 systemd/journald 本机限量轮转（服务级限速每 30 秒 1000 条，journald 可配上限 100 MiB、最长保留 7 天），不外接第三方日志平台；密码、凭据、Cookie、二维码、搜索词、导入文本与原始上游响应严禁写入日志。高风险管理操作另行记录在数据库 `admin_audit_log` 审计表中。

---

## 2. 精简运维清单（10 类场景处置）

### 场景一：系统初始化（首次部署）

#### 1. 创建专用受限系统用户与运行目录
```bash
# 创建无登录权限的专用系统用户 songroom
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/songroom songroom

# 创建发布根目录并授予权限
sudo install -d -o songroom -g songroom -m 0755 /opt/songroom
sudo install -d -o songroom -g songroom -m 0755 /opt/songroom/releases

# 创建持久数据与私有密钥目录，严格限制权限为 0700
sudo install -d -o songroom -g songroom -m 0700 /var/lib/songroom
sudo install -d -o songroom -g songroom -m 0700 /var/lib/songroom/data
sudo install -d -o songroom -g songroom -m 0700 /var/lib/songroom/private

# 创建配置目录，权限为 0750
sudo install -d -o root -g songroom -m 0750 /etc/songroom
```

#### 2. 生成密钥文件与凭据配置
```bash
# 生成 32 字节网易云凭据主密钥，权限严格设为 0400（只读），由运行用户持有
sudo sh -c 'umask 077 && openssl rand -out /var/lib/songroom/private/netease-credentials.key 32'
sudo chown songroom:songroom /var/lib/songroom/private/netease-credentials.key
sudo chmod 400 /var/lib/songroom/private/netease-credentials.key

# 生成 Better Auth 签名密钥字符串
AUTH_SECRET=$(openssl rand -base64 32)

# 配置生产应用文件 /etc/songroom/config.json（使用 sudo tee 保证提权写入）
sudo tee /etc/songroom/config.json > /dev/null <<EOF
{
  "nodeEnv": "production",
  "host": "127.0.0.1",
  "port": 3000,
  "baseUrl": "https://songs.example.com",
  "dbPath": "/var/lib/songroom/data/songroom.sqlite",
  "staticRoot": "/opt/songroom/current/apps/songroom/dist/client",
  "authSecret": "${AUTH_SECRET}",
  "credentialKeyPath": "/var/lib/songroom/private/netease-credentials.key",
  "adminUserIds": []
}
EOF

sudo chown songroom:songroom /etc/songroom/config.json
sudo chmod 600 /etc/songroom/config.json
```

#### 3. 首次源码构建与发布
```bash
FIRST_RELEASE="/opt/songroom/releases/initial"
sudo -u songroom git clone --depth 1 https://github.com/Softmoonlit/songroom.git "${FIRST_RELEASE}"
cd "${FIRST_RELEASE}"
sudo -u songroom pnpm install --frozen-lockfile
sudo -u songroom pnpm build
sudo -u songroom pnpm test

# 软链接至 current
sudo ln -sfn "${FIRST_RELEASE}" /opt/songroom/current
```

#### 4. 显式建库与只读自检
```bash
# 显式初始化数据库（独占监听端口，写入 schema 与基准迁移）
sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js db init

# 执行只读数据库自检（校验完整性、WAL 模式、外键、文件权限 0600 及 schema 事实）
sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js db check
```

#### 5. 配置 Caddy 与 systemd
```bash
# 部署 Caddyfile 并重载 Caddy
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
# 将 Caddyfile 中的 {$SONGROOM_DOMAIN} 配置为真实生产域名
sudo systemctl reload caddy

# 部署 systemd 限量轮转配置（可选：在 VPS 级别设置日志上限）
sudo cp deploy/systemd/songroom-journald.conf /etc/systemd/journald.conf.d/songroom.conf
sudo systemctl restart systemd-journald

# 部署 systemd 服务单元
sudo cp deploy/systemd/songroom.service /etc/systemd/system/songroom.service
sudo systemctl daemon-reload
sudo systemctl enable --now songroom
```

---

### 场景二：服务启停与排空（Start, Stop & Draining）

- **启动服务**：
  ```bash
  sudo systemctl start songroom
  ```
- **检查运行状态与健康检查**：
  ```bash
  sudo systemctl status songroom
  curl -fsS http://127.0.0.1:3000/healthz
  # 预期输出：{"status":"ready","service":"songroom","schemaVersion":20}
  ```
- **优雅停机（Drain）**：
  ```bash
  sudo systemctl stop songroom
  ```
  - **停机过程机制**：
    1. systemd 发送 `SIGTERM` 信号。
    2. 应用进入 `draining` 状态，HTTP 拦截器对所有新业务变更命令直接返回 `503 APP_DRAINING`。
    3. 上游调度器立即停止（`scheduler.stop()`），拒绝新任务派发；歌单服务清除补查计时器（`playlists.stop()`）；关闭 SSE 连接与扫码流程。
    4. Fastify 停止接收新连接，排空在途 HTTP 请求。
    5. 调度器与适配器最多等待当前在途的 25 秒 Enhanced 子进程执行完成（`scheduler.settle()`）。
    6. systemd `TimeoutStopSec=35s` 与进程内部 35 秒安全兜底定时器确保总停机时间不超过 35 秒。
    7. 若子进程在发送步骤被中断终止，下一次重启时按可能已发送只读确认，绝不重新重发。
- **实时日志查看**：
  ```bash
  journalctl -u songroom -f
  ```

---

### 场景三：升级检查与前后端原子发布（Atomic Release）

为保证升级期间前后端产物一致且数据库不发生并发损坏，发布遵循标准原子发布流程。

> **提示（低内存 VPS 建议）**：若服务器内存较低（如 2GB 以下且常驻其他服务），在服务器本地运行 `pnpm build`（Vite + tsc）易触发内存耗尽（OOM）。推荐采用**本地构建产物直接同步**（方案 A）；若服务器内存充裕可采用**服务端从源码构建**（方案 B）。

#### 方案 A：本地构建产物同步发布（低内存环境推荐，0 编译开销）

```bash
# 1. 本地机（配置充裕）执行编译
pnpm build

# 2. 远端服务器初始化新版本目录并复用依赖（硬链接秒级完成，零冗余磁盘开销）
RELEASE_TAG=$(date +%Y%m%d%H%M%S)
TARGET_DIR="/opt/songroom/releases/${RELEASE_TAG}"
ssh aliyun "
mkdir -p \"${TARGET_DIR}/apps/songroom\" \"${TARGET_DIR}/packages/netease-vendor\"
if [ -d /opt/songroom/releases/initial/node_modules ]; then
  cp -al /opt/songroom/releases/initial/node_modules \"${TARGET_DIR}/\"
fi
if [ -d /opt/songroom/releases/initial/apps/songroom/node_modules ]; then
  cp -al /opt/songroom/releases/initial/apps/songroom/node_modules \"${TARGET_DIR}/apps/songroom/\"
fi
if [ -d /opt/songroom/releases/initial/packages/netease-vendor/node_modules ]; then
  cp -al /opt/songroom/releases/initial/packages/netease-vendor/node_modules \"${TARGET_DIR}/packages/netease-vendor/\" || true
fi
"

# 3. 同步源码与编译好的 dist 产物至服务器
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.scratch' --exclude='apps/songroom/tests' ./ root@aliyun:${TARGET_DIR}/
ssh aliyun "chown -R songroom:songroom ${TARGET_DIR}"

# 4. 停机保证独占，执行数据库迁移与只读自检
ssh aliyun "
sudo systemctl stop songroom
sudo -H -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node \"${TARGET_DIR}/apps/songroom/dist/cli.js\" db migrate
sudo -H -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node \"${TARGET_DIR}/apps/songroom/dist/cli.js\" db check

# 5. 原子切换软链接并恢复启动
sudo ln -sfn \"${TARGET_DIR}\" /opt/songroom/current
sudo systemctl start songroom
curl -fsS http://127.0.0.1:3000/healthz
"
```

#### 方案 B：服务端直接构建发布（服务器内存 4GB+ 适用）

```bash
RELEASE_TAG=$(date +%Y%m%d%H%M%S)
TARGET_DIR="/opt/songroom/releases/${RELEASE_TAG}"

# 1. 源码核验与构建
sudo -u songroom git clone --depth 1 https://github.com/Softmoonlit/songroom.git "${TARGET_DIR}"
cd "${TARGET_DIR}"
sudo -u songroom pnpm install --frozen-lockfile
sudo -u songroom pnpm build
sudo -u songroom pnpm test

# 2. 停机保证独占
sudo systemctl stop songroom

# 3. 显式离线数据库迁移与自检
sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node "${TARGET_DIR}/apps/songroom/dist/cli.js" db migrate
sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node "${TARGET_DIR}/apps/songroom/dist/cli.js" db check

# 4. 原子切换软链接（保证前端 assets 与后端 dist 原子生效）
sudo ln -sfn "${TARGET_DIR}" /opt/songroom/current

# 5. 启动服务并验证健康
sudo systemctl start songroom
curl -fsS http://127.0.0.1:3000/healthz
```

---

### 场景四：管理员初始化（Admin Initialization）

SongRoom 不设公网管理后台，管理员身份通过受限配置文件中的 `adminUserIds` 白名单声明：

1. 运维人员在点歌台网页前台正常注册一个日常点歌台账号。
2. 登录目标 VPS，在交互式终端中运行身份核验命令：
   ```bash
   sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin whoami
   ```
3. 按照提示输入刚注册的邮箱与密码，获取本人的内部唯一用户标识（例如：`usr_0194abc...`）。
4. 将该标识填入 `/etc/songroom/config.json` 的 `adminUserIds` 数组中：
   ```json
   "adminUserIds": ["usr_0194abc..."]
   ```
5. 重启服务使白名单生效：
   ```bash
   sudo systemctl restart songroom
   ```

---

### 场景五：线下账号人工恢复（Account Recovery）

当用户遗忘密码且无法登录时，管理员在线下核实身份后通过服务器命令行重设密码：

1. **线下充分核验**：通过既定线下渠道核验申请人身份，获取申请人邮箱及至少 1 到 500 字符的核实凭据/原因说明。
2. **交互终端执行恢复命令**：
   ```bash
   sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin recover-account
   ```
3. **交互操作约束**：
   - 命令必须在交互式 TTY 终端执行，批处理或重定向输入自动拒绝。
   - 输入管理员邮箱与密码完成鉴权。
   - 输入线下核验原因（系统自动执行 Unicode NFC 规范化并剔除控制字符）。
   - 输入目标用户的内部用户 ID（User ID）及新密码（终端掩码输入）。
4. **两步原子核验与审计**：
   - CLI 依次调用原生 `setUserPassword` 设置新密码，并调用 `revokeUserSessions` 撤销该账号在所有设备上的已有会话。
   - 操作结果写入 `admin_audit_log` 审计表（严格不记录密码明文、哈希或 Token）。
   - CLI 退出时自动调用 `sign-out` 注销本次管理会话并清理内存凭据。

---

### 场景六：异常操作处置（Abnormal Operations Handling）

当歌曲写入、同步或专用歌单创建因上游网络中断或超时长期停留在待处理状态时，管理员可按权限核查并终结：

1. **列出当前异常操作**：
   ```bash
   sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal list
   ```
2. **查看具体操作详情与上下文**：
   ```bash
   sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal show <operationId>
   ```
3. **终结普通写入/同步未知操作（resolve-write）**：
   - 当普通歌曲点歌/增删写入超过 3 轮补查仍无法查明结果时，管理员确认网易云端状态后执行：
     ```bash
     sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal resolve-write <operationId>
     ```
   - 系统将该操作终结为“结果未能确认”，解除房间队列阻塞；**严禁盲目自动重试或自动重新补发**。
4. **核查创建未知操作（resolve-create）**：
   - 公共歌单新建请求发出但未收到返回 ID 时，核对云端歌单是否存在：
     ```bash
     sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal resolve-create <operationId>
     ```
   - 若云端已创建成功则完成绑定；若确实未创建则停止该任务，由房主重新发起新建。
5. **授权专用删除新尝试（authorize-cleanup）**：
   - 专用歌单删除重试失败时，核实原专用歌单仍存活且仍应清理后，授权一次新的删除尝试：
     ```bash
     sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal authorize-cleanup <cleanupId>
     ```

---

### 场景七：原账号手工清理核验（Manual Cloud Cleanup Verification）

当网易云端明确拒绝删除专用歌单（如因版权保护或风控限制），房主可在官方网易云 App 内手动删除该歌单，随后由管理员执行核验：

1. 房主在网易云官方客户端手动删除专用歌单。
2. 管理员执行手工清理核验命令：
   ```bash
   sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal verify-cleanup <cleanupId>
   ```
3. 服务端再次读取原账号歌单列表，核实该歌单 ID 已彻底消失后，终结该清理任务并释放记录。

---

### 场景八：网易云风控暂停与恢复（Risk Control Resumption）

当网易云接口对某账号返回频繁请求或风控限制时，调度器自动将该账号标记为 `ACCOUNT_PAUSED`，停止该账号后续上游派发：

1. 确认冷却期已过（建议等待 30 分钟以上，或在官方客户端确认账号状态恢复正常）。
2. 执行风控恢复命令：
   ```bash
   sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal resume-risk <accountId>
   ```
3. 调度器恢复对该网易云账号的任务调度。

---

### 场景九：密钥缺失或损坏处置（Secret Key Loss / Inaccessibility）

- **启动期自检拦截**：若凭据密钥文件缺失、属主非运行用户、权限非 0600/0400 或文件大小不等于 32 字节，应用在启动前自检阶段直接报错退出，**严禁静默生成新密钥掩盖问题**。
- **解密失败保护**：在应用启动时，授权模块会自动核验所有已保存的授权凭据密文。若密钥被篡改导致无法解密，系统自动将受影响授权置为 `waitingAuthorization`，相关上游功能停止，但**绝不删除房间、成员、已有快照或未解决任务**。
- **灾难换密钥恢复流程**：
  1. 若旧 32 字节主密钥彻底丢失且无备份，重新生成一份全新的 32 字节主密钥并赋予正确只读权限：
     ```bash
     sudo sh -c 'umask 077 && openssl rand -out /var/lib/songroom/private/netease-credentials.key 32'
     sudo chown songroom:songroom /var/lib/songroom/private/netease-credentials.key
     sudo chmod 400 /var/lib/songroom/private/netease-credentials.key
     ```
  2. 重启服务：`sudo systemctl restart songroom`。
  3. 启动后旧密文无法解密，对应授权进入 `waitingAuthorization`。通知各房间房主登录点歌台网页端，在“账号设置”中使用**原真实网易云账号**重新扫码授权。
  4. 重新授权成功后，服务端自动用新密钥加密保存新凭据，并自动唤醒该房主名下此前因凭据不可用而暂停的所有未解决任务。

---

### 场景十：数据库文件丢失处置（Database Loss Boundary）

- **无静默建库**：若 `/var/lib/songroom/data/songroom.sqlite` 数据库文件丢失，应用启动时自检直接失败（退出码 1，报 `ENOENT` / `DB_NOT_FOUND`），**绝不静默自动创建空数据库**。
- **无备份边界**：首版单机 MVP 明确不承诺磁盘损坏或物理误删后的本地业务数据自动恢复。
- **全损恢复步骤**：
  1. 确认底层磁盘与系统环境恢复正常。
  2. 管理员显式执行基线建库：
     ```bash
     sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js db init
     ```
  3. 执行只读自检：
     ```bash
     sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js db check
     ```
  4. 重启应用：`sudo systemctl restart songroom`。
  5. **严禁凭网易云歌单名称手工猜测房间归属或恢复旧绑定**；所有用户重新注册账号、重新授权网易云并重新创建房间。

---

## 3. 运维验收命令速查

| 操作意图 | 命令 | 说明 |
| :--- | :--- | :--- |
| 服务启动 | `sudo systemctl start songroom` | 启动单实例服务 |
| 服务停止 | `sudo systemctl stop songroom` | 优雅停机排空（上限 35s） |
| 服务重启 | `sudo systemctl restart songroom` | 停机后重新启动 |
| 实时日志 | `journalctl -u songroom -f` | 查看 journald 轮转日志 |
| 健康检查 | `curl -fsS http://127.0.0.1:3000/healthz` | 就绪返回 200，排空中返回 503 |
| 运行状态 | `curl -fsS http://127.0.0.1:3000/api/status` | 查询服务状态与 schema 版本 |
| 离线自检 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js db check` | 只读检查数据库与 schema 事实 |
| 离线迁移 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js db migrate` | 独占端口执行数据库迁移 |
| 管理员查询 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin whoami` | 交互式查询本人用户 ID |
| 账号密码重设 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin recover-account` | 线下核实后交互式重设密码 |
| 异常操作列表 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal list` | 查看积压或待确认操作 |
| 异常操作详情 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal show <id>` | 查看特定异常操作上下文 |
| 未知写入终结 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal resolve-write <id>` | 终结为未能确认，解除阻塞 |
| 创建未知核验 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin abnormal resolve-create <id>` | 核查云端歌单并绑定或停止 |
| 授权清理重试 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin authorize-cleanup <id>` | 重新授权一次专用歌单删除 |
| 手工清理核验 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin verify-cleanup <id>` | 核验用户在官方 App 删除结果 |
| 账号风控恢复 | `sudo -u songroom SONGROOM_CONFIG=/etc/songroom/config.json node /opt/songroom/current/apps/songroom/dist/cli.js admin resume-risk <accountId>` | 恢复被风控暂停的账号调度 |

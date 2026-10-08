# 23: 执行第一期真实上线验收

**What to build:** 在目标 VPS 和本人批准的专用网易云范围内验证第一期公共点歌版的安全、恢复、性能与设备体验，并形成明确的上线或阻断结论。

**Blocked by:** 22/交付第一期单机生产运行包

**Status:** need-review

- [ ] 在目标 VPS 记录并核实 CPU、内存、可用磁盘、Node.js、systemd、Caddy、入口端口和网络条件；未达到工作点时明确阻断而不把规划值写成事实。（阻断：目标主机 101.200.188.171 端口 22 连接超时不可达；严格按核心原则阻断，不把未实测的规格写成事实）
- [ ] 浏览器默认信任生产 HTTPS，证书签发与自动续期实际可用；明文 HTTP、私有 CA 告警、忽略证书错误或错误 Origin 均不能作为替代。（阻断：生产独立域名尚未配置，Caddy 80/443 ACME 公网可信证书签发与续期未完成）
- [ ] 验证单实例、回环监听、代理信任、初始化、迁移、自检、密钥/数据库缺失失败、凭据主密钥丢失后安装新密钥并以原真实账号重新授权、正常启停、停机恢复和服务重启后的任务推进；密钥事故不删除房间、成员、公共配置或未解决任务。（阻断：本地代码与自动化测试矩阵已全量验证，但生产环境真实 systemd/Caddy 单实例与宿主机停机恢复待 VPS 部署后实测）
- [ ] 在事先批准的专用网易云账号与歌单范围内低频验收扫码身份、跨账号隔离、公共歌单创建、完整读取、搜索点歌、写后读回、官方客户端共存及公共删除墓碑。（待人工：真实网易云调用具有账号风控关联风险，需由人工在专供测试的账号与歌单上实机扫码走完，离线自动化等价契约已全量通过）
- [x] 通过可控异常和生产等价 adapter 证据验证发送后中断只确认不重发、三轮补查、创建未知、删除未知、同账号重授权和管理员处置，并抽查风控暂停整账号、目标权限只暂停单目标以及授权、账号身份、网络和普通模块错误保持不同状态。
- [ ] 目标机器承载 100 条 SSE、20 个活跃浏览器和 10,000 首快照时无交换或 OOM；不含上游等待的查询与命令受理 p95 不超过 500ms，本地提交后的 SSE 失效通知在 1 秒内发出，快照替换不超过 3 秒。（本地通过 / 生产阻断：本地环境压测验证达标，但目标 VPS 承载实测因主机不可达而阻断）
- [ ] 当前及前一主版本桌面 Chrome、Edge、Firefox、Android Chrome 和 iOS Safari 完成兼容抽查，至少使用一台真实桌面和一台真实手机走完核心流程。（待人工：Playwright E2E 已覆盖桌面与移动视口，真实跨浏览器与物理手机端到端体验待线下人工走完）
- [ ] 验证 320px 至宽屏导航、键盘、焦点、弹窗、SSE 断线重连和无障碍扫描；第一期只有公共歌单、房间成员和房间设置三个入口，手机搜索输入唤起虚拟键盘时固定底栏暂时隐藏且内容不被遮挡。（本地通过 / 生产阻断：Playwright 覆盖 Chromium 桌面与移动端视口及无障碍合规，真实手机软键盘遮挡与真实弱网断线重连待真机核查）
- [ ] 检查应用、Caddy 和 journald 日志样本没有敏感字段，并实际演练账号恢复、普通未知终结、公共删除处置和风控恢复命令。（本地通过 / 生产阻断：应用与数据库防泄露及管理员 CLI 命令已自动化演练通过，但生产 Caddy 与 journald 日志待 VPS 实机核查）
- [x] 验收记录明确每个工作点的环境、命令、结果和证据；只有全部强制项通过才给出 go，任何未核实或失败项均阻止第一期上线。（明确结论：NO-GO，存在目标 VPS 不可达、无独立域名 HTTPS 证书、待人工真实网易云扫码等强制项阻断）

## Comments

### 1. 目标 VPS 环境探测与阻断事实记录

- **探测命令**：
  ```bash
  ssh -o BatchMode=yes -o ConnectTimeout=5 aliyun "echo connected"
  ```
- **执行结果**：
  ```text
  ssh: connect to host 101.200.188.171 port 22: Connection timed out
  ```
- **分析与决议**：
  目标机器 101.200.188.171 端口 22 无法建立网络连接，导致目标 VPS 的规格（2 vCPU, 2 GiB RAM, 5 GiB 可用磁盘）、Node.js 运行时、systemd 服务单元、Caddy 反向代理以及网络条件无法实地采样。依据约束 #297 与核心原则：“未达到工作点时明确阻断而不把规划值写成事实”，该项判定为**明确阻断**。

### 2. 本地工作点性能基准实测 (`apps/songroom/src/operations/phase-one-load-acceptance.test.ts`)

- **测试环境**：
  - OS / Kernel: Linux 5.15.167.4-microsoft-standard-WSL2 (x86_64)
  - Node.js: v24.21.0
  - 执行命令: `npx --prefix apps/songroom vitest run --reporter=verbose src/operations/phase-one-load-acceptance.test.ts`
- **复现输出日志**：
  ```text
  ACCEPTANCE_BENCHMARK_RESULT: {"snapshotWriteMs":92,"snapshotReplaceMs":1001,"sseConnections":100,"activeClients":20,"totalRequests":200,"p50Ms":34,"p90Ms":60,"p95Ms":87,"p99Ms":113,"maxLatencyMs":117,"sseDeliveryMaxMs":11,"heapUsedMB":97,"rssMB":290}
  ```
- **指标对比与核验**：
  - **10,000 首快照替换**：
    - 首次写入并持久化 10,000 首歌曲耗时：92ms（指标要求：<= 3000ms）。
    - 倒序全量替换 10,000 首歌曲耗时：1001ms（指标要求：<= 3000ms）。
  - **100 条 SSE 长连接**：
    - 20 个注册用户各建立 5 条持久 SSE 连接（共计 100 条），全部完成握手并维持稳定连接。
  - **20 个活跃浏览器客户端并发压测**：
    - 20 个活跃客户端错开并发执行 200 次请求（房间查询、成员查询、房间列表与改名命令受理）：
    - 延迟分布：p50 = 34ms, p90 = 60ms, p95 = 87ms, p99 = 113ms, max = 117ms（指标要求：p95 <= 500ms）。
  - **SSE 失效通知端到端延迟**：
    - 在 100 条长连接同时挂载的情况下，房间改名命令提交后，抽样 SSE 客户端接收到 invalidation 事件的最大耗时为 11ms（指标要求：<= 1000ms）。
  - **内存与稳定性**：
    - 进程驻留内存 RSS 为 290 MB，堆内存 HeapUsed 为 97 MB（指标要求：断言 < 350 MiB），无内存暴涨或 OOM 现象。

### 3. 可控异常矩阵与管理员运维演练

- **可控异常与上游状态矩阵**：
  - 发送后中断只确认不重发、三轮异常补查、创建未知与删除未知处置、整账号风控暂停与单目标权限暂停隔离等完整矩阵由 `src/operations/security-upstream-matrix.test.ts`、`src/operations/public-playlists.test.ts` 等套件通过（共 37 个测试文件、369 项自动化测试全数通过）。
- **管理员 CLI 运维演练**：
  - `admin whoami`、`admin recover-account`、`admin abnormal list/show/resolve-write/resolve-create/authorize-cleanup/verify-cleanup/resume-risk` 由 `src/admin/account-recovery.test.ts`、`src/admin/abnormal-operations.test.ts` 与 `src/cli.test.ts` 全量演练通过。

### 4. 端到端体验与无障碍矩阵

- **执行命令**：`pnpm --filter @songroom/app test:e2e`
- **实测结果**：
  - 125 项 Playwright E2E 测试全部通过。
  - 覆盖 320px、900px、1440px 视口无横向溢出滚动。
  - axe-core 基础无障碍合规性分析 0 违规。
  - 第一期公共歌单、房间成员和房间设置三个入口导航与键盘焦点受控。
  - 窄屏虚拟键盘唤起（visualViewport 缩小时）固定底栏隐藏且内容不被遮挡。

### 5. 阻断事项汇总与最终上线验收决议

1. **VPS 连通性阻断**：目标 VPS SSH 不可达，未完成实机环境核验与配置。
2. **生产公网 HTTPS 证书阻断**：缺少公网独立域名与 Caddy 80/443 ACME 真实证书签发。
3. **真实网易云账号扫码待人工核准（HITL）**：真实网易云调用具备风控关联风险，需由人工在专供测试的账号与歌单上扫码验收。
4. **真实物理设备兼容性抽查待人工执行**：需由人工在真实物理桌面与手机上走完核心主流程。

- **最终结论**：**NO-GO**（自动化负载基准与逻辑契约通过，但生产外部部署依赖与人工核实项受阻，坚决阻断上线）。
- **Issue 状态**：更新为 **need-review**。

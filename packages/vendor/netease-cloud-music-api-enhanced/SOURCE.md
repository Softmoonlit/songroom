# SongRoom 受审 Enhanced vendor

- 上游仓库：https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
- 固定版本：**4.40.1**
- 固定源码提交：**a8c781fd64faab17fedfd46e0615a2609307f163**
- 源码归档：https://codeload.github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tar.gz/a8c781fd64faab17fedfd46e0615a2609307f163
- 归档 SHA-256：`d17464cc1a2d4c03bb706ec2897e4af1c38b5c1013e5b2526f23551eccde735b`
- 许可证：MIT，原文保存在 `LICENSE`。

此目录是从上述固定源码裁剪并审查的 CommonJS 运行包，包含十四种批准操作所需的模块、请求层、加密、选项、工具函数、配置，以及工具函数依赖的中国 IP 数据文件。不提供 app/server/main 入口、通用模块加载器、启动时游客登录或配置下载。两个 check-token 辅助模块仅因上游 `request.js` 静态引用而保留，批准调用始终禁用该能力。构建和测试不会访问真实账号或真实上游。

`upstream-package.json` 与 `upstream-pnpm-lock.yaml` 保留上游来源证据，只作为元数据，不作为安装目标或运行入口。此目录的 `package.json` 只保留必需运行依赖，并精确固定直接依赖版本；安装以仓库根目录的 `pnpm-lock.yaml` 为权威。不运行 vendor 的 prepare/install 脚本。部署必须使用仓库冻结锁文件，不得下载替代上游源码或改用 npm 上的 Enhanced 包。

`production.patch` 记录复制的上游运行文件的全部修改。生产补丁删除 `playlist_tracks` 在 512 分支的二次写、隐式 `NETEASE_COOKIE`、全局设备回退和原始诊断输出，保留二维码轮询的原错误，区分解析、传输与普通业务错误，保留真实 HTTP 状态，并禁用 Axios 重定向，防止 307/308 重发写请求。批准调用显式传入 PC 设备信息、Cookie 和 15 秒请求超时。

`integrity.json` 列出全部受审文件的 SHA-256，包括本文、许可证、数据、上游来源元数据、包配置、补丁和上游依赖锁。清单自身的摘要固定在 SongRoom 的 `integrity.ts` 中。文件清单仅排除自身；`node_modules` 下的依赖安装产物由包管理器冻结锁文件管理，不属于上游受审源码。校验拒绝受审文件的新增、缺失、修改或符号链接。主动更新源码、清单、依赖、补丁或白名单时，必须重新审查并完成同等离线契约及部署验收。

构建将完整受审目录复制到 `dist/netease/vendor`。其中生成的 `node_modules` 符号链接指向固定 workspace vendor 的已安装依赖，属于安装产物，不提供第二份运行源码。构建校验源目录及复制结果；运行时在启动和每次调用前校验复制结果。每次调用启动一个独立 worker，使用 0700 私有目录作为 cwd/TMPDIR/TMP/TEMP/HOME，采用 umask 077 和最小环境。父进程忽略 stdout/stderr，并校验 IPC schema；父子进程均不重试业务写入。批准输入、设备身份和目标只能由服务端提供；授权、会话、代次校验及凭据加密由服务端业务模块负责。

本次扩充从同一经摘要验证的固定源码归档原样复制 `record_recent_song.js` 和 `song_order_update.js`，无新增上游运行补丁。最近播放仅请求第一条歌曲记录并规范化歌曲 ID，不提供设备实时状态。顺序更新只暴露服务端“下一首播放”所需的一次重排，按写操作处理，未知结果不得重发；成功响应仅为受理确认，业务层须读回验证集合及顺序。搜索由服务端提供受控的数量与偏移参数，直接搜索每页 20 首，文本导入候选规则独立。扩充后的离线契约覆盖参数转发、最近记录结构以及重排成功、512、断连、重定向时最多一次实际请求；真实上游语义仍须专用歌单验收。

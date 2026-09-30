# 确定多房间 MVP 架构与完整规格

Type: grilling
Label: wayfinder:grilling
Status: open
Blocked by: 01, 02, 03, 04, 05, 06, 07

## Question

综合账号与房间模型、双类型歌单、导入与点歌语义、授权复用实测、并发失败、安全运维和交互原型，采用什么系统架构、技术栈、数据模型、模块职责、接口与页面更新契约，才能形成无歧义、可直接开发的多房间 MVP 规格？需明确规模目标、非功能约束、验收门槛和延期项，将未证实的上游行为明确标为测试门槛，不实现旧匿名/单房间/主动重排方案的兼容路径。

处理本票据时同时使用 codebase-design 与 domain-modeling，最终规格存放于本 feature 目录的 spec.md。

## Comments

### 已确定的歌单权限与生命周期输入

[确定公共与个人歌单权限及生命周期](02-decide-playlist-permissions-and-lifecycle.md#解决评论歌单权限与生命周期规则已确认)为权威决议入口，本票应将已授权账号选择、按需配置、可维护与只读来源、同一云端歌单跨房间共用、创建来源和删除资格、成员彻底清理及最小云端清理任务纳入模型与验收条件，不在此重定产品规则。

新建、清理、收藏读取及多账号隔离的真实证据仍由[验证授权复用、账号隔离与官方客户端共存](04-verify-auth-reuse-and-client-coexistence.md)提供；协调和恢复机制由[确定多歌单并发、同步与失败恢复](05-decide-concurrency-sync-and-recovery.md)决定。当前只形成网易云 MVP，不因未来 QQ 音乐、酷狗音乐接入的方向而预先设计平台适配框架。

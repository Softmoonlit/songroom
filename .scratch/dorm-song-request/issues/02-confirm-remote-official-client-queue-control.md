# 确认能否远程控制官方客户端播放队列

Type: research
Status: resolved

## Question

是否存在不在房主电脑运行额外软件、仅从公网服务调用即可把歌曲直接加入指定网易云 Windows/macOS 官方客户端当前播放队列的 API？

## Answer

### 已证实

- Enhanced 没有专门的 `player` 或 `queue` 模块。[`playlist_tracks`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/playlist_tracks.js)只修改持久化云端歌单。
- [`listentogether_sync_list_command`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/listentogether_sync_list_command.js)和 [`listentogether_play_command`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/listentogether_play_command.js)操作一起听房间状态，不接受目标桌面设备参数。
- [`relay_play_state_submit`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/relay_play_state_submit.js)与官方跨端续播能力上报播放快照，不会命令某台桌面客户端执行播放。
- 现有桌面远控方案均依赖被控电脑上的本地服务、CDP、AppleScript、Windows UI Automation 或快捷键模拟。

### 未证实

- 网易云官方客户端已打开某个云端歌单时，云端增删或排序是否会偶然自动刷新到当前队列；没有公开文档提供保证。
- 一起听房间接口理论上可能同步房间内客户端，但其入房确认、长连接协议、版本兼容和桌面端行为没有满足本项目约束的稳定证据。

### 不可行

- 没有找到公开、可复现的 API 能远程寻址一台 Windows/macOS 官方客户端并直接插入其当前播放队列。
- 在房主电脑完全不运行桥接组件的约束下，不能实现可靠的桌面客户端远控。
- 云端歌单、播放历史上报、设备列表、播放模式推荐和当前播放队列不能视为同一种状态。

产品据此取消自动续播与播放队列同步要求，只维护云端点歌歌单。

## Evidence

- 官方[跨端续播上报](https://developer.music.163.com/st/developer/document?docId=0c5f0f57a068438cbfb6d33d9583f263)与[跨端续播查询](https://developer.music.163.com/st/developer/document?docId=b8b94936a02241328cdc23a1b572bae7)。
- 官方 [CMAPI 简介](https://developer.music.163.com/st/developer/document?docId=0bc2ccadd2264e41a5b3ca1acf29064d)仅适用于同一 Android 设备上的第三方应用绑定，不是桌面远控。
- [CloudMusicController](https://github.com/FreeJumpMan/CloudMusicController)、[NetEaseMusicController](https://github.com/winkidney/NetEaseMusicController)和 [opencli-netease-music](https://github.com/that-yolanda/opencli-netease-music)均要求在被控电脑运行本地组件。

# 确认网易云接口能力与账号风险

Type: research
Status: resolved

## Question

NeteaseCloudMusicApi Enhanced 是否覆盖点歌台所需的账号登录、歌曲搜索、云端歌单增删和排序能力，其维护稳定性与账号风险是否可接受？

## Answer

### 已证实

- [登录接口](https://neteasecloudmusicapienhanced.js.org/#/?id=%e7%99%bb%e5%bd%95)提供手机号、邮箱和二维码登录，并以 Cookie 维持后续会话；二维码登录 Cookie 不支持通过 `/login/refresh` 刷新。
- [搜索接口](https://neteasecloudmusicapienhanced.js.org/#/?id=%e6%90%9c%e7%b4%a2)提供 `/search` 与 `/cloudsearch`，可以搜索单曲。
- [歌单增删接口](https://neteasecloudmusicapienhanced.js.org/#/?id=%e5%af%b9%e6%ad%8c%e5%8d%95%e6%b7%bb%e5%8a%a0%e6%88%96%e5%88%a0%e9%99%a4%e6%ad%8c%e6%9b%b2)提供 `/playlist/tracks`，可对账号有编辑权限的云端歌单增加或删除歌曲。
- [歌曲排序接口](https://neteasecloudmusicapienhanced.js.org/#/?id=%e8%b0%83%e6%95%b4%e6%ad%8c%e6%9b%b2%e9%a1%ba%e5%ba%8f)提供 `/song/order/update`。
- 这些模块调用网易云私有上游接口，不是网易云向普通开发者承诺的稳定合同。项目 README 将其描述为第三方 API 且不提供担保。
- 网易云现行[服务条款](https://st.music.163.com/official-terms/service)禁止未经授权的第三方兼容软件登录或使用服务，并保留暂停、封禁或注销账号的权利。
- 房主已明确选择使用日常主账号并接受上述风险。

### 未证实

- 排序接口是否要求每次提交完整歌曲 ID 序列，以及歌曲数量上限、重复歌曲和并发覆盖的精确行为，文档没有完整说明。
- 低频宿舍使用触发登录风控、限流或账号处罚的实际概率无法量化。
- 私有上游接口未来是否继续保持参数和行为兼容无法保证。

### 不可行

- 不能把 MIT 许可证理解为网易授权使用其服务、账号 Cookie、私有接口或音乐内容。
- 不能对外承诺接口长期稳定、账号安全或无风控。

## Evidence

- Enhanced 源码中的 [`cloudsearch`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/cloudsearch.js)、[`playlist_tracks`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/playlist_tracks.js) 和 [`song_order_update`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/song_order_update.js)。
- 登录风控案例：[Issue 143](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/issues/143) 与 [Issue 8](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/issues/8)。
- 操作频率限制案例：[Issue 158](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/issues/158)。

# 道理鱼（daoliyu-music vnext）适配调研（2026-09-06）

> 目标：将道理鱼作为 SongHamster 第三个媒体服务器目标（Emby / Navidrome / Daoliyu）。
> 结论先行：**vnext 有完整 HTTP API（OpenAPI 196 端点 + Subsonic 兼容层），适配可行；但项目实际已闭源（镜像分发，源码不可得），细节需实测。**

## 一、开源状态

- GitHub：`daoliyu` org 不存在（panic 栈路径 github.com/daoliyu/daoliyu-music-vnext 对应仓库不可见）——**vnext 实际闭源**
- Gitee `wangzaifan/daoliyu-music`：旧版 Node 架构，与当前部署的 vnext（Go 后端）**不兼容**，仅参考 UI 理念
- 官方文档站 daoliyu.cn：SPA，无公开源码；API 文档由运行实例自带（`/api/openapi.json` + `/api/docs` Swagger UI）

## 二、运行实例 API 面（本机 10.144.16.213:15373 实测）

- **OpenAPI 规范**：`GET /api/openapi.json`（58KB，196 路径，版本 2026.07.21）
- **Swagger UI**：`/api/docs`
- **认证**：`bearerAuth`（登录换 token）；另有 `client-credentials` / `client-pairings`（第三方客户端凭据/配对机制，疑似给 App/伴侣端用）
- **Subsonic 兼容层**：`/rest/ping`（根级）与 `/api/v1/subsonic/rest/*` 均响应 subsonic-response——**标准 Subsonic 端点大概率可用（含 playlists 增删曲）**

### 端点面（与 SongHamster 适配相关）
| 能力 | 端点 | 备注 |
|---|---|---|
| 登录 | `POST /api/auth/login` | body schema 未标注（实测确认 username/password）→ Bearer token |
| 播放列表列表 | `GET /api/playlists/mine` | |
| 播放列表详情 | `GET /api/playlists/{id}` | |
| 播放列表建/改/删 | `GET /api/playlists`(建?) / `PATCH` / `DELETE /api/playlists/{id}` | 创建方式待实测 |
| 列表歌曲 | `GET /api/playlists/{id}/tracks` | |
| 加曲 | `POST /api/playlists/{id}/tracks`、`POST .../tracks/batch` | 批量 |
| 排序 | `PATCH /api/playlists/{id}/tracks/reorder` | |
| **删曲** | ❓ 主 API 未见 DELETE tracks | ⚠️ 待实测：Subsonic `removeFromPlaylist` 兜底 |
| 歌曲列表/详情 | `GET /api/tracks`、`GET /api/tracks/{id}`、`/api/v1/tracks` | 过滤参数/音质字段 schema 未标注，实测 |
| 媒体库 | `GET /api/library/albums|artists|folders|...` | |
| 扫描 | `POST /api/admin/scan`、`/api/admin/scan-paths`、`GET /api/tasks` | 扫描任务体系完整 |
| 收藏 | `GET /api/favorites/*` | 备用 |
| 音质 | DB 表 tracks 含 bit_rate/sample_rate/bit_depth（推测） | 实测确认 |

⚠️ OpenAPI 质量：仅 18 个顶层 schema，业务对象字段多为空标注——**关键细节（登录 body、track 音质字段、tracks 过滤）必须实机验证**。

## 三、SongHamster 适配映射评估

| MediaServerAdapter 方法 | Daoliyu 对应 | 可行性 |
|---|---|---|
| test() | GET /api/health（或登录） | ✅ |
| listPlaylists | GET /api/playlists/mine | ✅ |
| createPlaylist | POST/GET /api/playlists | ✅（实测） |
| addItems | POST /api/playlists/{id}/tracks/batch | ✅ |
| listPlaylistItems | GET /api/playlists/{id}/tracks | ✅ |
| removeItems | ⚠️ Subsonic removeFromPlaylist 或主 API 隐藏端点 | 🟡 实测 |
| findSong | GET /api/tracks + title 过滤（或 Subsonic search3） | 🟡 实测 |
| scanLibrary | POST /api/admin/scan | ✅ |
| listLibrarySongs | GET /api/tracks 分页 | ✅（字段实测） |
| 路径/音质 | track.path / bit_rate/sample_rate/bit_depth | 🟡 实测 |

## 四、下一步（确认后执行）

1. 需要管理员账号凭据（用户已创建）→ 实测：登录 → token → 关键端点逐项验证（含删曲、音质字段、tracks 过滤）
2. 依实测结果定稿本设计 → 开发 `DaoliyuAdapter`（复用 MediaServerAdapter 接口，M5-0 抽象后新增即插）
3. 连接容器页加第三目标（target 枚举 emby/navidrome/daoliyu + 表单）

---

## 附录：实机 API 实测结论（2026-09-06，本机 15373，管理员账号）

> 全部端点对运行实例实测。登录：`POST /api/auth/login` body `{email, password}` → `{token: JWT, user:{role: ADMIN}}`；
> 后续请求 `Authorization: Bearer <token>`。

| 操作 | 端点 | 实测结果 |
|---|---|---|
| 登录 | `POST /api/auth/login` | ✅ 返回 JWT + user（email 或 username 均可） |
| 播放列表列表 | `GET /api/playlists/mine` | ✅ 数组 [{id: pl_xxx, name, trackCount, ...}]（含系统默认收藏列表） |
| 建播放列表 | `POST /api/playlists` body `{"name"}` | ✅ 返回完整对象（注意默认 isPublic: true） |
| 删播放列表 | `DELETE /api/playlists/{id}` | ✅ 204 |
| 列表歌曲 | `GET /api/playlists/{id}/tracks` | ✅ 条目含 id(plt_xxx) + track 对象 |
| **加曲** | **`POST /api/playlists/{id}/tracks/batch` body `{"trackIds":[...]}`** | ✅ 201 返回加入条目（单曲 POST /tracks 404 无效——用 batch） |
| **删曲** | ❌ 主 API 无端点；`/rest/removeFromPlaylist` 报 Unknown endpoint（subsonic 层未实现）；reorder 需全量（count mismatch，不能隐式删） | **缺口：完全同步删曲不可用 → Daoliyu 适配强制增量（只增不删）** |
| 歌曲搜索 | `GET /api/tracks?search=关键词` | ✅ 精确匹配（title/query/q 参数无效——用 search） |
| 歌曲字段 | tracks 返回 | ✅ 音质字段齐全：sampleRate/bitDepth/bitrate/detectedContainer/fileFormat/fileSize/durationSeconds；**filePath 为容器内绝对路径（/D8/...）**——与 Emby 相同可前缀翻译 |
| 媒体库根 | `GET /api/admin/scan-paths` | ✅ 本机根 = `/D8/MOVIEPILOT/MUSIC/MusicTagWeb/LINK/LXSERVER/king`（与 downloadRoot 同源，135 文件，REALTIME 自动监听） |
| 扫描触发 | `POST /api/admin/scan`（scan-tasks/tasks 任务体系） | ✅ 存在（REALTIME 下通常无需手动） |

**删曲/回收站补充探测（2026-09-06）**：用户从 Web UI 看到"移入回收站"操作，但 REST 层不存在：
- `/api/playlists*` 全端点无移除歌曲方法；UI 前端走私有 `/playlists/web` 通道
- `/api/trash`、`/api/library/trash`、`/api/admin/trash`、`/api/tracks/{id}/trash` 等均返回 **501 NOT_IMPLEMENTED_YET**（路由预留未实现）
- Subsonic `removeFromPlaylist` → Unknown endpoint
→ **结论：道理鱼播放列表对外 API 只增不减，完全同步（full）模式不可支持，Daoliyu 适配强制 incremental（归档只增）**；如需减法只能等官方开放 API 或 UI 手动。

**歌单目录机制（用户 Web UI 确认，2026-09-06）**：道理鱼支持"目录即歌单"——
- ① 选择目录的**一级子目录自动生成歌单**（目录名=歌单名）
- ② m3u 文件在歌曲入库后生成对应歌单
- SongHamster 落盘结构（downloadRoot/歌单同步/<歌单名>/）与①**天然同构**：若"歌单目录"指向 `歌单同步`，每个歌单文件夹自动成为道理鱼歌单、REALTIME 监听下新文件自动纳入 → **同步入库后 SongHamster 甚至无需 API 维护播放列表**
- ⚠️ 配置端点 REST 预留未实现（/api/admin/playlists/directory → 501）——需 Web UI 手动设置一次
- 待验证：设置歌单目录 = 歌单同步 后，已有子目录（华语/我喜欢的/QQ·热歌榜/手动下载）是否自动生成歌单

**适配要点**：
- kind='daoliyu'，路径本地化 = filePath 去掉容器根前缀（同 Emby localize 思路）
- quality 判定：detectedContainer/fileFormat + bitDepth + sampleRate/bitrate → QUALITY_ORDER
- findSong：`?search=` 精确匹配 + artist 归一
- addItems 用 batch；removeItems 抛"不支持"→ 引擎对 daoliyu 任务强制 incremental
- 扫描：REALTIME 自动（Navidrome 同款）→ scanLibrary no-op

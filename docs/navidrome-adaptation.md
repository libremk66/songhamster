# Navidrome 适配设计（草案 v0.1 — 2026-09-05）

> 目标：SongHamster 从"仅 Emby"演进为"多媒体服务器适配"（Emby 现有 + Navidrome 新增）。
> 依据：Navidrome 源码调研（/tmp/navidrome, go 源码实证）+ SongHamster 依赖面分析。状态：待讨论。

---

## 一、Navidrome 关键事实（源码实证）

### 1.1 API 形态
- 三套并存：**Subsonic 兼容**（/rest/*）、**Jellyfin 兼容**、**Native REST**（/api/*）
- Native REST 认证独立挂载：`POST /auth/login` `{username,password}` → 返回 **JWT**（`token` 字段）
- 后续请求：`Authorization: Bearer <token>`（或 `X-ND-Authorization` 头）；JWT 会自动续期（响应头带回）
- 响应基本无统一 data 包装（扁平 JSON / raw array）；批量删返回 `{"ids":[...]}`，加曲返回 `{"added":N}`
- 无独立 /api/search——列表端点本身支持过滤/分页（deluan/rest 的 `_start/_end/_sort/_order` + 文本过滤参数）

### 1.2 入库机制（与 Emby 最大的不同）
- **文件系统 watcher（inotify）自动增量扫描**：新文件落盘 → 去抖 ~5s → 定向局部扫描入库，**基本免干预**
- 首启自动全量（ScanOnStartup 默认开）；定时全量默认关
- 手动触发：Subsonic `startScan`（admin 权限）——一般不需要
- 入库以**标签为主**（标题缺失用文件名兜底），flac/mp3/m4a 等全支持；**ModTime 变化即重新索引**

### 1.3 歌曲与查询
- `GET /api/song` 列表：每条含 `id`（DB 随机 id，**API 主键**）、`path`（**相对音库根的相对路径**）、`title/artist/album/albumId/duration/size/suffix`
- **音质字段齐全**：`bitRate/sampleRate/bitDepth/channels`（扫描时提取）——24bit FLAC 判定可行
- 歌曲 id **无法由路径推导**（随机 id + 稳定业务 PID），加入播放列表必须**先查询拿 id**
- path 可精确匹配反查（persistence 层 FindByPaths 按 `path collate nocase`），REST 层过滤语法需实测

### 1.4 播放列表
- `POST /api/playlist`（JSON body 建普通列表；Content-Type 非 JSON 视为 M3U 上传）
- `POST /api/playlist/{pid}/tracks` body `{"ids":["<songId>",...]}` → `{"added":N}`（也支持 albumIds/artistIds）
- `GET /api/playlist` / `GET /api/playlist/{pid}/tracks`（**勿带 accept: audio/x-mpegurl**，否则返回 m3u）
- 列表本体与条目存 DB；.m3u 是可选导入/导出通道
- **无"播放列表条目 vs 底层条目"双层结构**——条目即歌曲 track（对完全同步的删歌逻辑有影响，见 §3.2）

### 1.5 媒体库概念
- **无 Emby 式"媒体库文件夹集合"**：一个/多个 MusicFolder 根（`NAVIDROME_MUSICFOLDER`，多根用分隔符）
- 歌曲 path 都是相对某根；根目录即整个"库"

---

## 二、SongHamster 侧依赖面（已盘点，见工程源码）

### 2.1 EmbyAdapter 公开方法（19 个）按用途分：
| 归类 | 方法 |
|---|---|
| 同步管线必需 | listPlaylists / resolveLibraryId / scanLibrary / createPlaylist / addItems / removeItems / findSong / listPlaylistItems |
| 查重·曲库 | listMusicLibraries / listLibrarySongs / getItemPath / findSongWithQuality / test |
| 未使用预留 | deleteItem |

### 2.2 文件层不依赖 Emby（可直接复用）：
- 洗版 upgrade（纯 LX + 本地 fs）、回收站 trash 本体（本地 fs 移动）、file-manager（落盘/归类）、probe 探测
- 同步引擎对媒体服务器的调用集中在 ensureInEmby / removeSongs 两函数 + dedup pre-check

### 2.3 关键不变量：
1. **幂等映射**：store 缓存 `songKey → mediaServerSongId`（现为 embySongId），防重复入库
2. **播放列表同名去重**：`findPlaylistByName` 精确 === 名字匹配
3. **路径映射约定**：downloadRoot ↔ libraryRoot 同源（localizeEmbyPath 前缀翻译）——回收站/查重定位依赖
4. **入库检测轮询**：Emby 需要 scanLibrary + 每 5s 轮询 findSong（6 次重试）——Navidrome 不需要

---

## 三、差异分析与适配策略

| # | 差异 | Emby 现状 | Navidrome 等价 | 影响 |
|---|---|---|---|---|
| D1 | 入库延迟 | 需触发 Refresh + 轮询重扫 | watcher 自动 ~5s 入库 | ✅ 简化：可去掉 scan+轮询整层 |
| D2 | 触发扫描 API | POST Items/{lib}/Refresh | （Subsonic startScan，admin；一般不调） | 接口可留 no-op / 备选实现 |
| D3 | 歌曲定位 | SearchTerm 模糊搜 | /api/song 过滤查询 | 匹配语义需实测对齐 |
| D4 | 播放列表条目 | 双层（itemId/entryId） | 单层（track） | removeSongs 语义调整（删歌=删 track） |
| D5 | 音质判定 | MediaSources(container/bitrate/bps/sampleRate) | song 字段 bitRate/sampleRate/bitDepth/suffix | ✅ 等价可实现 |
| D6 | 路径可反查 | getItemPath（Emby 暴露绝对路径） | path 为**相对根路径** | 本地主导推算 + 相对 path 校准 |
| D7 | 多媒体库 | VirtualFolders 列表 + isProject 标注 | 单根（根目录即库） | 查重 UI 简化：Emby 保留库选择，Navidrome 整库 |
| D8 | 认证 | API Key 头 | 账号密码换 JWT（48h 自动续期） | config 存 username/password |
| D9 | 歌单目标 | 同名播放列表 ✓ | 同名 playlist ✓ | 语义一致，直接映射 |

### 3.1 入库路径（Navidrome 主流程设想）
```
LX 歌单拉取 → LX 下载（标签/封面/歌词）→ file-manager 落盘 <downloadRoot>/歌单同步/<歌单名>/
  → Navidrome watcher ~5s 自动入库（无 API 调用）
  → 查 song：GET /api/song（title+artist 过滤，本地已有 path 可精确定位）
  → POST /api/playlist（无同名则建）→ POST /api/playlist/{pid}/tracks {"ids":[songId]}
  → store 幂等记录 songKey → songId
```
对比 Emby：省掉 scanLibrary + 6×5s 轮询，体验更顺、不整库重扫。

### 3.2 完全同步（removeSongs）差异
- Emby：listPlaylistItems 拿 entryId → removeItems(entryIds)
- Navidrome：list tracks 拿 songId（条目即歌曲）→ DELETE /api/playlist/{pid}/tracks（按歌曲 id 删除，参数形态需实测：body ids 列表 or query）
- 引擎层把"删除动作"定义为 `removeSongsFromPlaylist(pid, songIds)`，适配器各自实现（Emby 内部把 songId 映射为 entryId——需要引擎已知每个 songId 对应的 entryId？Emby removeItems 用的是 playlist entry id 而非 item id！→ 接口设计：`listPlaylistSongIds(pid): {songId, entryId?}[]`，Emby 实现返回 entryId 语义，Navidrome 返回 songId 语义；删除接口统一收 entryId。或更通用：删除按"歌曲唯一 id"抽象，Emby 端 list 时预取 entryId 映射表再删）

### 3.3 查重/回收站适配
- 查重源数据：Navidrome = GET /api/song 全量分页（单根）→ id/name/artist/path(相对)/quality/size
- 质量判定：suffix + bitRate/sampleRate/bitDepth 换算 QUALITY_ORDER（与现有 qualityOfItem 对齐，需实测 flac24bit 判定）
- 本地路径推算：path(相对) + musicfolder 根 = 宿主机绝对路径（与 localizeEmbyPath 同思路：downloadRoot 即 musicfolder 的宿主机对应）
- **回收站机制不变**（本地 fs），Emby 端靠重扫清条目；Navidrome 端文件移走后 watcher 自动标记 missing → 扫描清理（PurgeMissing 需配置？）→ 需实测"文件消失后 Navidrome 的行为"（DB 标记 missing；PurgeMissing=true 才物理清 record？）——**实测项**
- isProject 映射提醒：Navidrome 无多库概念 → 该 UI 逻辑 Emby 专属（隐藏）

### 3.4 配置与 UI
- config 增加 `server.target: 'emby' | 'navidrome'`（初期**二选一**，避免双写复杂度）
- emby 段保留；新增 `navidrome: { baseUrl, username, password, musicFolder（宿主机视角，用于路径推算）, libraryId? }`
- 连接容器页：按 target 渲染表单/测试按钮
- 同步设置页：媒体服务器侧只有"播放列表目标"（Navidrome 同样支持）；查重页媒体库多选框仅 Emby 显示

---

## 四、技术路线（分阶段、每步可回归验证）

### M5-0 接口抽象重构（纯重构，零行为变化）
- 定义 `src/adapters/media-server.ts`：`MediaServerAdapter` 接口（test/listPlaylists/createPlaylist/addItems/removeSongsFromPlaylist/listPlaylistSongIds/findSong/findSongWithQuality/scanLibrary(可 no-op)/listAllSongs(查重用)/resolveRoot...）
- `EmbyAdapter implements MediaServerAdapter`（现有 19 方法归位到接口或文件级私有）
- sync-engine / pages.ts / api.ts / dupe.ts 类型改为接口
- 回归：本机 Emby 全流程（同步/洗版/查重/回收站）不动
- 交付物：无功能变化 + typecheck + 全回归

### M5-1 NavidromeAdapter 开发
- 本机 docker 起 Navidrome 测试实例（挂同一音乐目录只读测试? 不——真实读写挂载，指向 downloadRoot 同源目录，避免双写风险：测试阶段用**独立小目录** + 复制少量歌曲验证）
- 实现：认证（登录+JWT+自动续期）、listPlaylists、createPlaylist、addItems、deleteFromPlaylist、song 查询（title/artist/path 过滤实测）、全量 song 分页、quality 换算
- 实测清单：song 过滤语法、add/remove 参数形态、watcher 入库延迟、PurgeMissing 行为、bit_depth 对 flac 的准确性、playlist 同名行为

### M5-2 目标选择接入
- config target + 页面表单（连接页/同步设置/查重页媒体库区条件渲染）
- 路径推算：navidrome.musicFolder（宿主机视角）↔ downloadRoot 同源约定文档化

### M5-3 端到端验证 + 文档
- 真实歌单同步 → Navidrome 入库可见 → 播放列表正确 → 增量/完全模式 → 查重/回收站
- README/docs 更新（支持矩阵表 Emby/Navidrome）

---

## 五、待讨论决策点

1. **测试环境**：Navidrome 现在是否已部署？建议 docker 起一个测试实例（同一 NAS），SongHamster 测试连它
2. **目标二选一 or 并存**：初期建议 target 切换（推荐）；并存双写复杂度高，二期再说
3. **认证配置**：username/password 明文入 config.yaml（本地自托管同 apiKey 待遇）——接受？
4. **Navidrome 端歌曲清理**：回收站移走后 Navidrome 需 PurgeMissing 才清 record？还是仅标 missing？确认期望行为（影响查重历史/播放列表残留）
5. **查重范围**：Navidrome 单根即全库——UI 直接整库，去掉媒体库勾选？
6. **Roadmap 排期**：M5-0 纯重构先行（低风险）？还是直接先 M5-1 起 Navidrome 实例探 API 实测（更快验证可行性）？

---

## 附录：Navidrome 0.63.2 API 实测结论（2026-09-05，本机 60233 端口）

> 全部端点已对本机 Navidrome（deluan/navidrome:latest，版本 0.63.2）实测验证。

| 操作 | 端点 | 说明 |
|---|---|---|
| 登录 | `POST /auth/login` body `{"username","password"}` | 返回 `{token(JWT), username, isAdmin, subsonicToken...}`；token 24h（ND_SESSIONTIMEOUT） |
| **认证头** | **`X-ND-Authorization: Bearer <jwt>`** | ⚠️ 唯一有效形式：裸 token 放 X-ND 头、标准 `Authorization: Bearer` 均 401（实测） |
| 媒体库列表 | `GET /api/library` | `[{id, name, path, totalSongs...}]`；本机「LX同步音乐」id=2，path=`/D8/.../LXSERVER/king`（容器视角，与 downloadRoot 同源） |
| 歌曲分页 | `GET /api/song?_start=0&_end=50` | 每首含 `id(22位base62)/path(相对库根)/title/artist/album/bitRate/sampleRate/bitDepth/suffix/size/duration/lyrics(JSON)` |
| 歌曲过滤 | `GET /api/song?title=终于` | **title LIKE 部分匹配**（大小写不敏感）；artist/album/name/orderArtistName 过滤均无效（实测 0 或全量）→ 用 title 粗查 + 本地 artist 归一过滤 |
| 播放列表列表 | `GET /api/playlist` | 数组；每项含 id/name/size/duration |
| 建播放列表 | `POST /api/playlist` JSON `{"name"}` | 返回 `{id,...}`（含 name 等字段，响应为完整 playlist 对象） |
| 加歌 | `POST /api/playlist/{pid}/tracks` JSON `{"ids":["<songId>",...]}` | 响应 `{"added":N}`；ids 是**歌曲 id** |
| 查列表条目 | `GET /api/playlist/{pid}/tracks` | 条目 `{id(关系id,数字), mediaFileId(歌曲id), title, artist...}`；⚠️ 勿带 `accept: audio/x-mpegurl`（会返回 m3u） |
| **删歌** | **`DELETE /api/playlist/{pid}/tracks?id=<关系id>`** | ⚠️ 参数是 **playlist_tracks 关系 id（数字）**，不是歌曲 id；逗号串不拆分（实测），多删用重复参数 `?id=1&id=2` 或循环单删；对应 Emby 的 entryId 语义 |
| 删播放列表 | `DELETE /api/playlist/{pid}` | 返回 `{}` |

**入库机制确认**：ND_SCANSCHEDULE=1m（本机配置每分钟定时扫描兜底）+ watcher（inotify，5s 去抖）。新文件落盘后 1 分钟内可见；「LX同步音乐」库 path 即 SongHamster downloadRoot 的容器视角——本地路径推算 = downloadRoot + song.path 相对路径，直接可用。

**与 Emby adapter 的方法映射（接口设计锚点）**：
- listPlaylists → `GET /api/playlist`
- createPlaylist(name) → `POST /api/playlist`
- addItems(pid, songIds) → `POST /api/playlist/{pid}/tracks`（songId）
- listPlaylistItems → `GET /api/playlist/{pid}/tracks`（取关系 id + mediaFileId）
- removeItems(entryIds) → `DELETE /api/playlist/{pid}/tracks?id=` 循环（entryId = 关系 id）
- findSong(title) → `GET /api/song?title=` + 本地 artist 过滤
- 全库列歌 → `GET /api/song` 分页拉全量（libraryId 过滤待验证）
- scanLibrary → no-op（watcher/ND_SCANSCHEDULE 自动入库）
- 音质判定 → song.bitRate/sampleRate/bitDepth/suffix 直接映射 QUALITY_ORDER

# SongFerry 产品设计文档（v1.0 定稿）

> 项目定位：把"LX 歌单 → 下载（完整标签/封面/歌词）→ Emby 入库 → Emby 歌单增量"管道做成一个稳定、可配置、可 Docker 部署的独立服务。
> 对接：lxserver（XCQ0607/lxserver，音乐下载引擎）+ Emby（媒体库/歌单）。
> 设计日期：2026-09-04。所有交互语义均经用户逐条确认。

---

## 一、页面结构总览

| # | 页面 | 职责 |
|---|------|------|
| 1 | [连接LXSyncServer] | LX 连接 + 全局下载选项（音质/命名/写入项/并发/重试） |
| 2 | [同步设置] | Emby 连接 + 媒体库根路径 + **同步映射表**（核心页） |
| 3 | [任务进度] | 歌单 × 歌曲 状态矩阵（实时视图 + 重试 + 手动触发） |
| 4 | [历史记录] | 同步批次时间线（成功/失败/未满足明细 + 失败重试） |
| 5 | [日志] | 本项目运行日志 + 转发的 lxserver 侧报错 |
| 6 | [设置] | 通知（预留）、暂停总开关、日志保留、自动纳入新歌单、清理孤立文件等 |

---

## 二、页面 1：[连接LXSyncServer]

### 连接区
- 地址输入框 + API key 输入框 + [测试连接] 按钮
- 连接成功 → 显示当前 LX 中的歌单列表（只读预览，含歌曲数）
- 连接状态徽标（顶部常驻：LX ✅ / Emby ✅）

### 全局下载选项
| 控件 | 语义 |
|------|------|
| **音质偏好（复选框）** | flac24bit / flac / 320k / 128k 四档复选；下载按高→低依次尝试；未勾选的档绝不使用；全部勾选范围内拿不到 → 歌标记"未满足" |
| **命名模板** | 自由文本 + `[占位符]` 替换；可选分隔符由用户写在模板里（如 `[歌手] - [歌曲名] ([音质])`）；占位符：`[歌手] [专辑名] [歌曲名] [音质]`；**实时预览框**（填完显示示例文件名） |
| **写入信息（4 勾）** | ☑ ID3 标签（标题/歌手/专辑）、☑ 封面（专辑图）、☑ 内嵌歌词（LYRICS 标签）、☐ 外置歌词（.lrc 文件）——双份歌词分开勾选 |
| **并发下载数** | 1-10，默认 3（防音源限流） |
| **失败自动重试次数** | 默认 2 |

---

## 三、页面 2：[同步设置]（核心页）

### 3.1 Emby 连接区（页面顶部）
- 地址 + API key + [测试连接]
- 连接成功 → 显示现有播放列表（下拉/勾选数据源）

### 3.2 媒体库根路径
- 单个全局根路径（Emby 扫描的媒体库根，如 `/music/LINK/LXSERVER/king/歌单同步`）
- ⚠️ 需要向用户说明"共享卷"概念：lxserver 下载落盘目录与 Emby 媒体库必须是同一可见路径

### 3.3 同步映射表（核心交互）

```
┌──────────────────────┬───────────────────────┬────────────────┬──────────────────────────────┐
│ 同步的歌单（LX 全部）  │ 加入已有 Emby 歌单     │ 新建同名歌单   │ 同步策略                      │
├──────────────────────┼───────────────────────┼────────────────┼──────────────────────────────┤
│ ☑ 我喜欢的 (5首)      │ ☑ LX我喜欢的  ☐ 开车听  │ ☑             │ ☑定时同步此歌单               │
│                      │                       │                │ cron: [0 6 * * *] [快捷预设▼] │
│                      │                       │                │ 下次执行: 2026-09-05 06:00    │
│                      │                       │                │ 同步方式: ○增量 ●完全         │
│ ☑ 工作歌单 (38首)     │ ☐ 随便听听             │ ☑             │ ☐定时（仅手动） ○增量 ●完全    │
│ ☐ 新收藏 (12首)       │ （未勾选 = 不同步）      │               │                              │
└──────────────────────┴───────────────────────┴────────────────┴──────────────────────────────┘
```

行级语义：
- **勾选列** = 是否同步（方案 2：勾选与目标配置一页完成）
- **加入已有 Emby 歌单**：多选（一源多目标）；多源勾同一目标 = 聚合歌单（允许）
- **新建同名歌单**：与"加入已有"可同时勾；若 Emby 已存在同名歌单 → **提示冲突让用户处理**（行为 B，不自动追加）
- **cron 表达式**：直接输入（分 时 日 月 周），格式校验 + 快捷预设（每天6:00/每周三六5:00/仅周末/自定义）+ 实时显示"下次执行"；不勾定时 = 仅手动触发
- **同步方式**：增量（只加源中新增的歌）/ 完全（双向：新增下载 + 源中已删除的歌从目标 Emby 歌单移除）

全局开关（映射表底部）：☑ 自动纳入 LX 新建的歌单（新歌单即使未勾选也自动同步；默认目标 = 同名文件夹 + 新建同名 Emby 歌单，不加入任何已有歌单；可在映射表取消勾选）

---

## 四、页面 3：[任务进度]

- 每个已同步歌单一个区块：`歌单：我喜欢的（5首）` + [同步此歌单] 按钮（手动触发）
- 歌曲状态矩阵列：歌曲 | 音质 | 已入库 Emby | 已入歌单 | 状态 | 操作
- 状态值：成功 / 未满足（勾选音质范围内均拿不到）/ 失败（含原因：下载超时/校验不过/入库失败等）
- 行级 [重试]：只重下该首，成功后自动补 Emby 入库 + 入歌单（不重跑整批）
- 顶部当前任务状态：同步中 ████░ / 排队 / 空闲

---

## 五、页面 4：[历史记录]

- 同步批次时间线（按时间倒序）：
  ```
  2026-09-03 06:00  歌单：我喜欢的   ✅成功 2 | ❌失败 1 | ⏭未满足 1
      - 心要野 flac24bit ✅
      - YYY 失败：超时      [重试]
  ```
- 失败项 [重试] 按钮（重试成功自动补入库+入歌单）
- 批次持久化（SQLite），可翻页

---

## 六、页面 5：[日志]

- 本项目运行日志：调度 / 下载 / 校验 / 入库 / 歌单操作
- **转发 lxserver 侧报错**（下载失败等 lxserver 侧错误展示在此）
- 级别过滤（INFO/WARN/ERROR）+ 按日期查看

---

## 七、页面 6：[设置]

| 项 | 状态 |
|----|------|
| 通知配置（飞书 webhook + 开关 + 测试按钮） | **预留**：界面占位，功能后补 |
| 暂停所有同步（总开关） | 实现 |
| 日志保留天数 | 实现 |
| ☑ 自动纳入 LX 新建的歌单 | 实现（见同步设置页全局开关） |
| 高级选项：完全同步时清理无引用的孤立文件 | 实现（默认关） |

---

## 八、核心行为语义汇总

| 项 | 规则 |
|----|------|
| 未满足/失败 | 自动跳过，不阻塞整批 → 历史页手动 [重试] |
| 同名歌单冲突 | 提示冲突让用户处理，不自动追加 |
| 跨歌单重复歌曲 | 文件只下载一份（按歌曲 Id+音质去重），多个 Emby 歌单引用同一 Emby 歌曲（引用计数概念） |
| 加入已有歌单 | 幂等去重（已在歌单中的不重复加） |
| 删除的歌（完全同步） | 从目标 Emby 歌单移除；文件默认保留；开启"清理孤立文件"后删除无任何歌单引用的文件 |
| 定时触发冲突 | 触发瞬间已有任务在跑 → 跳过本次，等下次 |
| 音质验证 | 以实际文件验证为准（防伪 flac/翻唱/时长不符——内容级校验） |

---

## 九、文件流转

```
LX 歌单（loveList / 自建歌单）
  → 同步引擎：对比历史 → 新歌队列（增量）或全量比对（完全）
  → LX API 下载（songInfo 构造：hash 顶层 / 封面 picUrl / 歌词双份）
  → 落盘：<媒体库根路径>/<歌单名>/xxx.flac(+.lrc)
  → 校验（真音质 fLaC / 时长 / 歌手 / 版本词）
  → 触发 Emby 精确扫描（POST /Items/{LibraryId}/Refresh）
  → 按映射加入目标 Emby 歌单（幂等）
  → 更新历史记录 / 更新任务进度
```

---

## 十、预留项清单（以后扩展，暂不做）

1. 通知功能（设置页占位已留：渠道/开关/测试按钮）
2. 映射表行级"高级：音质覆盖"（某歌单单独覆盖全局音质偏好）
3. 首次使用引导向导

---

## 十一、数据模型设计（v1.0 定稿，2026-09-04）

### 存储决策
- **config.yaml**：连接 + 全局选项（lxserver/emby/download/general/notify）——可 docker env 注入 secrets
- **SQLite**：sync_task（界面编辑的任务映射）+ 全部运行时状态

### 全局配置（config.yaml）
```yaml
lxserver:
  baseUrl: ""        # 界面填
  apiKey: ""
  username: "king"   # ⚠️ x-user-name，lxserver 下载必需（非默认值）
emby:
  baseUrl: ""
  apiKey: ""
  libraryRoot: ""           # 媒体库根路径
  mediaLibraryId: ""        # ⚠️ 连接后自动探测（精确扫描用，用户不填）
download:
  qualities: [flac24bit, flac]           # 复选框保存，顺序固定高→低
  filenameTemplate: "[歌手] - [歌曲名] ([音质])"
  writeId3: true / writeCover: true / embedLyric: true / cacheLyric: false
  concurrency: 3 / retries: 2
general:
  autoIncludeNewPlaylists: false
  cleanupOrphanFiles: false
  pauseAll: false
  logRetentionDays: 30
notify:                # 预留
  enabled: false / feishuWebhook: ""
```

### sync_task（映射表每行）
id, lxPlaylistKey(`"loveList"`或`"user:<id>"`), lxPlaylistName(冗余), enabled,
embyTargetPlaylistIds(JSON数组,可多), createSameNamePlaylist(bool),
cronExpr(空=仅手动), syncMode(incremental/full), lastRunAt, lastResult

### SQLite 表（8 张）
| 表 | 作用 | 关键字段 |
|----|------|---------|
| sync_task | 任务配置 | 见上 |
| history_batch | 历史批次 | taskId, trigger(cron/manual), startedAt, finishedAt, result, 成功/失败/未满足/移除计数, detail |
| history_item | 批次明细 | batchId, songKey, 歌名/歌手, status, quality, filePath, errorReason, retriedAt |
| current_song_status | 进度页矩阵（持久化视图） | taskId+songKey 唯一, status, quality, 失败原因 |
| song_files | 文件级（歌+音质） | songKey, quality, fileName, path, size, verifiedQuality |
| task_song_ref | 任务↔文件引用计数 | taskId, songKey, fileId |
| emby_song_map | 歌曲↔Emby Id 幂等映射 | songKey, embySongId, lastVerifiedAt（Emby 重扫 Id 会变，需重验重搜） |
| playlist_snapshot | 完全同步删除检测 | taskId, 上次源歌单歌曲集合(JSON) |

### 关键语义
- **去重按歌**（songKey = 平台_songmid），**文件按 歌+音质** 存（song_files）
- 孤立文件判断 = song_files 中无任何 enabled task 引用
- 增量同步：拉源歌单 → 对比 current_song_status 成功项 → 新歌队列
- 完全同步：拉源歌单 → diff(playlist_snapshot) → 新增下载 + 从 Emby 歌单移除（+可选清文件）
- Emby 歌单加入幂等：先查 emby_song_map → 失效则重搜 Emby

---

## 十二、模块设计（v1.0 定稿，2026-09-04）

### 模块清单
| 模块 | 职责 |
|------|------|
| adapters/lxserver.ts | LX 唯一入口：归一解析器 + songInfo 构造（hash 顶层/封面）+ 401 自动重登；listPlaylists / getSongs / searchSong / resolveUrl / requestDownload |
| adapters/emby.ts | test / resolveLibraryId(自动探测) / scanLibrary(精确) / listPlaylists / createPlaylist / addItems / removeItems / findSong(重搜) |
| core/sync-engine.ts | 唯一流程编排：runTask(taskId, trigger) / retrySong(songKey, taskId)；内部 plan→downloadOne→validate→emby→record；事件广播（SSE 源） |
| core/validator.ts | 四重校验：fLaC 真音质 / 时长±15s / 歌手标签 / 版本词黑名单 → {ok, actualQuality, reasons} |
| core/file-manager.ts | renderFilename(模板，供界面预览复用) / moveToPlaylistDir / registerFile+unregisterFile(引用计数) / collectOrphans |
| store/ | SQLite：db(WAL+迁移) / tasks / history / songStatus / files / embyMap / snapshot |
| scheduler/cron.ts | 任务注册重载 / nextRun 实时计算 / 到点触发 engine |
| 事件总线 → SSE | EventEmitter：song-status / batch-progress → 浏览器自动刷新 |

### 关键决策
- **执行并发**：全局单飞（串行跑任务，最稳）；下载内部并发由音源限制（concurrency 3）
- **retrySong**：只重下该 songKey（不进 plan/diff），成功自动补 Emby 入库 + 加入目标歌单
- cron 触发与正在运行的任务冲突 → 跳过本次
- engine 是 store 的唯一写者之一（routes 只读写 sync_task 配置）；页面读 store 渲染

### 调用关系
```
[routes: pages/api/sse] ⇄ [store]（配置 CRUD + 页面读）
[routes/api] → engine.runTask / retrySong
[cron] → engine.runTask(id,'cron')
engine → lxserver / validator / file-manager / emby / store（写）
engine 事件 → SSE → 浏览器
```

---

## 附：技术路线要点（调研结论摘要）

- 语言：Node.js ≥22 + TypeScript（ESM）
- LX 对接：自建 adapter（归一解析器 + songInfo 工厂：hash 顶层等已知坑集中处理；401 自动重登）
- Emby 客户端：`@emby-utils/client`（官方 OpenAPI 生成，447 操作全覆盖）；精确扫描优于全库刷新
- 调度：每歌单 cron 表达式（node-cron）
- 存储：SQLite（better-sqlite3 + WAL）：历史记录 / 歌曲↔EmbyId 映射 / 歌单快照 / 引用计数；唯一索引幂等
- 校验：四重内容校验（时长±15s / 版本词过滤 / 歌手标签匹配 / fLaC 真音质探测）
- Docker：node:22-slim、卷挂载 /data（SQLite 容器外）、HEALTHCHECK /healthz、restart: unless-stopped、非 root
- 借鉴项目：mass-lxmusic-provider（归一/重试矩阵）、MyGodKnow/lx-music-downloader（四重校验）、tiancheng91/lxmusic（抽象分层）、Soularr（部署模式）

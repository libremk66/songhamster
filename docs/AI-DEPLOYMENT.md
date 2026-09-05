# AI 部署指南（SongFerry）

> 本文面向 **AI 代理/助手**：用户会把本文件连同需求交给你，由你完成部署与初始化。
> 请按顺序执行：每步含【目标】【动作】【验证】与失败时的【处理】。
> 歧义先问用户，不要猜测；涉及用户既有环境（已装的 lxserver/Emby）先确认再动。

---

## 0. 执行前须知

- 本部署会创建 3 个 Docker 容器：`lxserver`（音乐下载）、`emby`（媒体库）、`songferry`（本项目）。
- 用户环境可能**已有 lxserver / Emby**：先问清楚，走第 2 步的"对接已有服务"分支，不要重复部署。
- 所有需要用户提供的密钥（lxserver token、Emby API key）只能由用户提供，你不能自行获取。
- 本项目尚未发布镜像时：`songferry` 用 `node:22-slim` 挂载源码 `npm ci && npm run build && npm start`（或提示用户按 README 开发运行）。

---

## 1. 收集参数

先向用户收集以下参数，**复述确认后再动手**：

| 参数 | 说明 | 默认建议 |
|------|------|---------|
| `PATH_MUSIC` | 宿主机音乐共享目录（三个容器共用） | `/srv/songferry/music`（可让用户指定任意位置） |
| `PATH_SONGFERRY_DATA` | 本项目配置与数据库目录 | `PATH_MUSIC` 同级 `/srv/songferry/data` |
| lxserver 是否已部署 | 有则取：地址/端口/用户名(king)/用户 token | — |
| emby 是否已部署 | 有则取：地址/端口/API key | — |
| 端口占用 | 9527(lxserver) 8096(emby) 8935(本项目) 是否可用 | 冲突则换宿主机端口 |
| web 账号 | 后续 web 登录用（初始可不设，首次访问未启用认证） | admin / 由用户设 |

> 若 lxserver 用户 token 未知：需用户在 lxserver 后台（设置→用户）创建/查看；
> 若 Emby API key 未知：需用户在 Emby 后台（设置→高级→API 密钥）生成。

---

## 2. 生成 docker-compose.yml

### 分支 A：三服务全部新部署

写 `docker-compose.yml`（内容等价 docker-compose.example.yml，用第 1 步参数替换占位符）：

```yaml
services:
  lxserver:
    image: xcq0607/lxserver:latest
    container_name: lxserver
    restart: unless-stopped
    ports: ["19527:9527"]
    volumes:
      - ${PATH_MUSIC}:/server/music      # 关键：共享音乐目录
      - ${PATH_SONGFERRY_DATA}/lxserver:/server/data
      - ${PATH_SONGFERRY_DATA}/lxserver-logs:/server/logs
      - ${PATH_SONGFERRY_DATA}/lxserver-cache:/server/cache

  emby:
    image: emby/embyserver:latest
    container_name: emby
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes:
      - ${PATH_SONGFERRY_DATA}/emby-config:/config
      - ${PATH_MUSIC}:/media/music        # 关键：同一共享目录

  songferry:
    image: <待发布镜像或本地构建>          # 见 README 开发运行
    container_name: songferry
    restart: unless-stopped
    ports: ["8935:8935"]
    environment:
      SONGFERRY_AUTH_USER: <用户决定>         # 可选：设置则自动启用登录
      SONGFERRY_AUTH_PASSWORD: <用户决定>
      SONGFERRY_LXSERVER_URL: http://lxserver:9527
      SONGFERRY_LXSERVER_KEY: <lxserver 用户 token>
      SONGFERRY_EMBY_URL: http://emby:8096
      SONGFERRY_EMBY_KEY: <emby API key>
    volumes:
      - ${PATH_MUSIC}:/data/music          # 关键：同一共享目录
      - ${PATH_SONGFERRY_DATA}:/data
```

**验证**：`docker compose config` 无报错。

### 分支 B：已有 lxserver / emby（只加本项目）

```yaml
services:
  songferry:
    image: <镜像>
    container_name: songferry
    restart: unless-stopped
    ports: ["8935:8935"]
    environment:
      SONGFERRY_AUTH_USER/PASSWORD: ...
      SONGFERRY_LXSERVER_URL: http://<宿主IP>:<lxserver端口>
      SONGFERRY_LXSERVER_KEY: <token>
      SONGFERRY_EMBY_URL: http://<宿主IP>:<emby端口>
      SONGFERRY_EMBY_KEY: <key>
    volumes:
      - ${PATH_MUSIC}:/data/music      # PATH_MUSIC = 你 lxserver 的 music 落盘目录（宿主机）
      - ${PATH_SONGFERRY_DATA}:/data
```
> ⚠️ 分支 B 关键：`PATH_MUSIC` 必须等于 **lxserver 实际落盘目录**（即 lxserver 容器 music 卷对应的宿主机目录），否则本项目看不到下载的文件。
> 同时确保该目录也已被 Emby 挂载/媒体库覆盖（见第 5 步）。

---

## 3. 启动与健康检查

```bash
docker compose up -d
docker compose ps            # 三个容器应为 Up
```

验证各服务：
- lxserver：`curl http://127.0.0.1:<lx端口>/api/user/list`（带用户 token）返回 JSON
- emby：`curl http://127.0.0.1:8096/System/Info -H "X-Emby-Token: <key>"` 返回 JSON
- songferry：`curl http://127.0.0.1:8935/healthz` 返回 `{"ok":true}`

**处理**：容器未 Up → `docker compose logs` 查看；端口占用 → 换宿主机端口并同步改 URL。

---

## 4. Web 初始化（可用 curl 自动完成）

> 若设置了 `SONGFERRY_AUTH_USER`，所有请求需先登录：
> `POST /api/auth/login {username,password}` → 记住返回 cookie。

1. **写入连接配置**（POST 表单到 `/api/config/lx` 与 `/api/config/emby`，字段见连接容器页）：
   - lxserver：baseUrl（容器内 `http://lxserver:9527` 或宿主地址）、apiKey、username（下载用户名，默认 king）、downloadRoot=`/data/music`
   - emby：baseUrl、apiKey、libraryRoot（见第 5 步媒体库文件夹）
2. **运行路径自检**：`POST /api/paths/check` → 期望三行全绿（下载目录可写 + 媒体库匹配成功）。
   失败时按返回提示修复（多为卷未挂全/媒体库未建/视角填错）。
3. **曲库洗版目录**：无需配置，自动默认 `<downloadRoot>/曲库洗版`。

---

## 5. 在 Emby 建立音乐媒体库（AI 可自动执行）

- 目标：一个音乐媒体库（推荐名 `LX歌单同步`），文件夹 = Emby 容器内 `/media/music/歌单同步`。
- 可用 Emby API 创建（LibraryService.CreateVirtualFolder）：
  `POST /emby/Library/VirtualFolders?name=LX%E6%AD%8C%E5%8D%95%E5%90%8C%E6%AD%A5&collectionType=music&refreshLibrary=true`
  携带 JSON：`{"LibraryOptions":{"EnableInternetProviders":false},"Paths":["/media/music/歌单同步"]}`
- 若 API 创建失败（权限/版本差异）：**指导用户在 Emby 后台手动添加**（添加媒体库 → 类型"音乐" → 文件夹 `/media/music/歌单同步`）。
- 创建后执行本项目"探测媒体库"（`POST /api/emby/probe`，或让用户在界面点按钮），确认 `libraryRoot` 与 Id 已匹配（路径自检全绿为准）。

---

## 6. 端到端验证（必须）

1. 为用户创建至少一个任务（也可让用户在 web 添加）：
   `POST /api/tasks`，参数：`lxPlaylistKey=loveList`（"我喜欢的"）或用户指定的自建歌单 key、`createSameNamePlaylist=1`、`syncMode=incremental`。
   > 歌单 key 先 `GET /api/lx/playlists`（登录态）取得真实 key，不要猜测。
2. 触发同步 `POST /api/task/<id>/run`，等待完成（大歌单需几分钟）。
3. 检查结果：
   - 文件落盘：宿主机 `PATH_MUSIC/歌单同步/<歌单名>/` 出现 flac/mp3（含 .lrc）
   - 历史批次 `GET /api/history/partial`：`✅ 成功 N`、无红色失败（部分失败查看明细）
   - Emby 侧：媒体库新条目出现（`GET /emby/Items?ParentId=<libraryId>&IncludeItemTypes=Audio&Recursive=true&Limit=3`）
   - 同名 Emby 播放列表已创建且含歌曲（行为 B：若同名已存在则跳过创建并提示，按提示处理）

---

## 7. 收尾

- 告知用户：web 地址 `http://<nas>:8935`、初始账号、lxserver/emby 地址。
- 提醒：
  - 在 [设置→账号安全] 修改/启用登录密码（若用 env 已启用则改密）
  - [设置→高级设置] 查重默认关闭；[下载选项] 音质勾选按需
  - Emby 若需播放列表覆盖老库场景，可再建其它任务
- 输出部署摘要（参数与结果），请用户验收。

---

## 附录 A：故障速查（AI 诊断用）

| 症状 | 检查 | 修复 |
|------|------|------|
| songferry 找不到下载文件 | 路径自检"下载目录"行 | downloadRoot 容器路径与卷不一致；PATH_MUSIC 未挂给 songferry |
| Emby 扫不到 | `POST /api/paths/check` 媒体库行 / Emby 日志 | 媒体库文件夹 ≠ /media/music/歌单同步；未刷新库 |
| 任务一直失败"搜索失败/直链失败" | lxserver 用户 token 是否有效、音源是否可用 | 换 token；检查 lxserver 自定义源状态 |
| 同名歌单不自动建 | 行为 B 设计：同名已存在提示 | 需用户在界面处理或改目标（加入已有歌单） |
| 认证 401 | cookie 失效 | 重新 login |

## 附录 B：给用户的必要信息速查（AI 询问用）

1. 宿主机共享目录位置（PATH_MUSIC）
2. lxserver 是否已部署及其用户 token
3. Emby 是否已部署及其 API key
4. web 初始账号密码偏好
5. 需要同步哪些歌单（"我喜欢的"？哪些自建歌单？）
6. 端口是否有冲突

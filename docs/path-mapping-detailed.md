# 路径映射详解（LXServer × Emby × SongFerry）

SongFerry 做的事本质是：**LXServer 下载音乐 → SongFerry 整理移动 → Emby 扫描入库**。
三个服务必须访问**同一个音乐目录**——而 Docker 里每个容器只能看到自己挂载的路径。这就是路径容易搞混的根源。

## 一句话核心

> 宿主机上准备**一个音乐数据目录**，把它分别挂给三个容器（挂载点不同没关系）；
> 界面里填的每个路径，都是"**该容器自己看到的路径**"。

```
宿主机（唯一真相源）
/srv/lxmusic/
   ├─ 挂给 lxserver → 容器内 /server/music      LX 下载写这里
   ├─ 挂给 Emby    → 容器内 /media/music       媒体库扫描这里
   └─ 挂给 songferry → 容器内 /data/music        SongFerry 读/移动/洗版
```

---

## ① LXServer（官方 compose 实例）

官方 `docker-compose.yml`（用户提供）：
```yaml
version: '3'
services:
  lx-sync-server:
    image: xcq0607/lxserver:latest
    container_name: lx-sync-server
    restart: unless-stopped
    ports:
      - "9527:9527"
    volumes:
      - ./data:/server/data      # 配置/数据库/用户数据
      - ./logs:/server/logs
      - ./cache:/server/cache
      - ./music:/server/music    # ← 音乐下载落盘目录（关键）
    environment:
      - NODE_ENV=production
```

**解释**：
- 容器内固定路径：配置 `/server/data`、缓存 `/server/cache`、**音乐 `/server/music`**
- 用户在 LXServer 界面/设置里选定的"下载位置"若指向 `music`，则文件落在 `/server/music/<用户名>/...`
- 想与另外两个服务共享，**只需把宿主机同一目录挂到这里的 `/server/music`**

---

## ② Emby（compose 实例）

```yaml
services:
  emby:
    image: emby/embyserver:latest
    container_name: emby
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - ./emby-config:/config                     # Emby 配置
      - ./music:/media/music                      # ← 同一宿主机目录，挂到 /media/music
      # 其它媒体目录按需挂载
```

**解释（Emby 侧需要三步，不只是挂载）**：

1. **挂载**：compose 卷把共享目录挂进 Emby 容器（`./music:/media/music`）——这一步只是让 Emby **有权限看到**宿主机目录
2. **建媒体库**：登录 Emby 管理后台 → 添加媒体库（类型选"音乐"）→ 在"文件夹"步骤选择**该挂载点下的路径**作为媒体库文件夹
   - 推荐：媒体库文件夹指向 `歌单同步` 子目录（只索引 SongFerry 管理的歌单文件夹），例如 Emby 后台选 `/media/music/歌单同步`
   - 也可以指向整个 `/media/music`（范围更大，Emby 索引更慢）
3. **SongFerry 里的 `libraryRoot` 填什么**：填你**在 Emby 后台给该媒体库选的文件夹路径**（Emby 容器内视角，如 `/media/music/歌单同步`）——SongFerry 用它与 Emby API 返回的媒体库位置做匹配（也可以点界面"探测媒体库"自动识别并填入）

⚠️ 概念区分：
- **挂载点**（/media/music）= Emby 容器能看到共享目录的入口
- **媒体库文件夹路径**（如 /media/music/歌单同步）= Emby 里那个音乐媒体库实际索引的目录，它**位于挂载点之下**（或等于挂载点）
- SongFerry 的 `libraryRoot` 匹配的是后者（媒体库文件夹），不是简单等同"挂载路径"——挂载只是前提

---

## ③ SongFerry（本项目 compose 实例）

```yaml
services:
  songferry:
    image: your-registry/songferry:latest          # 替换为你的镜像
    container_name: songferry
    restart: unless-stopped
    ports:
      - "8935:8935"
    environment:
      SONGFERRY_AUTH_USER: admin
      SONGFERRY_AUTH_PASSWORD: change-me
      SONGFERRY_LXSERVER_URL: http://lx-sync-server:9527
      SONGFERRY_LXSERVER_KEY: <lx 用户 token>
      SONGFERRY_EMBY_URL: http://emby:8096
      SONGFERRY_EMBY_KEY: <emby api key>
    volumes:
      - ./music:/data/music     # ← 同一宿主机目录，挂到 /data/music（读/移动/洗版都在这）
      - ./songferry-data:/data    # SongFerry 配置(config.yaml)与数据库放这里
```

**解释**：
- `./music:/data/music`：SongFerry 要**读写**它（把 lxserver 落盘文件移动进歌单文件夹、校验、洗版输出）
- `./songferry-data:/data`：私有配置/数据库，不用共享

---

## 界面填写对照表

| 界面字段 | 填什么 | 为什么 |
|---------|--------|--------|
| LX 下载目录 `downloadRoot` | **本项目容器内** `/data/music` | SongFerry 要读写它（移动/校验/洗版） |
| Emby 媒体库根 `libraryRoot` | **Emby 容器内**的**媒体库文件夹路径**（Emby 后台给该媒体库选的路径，如 `/media/music/歌单同步`） | 与 Emby API 返回的媒体库位置匹配（可点"探测媒体库"自动识别） |
| 曲库洗版目录 | 默认 `/data/music/曲库洗版`（可改） | 独立目录，旧文件零触碰 |

**注意层级**：`downloadRoot` 填共享目录根（`/data/music`）即可——SongFerry 会自动在其下创建
`歌单同步/<歌单名>/` 存放歌单文件、`曲库洗版/` 存放洗版新版。
不要再往深指（如填到 `.../歌单同步` 会导致嵌套 `歌单同步/歌单同步/`）。

## 数据流转示意

```
LXServer 下载 → /server/music/<user>/xxx.flac（宿主机 ./music/xxx.flac）
                    │ SongFerry 移动
                    ▼
        /data/music/歌单同步/<歌单名>/xxx.flac（宿主机 ./music/歌单同步/...）
                    │ Emby 扫描 /media/music
                    ▼
        Emby 媒体库入库 → 加入播放列表
```

## 常见错误自查

| 症状 | 原因 | 修复 |
|------|------|------|
| 下载文件出现在 lxserver 但 SongFerry 找不到 | SongFerry 容器没挂这目录 / 挂载点路径填错 | 检查 `./music` 是否也挂给了 songferry；`downloadRoot` 填 `/data/music` |
| Emby 扫不到新歌单 | 媒体库文件夹没指向共享目录（或指向了别处） | 在 Emby 后台把媒体库文件夹指向共享目录挂载点下的路径（如 `/media/music/歌单同步`） |
| 路径自检报"目录不存在/不可写" | 填了容器内不存在的路径（如宿主机路径） | downloadRoot 必须填**本项目容器内**看到的路径 |
| 出现 `歌单同步/歌单同步/` | downloadRoot 指得太深 | downloadRoot 指向共享目录根 |
| 本机 npm run dev（非 Docker） | 无容器隔离 | downloadRoot 填宿主机路径；libraryRoot 填 Emby 里该媒体库显示的位置（如 /D8/.../LXSERVER/king/歌单同步） |

## 完整 compose 参考

见仓库根目录 `docker-compose.example.yml`（三段服务拼合版）。

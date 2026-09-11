# 路径映射（速览）

![三方部署：路径映射与界面填法](path-mapping-diagram.png)

> 上图一页看完：一个真实目录三方各挂一次 → 各容器看到的路径 → 「连接容器」页两个路径字段该填哪个视角 → 三个常见坑。
> 图源 `path-mapping-diagram.html`（改文字后浏览器截长图即可重出）。

三个程序共用**同一批音乐文件**。选一个宿主机文件夹 **[文件夹1]**，挂给三个容器，
它们各自用固定路径访问：

| 容器 | 访问 [文件夹1] 的固定路径 | 用途 |
|------|--------------------------|------|
| LXServer | `/server/music` | 下载音乐放这里 |
| Emby | `/media/music` | 扫描入库 |
| SongFerry | `/data/music` | 整理 / 移动 / 洗版 |

## 三步配置

**① 同一个 [文件夹1] 挂给三个容器**
```yaml
lxserver:  volumes: ["[文件夹1]:/server/music"]
emby:      volumes: ["[文件夹1]:/media/music"]
songferry:   volumes: ["[文件夹1]:/data/music"]
```

**② Emby 后台新建音乐媒体库**（推荐名"LX歌单同步"）
文件夹选 `/media/music/歌单同步`。
已有的其它音乐媒体库不受影响、无需改动。

**③ SongFerry 界面填两个路径，点"路径自检"**

| 界面框 | 填 |
|--------|-----|
| LX 下载目录 | `/data/music` |
| Emby 媒体库根 | `/media/music/歌单同步`（= ② 中媒体库选的文件夹） |

自检全绿即成功。

## 常见问题

| 现象 | 解决 |
|------|------|
| 找不到刚下载的文件 | 确认 [文件夹1] 挂给了三个容器 |
| Emby 扫不到新歌单 | ② 中文件夹必须选 `/media/music/歌单同步` |
| 自检报路径不可写 | LX 下载目录必须填 `/data/music` |
| 出现 歌单同步/歌单同步/ | 下载目录填成 `/data/music/歌单同步`，改回根 `/data/music` |

> 详细说明（逐行 compose、概念区分）见 [path-mapping-detailed.md](path-mapping-detailed.md)

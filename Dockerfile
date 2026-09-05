# ============================================================
# SongFerry — LX 歌单同步入库媒体库（Emby / 未来更多）
# 多阶段构建：Node 22 编译 → 精简运行镜像
#
# 构建:  docker build -t songferry .
# 运行:  参照 docker-compose.example.yml（挂载音乐目录 + data 卷）
# ============================================================
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 1) 先装依赖（利用层缓存；better-sqlite3 原生模块在此编译）
COPY package.json package-lock.json ./
RUN npm ci

# 2) 编译 TS → dist
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行镜像 ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# 运行时依赖（含编译好的 better-sqlite3 原生模块）
COPY --from=build /app/node_modules ./node_modules
# 编译产物 + 版本信息
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# eta 视图模板运行时读取（src/views/*.eta），必须带入镜像
COPY src/views ./src/views
# 静态资源（htmx / pico / 图标）
COPY static ./static

# 运行数据（config.yaml + songferry.db）挂载点
VOLUME /app/data

EXPOSE 8935
CMD ["node", "dist/server.js"]

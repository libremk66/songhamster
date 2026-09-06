# SongFerry UI 设计规范(迁移期现行版)

> 面向任何 AI/开发者修改本项目 UI。**改 UI 前先读本文件**,按规范执行;规范未覆盖处再问用户。
> 技术栈:DaisyUI v4 + Tailwind 类 + oklch 主题变量;eta 服务端模板(htmx 局部刷新),**无前端框架、无组件库抽象**。
> 本文件是历次"盲调"教训的沉淀,2026-09-06 由对话复盘整理。

---

## 0. 设计定位(一句话)

**紧凑工具型管理后台**(参考 Tabler/Postman 设置页),**不是**落地页/作品集:不要 hero、不要大留白、不要动效炫技。
目标用户:家用 NAS 维护者(lavender),桌面为主、手机可操作。

## 1. 全局密度表(唯一事实源:`src/views/render.ts` LAYOUT 内 `<style>` 密度块)

| 项 | 值 | 说明 |
|---|---|---|
| 控件高度 .btn/.input/.select/.textarea | **26px**(1.625rem) | 输入框规则带 `!important`(pico 桥特异性,勿删) |
| 控件字号 | 12px(.75rem) | 输入框同带 `!important` |
| 控件圆角 | .375rem | 输入框 `!important` |
| 输入框横内边距 | 0 .5rem | `!important` |
| 按钮横内边距 | .55rem | **贴文字,禁止宽体**(勿再加 px-6/px-8 类) |
| 主按钮 .btn-primary | 字号 11px/600 字重/内边距 .4rem | 填充型比描边按钮小一号 |
| 卡片内边距 .card-body | 14px(.875rem) | 默认,勿改页面级 p-* |
| 卡片标题 .card-title | .9rem | |
| 表单标签 .label-text | 12px(.75rem) | |
| 正文 body | 13px | |
| 移动端(<1024px)控件 | **34px** 回大 | 触控友好,写在移动 media 块 |

**调密度的正确姿势:只改 render.ts 密度块一处,全站生效;不要在页面里堆 p-* / text-* 另起炉灶。**

## 2. 响应式与布局模式

- 断点:≥1024px 桌面(左侧栏 300px,sticky);<1024px 移动(顶部汉堡 3.1rem + 滑出面板 280px,纯 CSS checkbox)
- 简单页:通栏卡片,页面容器 `space-y-4`
- **设置/连接型双栏**:`grid lg:grid-cols-[250px_minmax(0,1fr)] gap-4 items-start`,左栏选项列表(sticky)、右栏表单;移动端自动堆叠
- 移动端表格/长表单:横排内容允许横向滚动容器,禁止撑破视口(`main.content` 已设 min-width:0)

## 3. 按钮规范

- 三个层次:**主操作**(btn-primary,如"保存配置")/ 次操作(btn-outline,"测试连接")/ 弱操作(btn-ghost + border,"探测")
- 成组置于 `card-actions`(border-t 分隔);操作说明/结果 `<span class="text-sm">` 放按钮后,勿塞 text-xs 挤按钮行
- 密码眼睛按钮:`join` 结构 + `btn btn-outline join-item px-3`
- 结果文案避免跳动:固定位置占位
- **勿用 input-sm/btn-sm 制造第三套尺寸**(与全局 26px 打架;迁移期旧页面残留的 sm 会被全局规则统一)

## 4. 表单与信息层级

- 标签:`<span class="label-text text-sm font-medium mb-1">`(字号由 .label-text 全局接管)
- 字段提示:字段下方 `text-xs opacity-60`;必填:标签加 `<span class="text-error">*</span>`
- 输入框一律 `input input-bordered w-full`;两个字段并排用 `grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3`
- 服务/类型选择:放射性选项做成**彩色纯文字按钮**(见 §5),不放图标/字母头像

## 5. 服务识别色(connect 页 TC,color-mix 用法)

| 服务 | 色值 | | 服务 | 色值 |
|---|---|---|---|---|
| Emby | #0ea5e9 | | Subsonic | #34d399 |
| Navidrome | #a78bfa | | Jellyfin | #f472b6 |
| 道理鱼 | #f59e0b | | | |

瓦片通用样式在页面 `<style>`(connect.eta):底色 `color-mix(in oklab, var(--svc) 12%, transparent)`、描边 35%;hover 20%;选中(peer-checked)底色 26% + 描边 var(--svc) + 外圈。**半透明叠加保证明暗主题都自然。**

## 6. 主题变量(不要硬编码颜色)

一律 oklch 主题变量(--p/--bc/--b1/--base-*),via daisy 类或 `oklch(var(--p))`;只有"服务识别色"例外(§5,半透明叠加)。跟随系统深浅,禁写死 #fff/#000 背景。

## 7. ⚠️ pico 桥五坑(迁移期专用,每条都是踩过的坑)

pico.css 仍在布局中兜底老页面裸元素(TODO: 每页迁完删除),它**加载在 daisy.css 之后**且选择器特异性常更高:

1. **`input:not([type=checkbox]...)` 压过 `.input`**:输入框 42px 失效事故。→ 尺寸规则必须 `!important`(render.ts 密度块已带)
2. **`button[type=submit] { width:100% }`**:submit 按钮全被拉满宽。→ `button.btn[type="submit"] { width:auto }`(特异性反超)
3. **按钮 line-height:1.5 + 上下 padding 偏字**:文字/图标靠下。→ `button.btn { padding-block:0 !important; line-height:1 !important }`
4. **老页面裸元素(无 daisy 类)靠 pico 皮肤**:在整页迁完前,不要为"统一观感"去动裸元素选择器
5. 老页面的 htmx 局部片段(partials)同样依赖 pico 桥;片段样式随宿主页面走

**删除 pico 桥的条件:9 页 + 全部 partials 迁移完毕、桌面/移动全过验收。**

## 8. 开发流程铁律(改 UI 的每一步)

1. 改 `.ts`(含 render.ts)→ tsx watch 自动热更(进程内 eta 缓存同时清空)
2. 改 `.eta` → **必须重启 dev 进程**才生效(eta cache:true,tsx 不监听 .eta)。重启姿势见下
3. 新增 tailwind/daisy 类 → **必须 `npm run build:css`**(扫描 src/views + render.ts;产物 static/daisy.css 是 tracked 文件,一起提交)
4. 改完自查:本仓库已配截图自检 skill(见 `~/.claude/skills` 侧 ui-screenshot-check),登录 cookie 从 `data/songferry.db` 的 `auth_session` 表取(服务端已加 no-store,普通刷新即可)
5. 提交粒度:一页一 commit,中文消息

**dev 重启正确姿势(勿 pkill -f,会自杀)**:
```bash
ps aux | grep -E "tsx watch|npm run dev" | grep -v grep | awk '{print $2}' | xargs -r kill
ss -tln | grep 8935   # 必须无输出才算真释放
setsid bash -c 'nohup npm run dev >> server.log 2>&1 < /dev/null & echo $! > server.pid'
# 验证:端口 owner pid == server.pid;带 session cookie curl /connect grep 新标记
```

## 9. UI 迁移状态(2026-09-06)

| 页面 | 状态 |
|---|---|
| connect(连接容器) | ✅ 已完成(双栏布局) |
| login | ⚪ 保持 Pico 独立页,不动 |
| sync-setup(歌单同步) | ✅ 已完成(2026-09-06,照 connect 规范) |
| options(下载选项) | ✅ 已完成(2026-09-06) |
| settings | 🟡 表单页待迁(照 connect 规范) |
| charts(榜单订阅) | ✅ 已完成(2026-09-06) |
| progress(任务进度) | ✅ 已完成(2026-09-06) |
| history(历史记录) | ✅ 已完成(2026-09-06,双 tab+批次卡+明细/洗版表) |
| library / logs | 🟡 内容页待迁(卡片+表格) |
| partials ×9(task-table/progress-table/dupe-*/upgrade-*/history-items/chart-subs) | 🟡 与宿主页同迁 |

迁移顺序建议:表单页 → 内容页 → partials → **删 pico 桥 + render.ts 兼容 CSS**。

## 10. 设计纪律(移植自 Anthropic frontend-design,适用裁剪)

- **动手前一句话说明设计方向**(如"这页走紧凑双栏设置风"),再写代码
- 字体:**禁用 AI 默认字体套**(Inter/Roboto 系);本项目用系统字体栈,不引 web font;中文正文 13px 不动摇
- 一个页面强调色 ≤2;禁"三张等大功能卡"套路;禁大号数字+渐变小标签模板
- 可见文案逐一审:与真实行为一致、无 AI 幻觉措辞、不堆 emoji
- 图标统一 emoji 或少用,禁混搭多个图标体系

## 11. 每页完成验收清单(桌面 1280 + 移动 375 截图自查后交用户)

- [ ] 无横向滚动/元素溢出;长表格容器内滚动
- [ ] 按钮不换行、不挤压、文字居中(检查 line-height 坑)
- [ ] submit 按钮未满宽(检查 pico 坑 #2)
- [ ] 控件密度与全站一致(26px),无 input-sm/btn-sm 另类尺寸
- [ ] 明暗主题都过一遍(颜色对比、半透明叠加)
- [ ] htmx 局部刷新的片段样式与宿主一致、空态/加载态有文案
- [ ] 密码字段 eye 可切换;表单锁定态(disabled)可见
- [ ] 移动端:汉堡导航可用、表单可用、触控 34px

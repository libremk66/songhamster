import { Eta } from 'eta'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const VIEWS_DIR = path.join(process.cwd(), 'src', 'views')

/** 项目版本（package.json，侧栏显示用） */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    return String(pkg.version || '0.1.0')
  } catch {
    return '0.1.0'
  }
})()

const eta = new Eta({ views: VIEWS_DIR, cache: true, useWith: true })
// eta v4：resolvePath/readFile 是实例属性（配置后 render('file.eta') 按文件名读模板）
eta.resolvePath = (tpl: string) => (path.isAbsolute(tpl) ? tpl : path.join(VIEWS_DIR, tpl))
eta.readFile = (p: string) => readFileSync(p, 'utf8')

/** 渲染视图文件（无布局，body 片段） */
export function renderBody(name: string, data: Record<string, unknown>): string {
  return eta.render(name + '.eta', data)
}

/** 渲染整页：body 模板 + 布局包裹 */
export function renderPage(name: string, data: Record<string, unknown>): string {
  const body = renderBody(name, data)
  return eta.renderString(LAYOUT, { ...data, body })
}

/** 直接渲染字符串模板（htmx 片段用） */
export function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  return eta.renderString(tpl, data)
}

/** 整页布局（TS 字符串模板，含导航）；页面 body 通过 <%= it.body %> 注入 */
export const LAYOUT = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SongFerry - LX 歌单自动同步入库</title>
  <link rel="icon" type="image/svg+xml" href="/static/logo.svg">
  <link rel="stylesheet" href="/static/pico.css">
  <script src="/static/htmx.min.js"></script>
  <style>
    /* ===== 主题色：低饱和度绿色系（覆盖 pico 默认蓝） ===== */
    :root {
      --pico-primary: #8ac398 !important;
      --pico-primary-background: #8ac398 !important;
      --pico-primary-border: #74ab83 !important;
      --pico-primary-hover: #7db68c !important;
      --pico-primary-hover-background: #7db68c !important;
      --pico-primary-hover-border: #6ca07b !important;
      --pico-primary-hover-underline: rgba(138, 195, 152, .6) !important;
      --pico-primary-underline: rgba(138, 195, 152, .5) !important;
      --pico-primary-focus: rgba(138, 195, 152, .35) !important;
      --pico-primary-inverse: #fff !important;
    }
    [data-theme="dark"] {
      --pico-primary:#7fa889 !important;
      --pico-primary-background:#7fa889 !important;
      --pico-primary-border:#6d9778 !important;
      --pico-primary-hover:#8cb596 !important;
      --pico-primary-hover-background:#8cb596 !important;
      --pico-primary-hover-border:#7aa585 !important;
      --pico-primary-hover-underline:rgba(127, 168, 137, .6) !important;
      --pico-primary-underline:rgba(127, 168, 137, .5) !important;
      --pico-primary-focus:rgba(127, 168, 137, .25) !important;
      --pico-primary-inverse:#1a1a1a !important;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --pico-primary:#7fa889 !important;
        --pico-primary-background:#7fa889 !important;
        --pico-primary-border:#6d9778 !important;
        --pico-primary-hover:#8cb596 !important;
        --pico-primary-hover-background:#8cb596 !important;
        --pico-primary-hover-border:#7aa585 !important;
        --pico-primary-focus:rgba(127, 168, 137, .25) !important;
        --pico-primary-inverse:#1a1a1a !important;
      }
    }
    /* ===== pico 控件尺寸变量覆盖（根因：默认 spacing-vertical .75rem 撑高控件） ===== */
    :root {
      --pico-form-element-spacing-vertical:.18rem !important;
      --pico-form-element-spacing-horizontal:.45rem !important;
      --pico-font-size:100% !important;
    }

    /* ===== 布局：左侧纵向菜单 ===== */
    body.app { display: flex; min-height: 100vh; margin: 0; }
    aside.sidebar {
      width: 300px; flex-shrink: 0; padding: 1.6rem 1.4rem;
      border-right: 1px solid var(--pico-muted-border-color, #e2e2e2);
    }
    aside.sidebar .brand {
      font-weight: 800; font-size: 1.75rem; line-height: 1.1; margin-bottom: .3rem;
      display: flex; align-items: center; gap: .5rem;
    }
    aside.sidebar .brand img { width: 2.1rem; height: 2.1rem; border-radius: .35em; flex-shrink: 0; }
    aside.sidebar .brand-sub { font-size: 1.35rem; color: #8a8a8a; margin-bottom: 2rem; }
    aside.sidebar nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    aside.sidebar nav a {
      display: block; padding: .7rem 1rem; border-radius: 8px; font-size: 1.2em;
      color: #111; text-decoration: none;
    }
    [data-theme="dark"] aside.sidebar nav a { color: #e6e6e6; }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) aside.sidebar nav a { color: #e6e6e6; }
    }
    aside.sidebar nav a:hover { background: var(--pico-primary-focus, #e2eafc); }
    aside.sidebar nav a.active { font-weight: 700; background: var(--pico-primary-focus, #e2eafc); }
    /* 侧栏底部：帮助 / 版本 / 分割线 / 账号 */
    aside.sidebar { display: flex; flex-direction: column; }
    aside.sidebar .sidebar-foot { margin-top: auto; padding-top: .8rem; font-size: .88em; }
    aside.sidebar .foot-help { display:block; margin-bottom:.2rem; color: var(--pico-primary,#165dfc); text-decoration:none; }
    aside.sidebar .foot-ver { color:#8a8a8a; font-size:.82em; }
    aside.sidebar .foot-hr { border:0; border-top:1px solid #ddd; margin:.6rem 0; }
    aside.sidebar .foot-acct { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    aside.sidebar .foot-acct .u { font-size:1.8em; overflow:hidden; text-overflow:ellipsis; max-width: 180px; }

    /* ===== 右侧内容：水平居中，内容限宽 ===== */
    main.content {
      flex: 1; min-width: 0; padding: 1.4rem 2rem;
      display: flex; flex-direction: column; align-items: center;
    }
    .page { width: 100%; max-width: 1280px; }

    /* ===== 紧凑化覆盖 ===== */
    body { font-size: 14px; }
    h2 { font-size: 1.35em; margin-bottom: .55em; }
    h3 { font-size: 1.05em; margin-bottom: .3em; }
    article { padding: .75rem 1rem; margin-bottom: .8rem; }
    label { margin-bottom: .1rem; font-size: .88em; }
    input, select, textarea {
      height: 2rem; font-size: .88em; min-height: 0;
      margin-bottom: .3rem; box-sizing: border-box;
    }
    textarea { height: auto; }
    input[type="checkbox"], input[type="radio"] {
      appearance: auto; -webkit-appearance: auto;
      width: 1.05rem; height: 1.05rem;
      accent-color: var(--pico-primary, #165dfc);
      margin: 0 .3rem 0 0;
    }
    /* pico 强制 submit 全宽（button[type=submit]{width:100%}），同优先级覆盖 */
    button, button[type="submit"], input[type="submit"], input[type="button"], input[type="reset"] {
      width: auto; height: 1.9rem; padding: 0 .9rem; font-size: .86em;
      margin: 0; box-sizing: border-box;
    }
    form button { width: auto; }
    .btn-sm { height: 1.6rem; padding: 0 .6rem; font-size: .8em; }
    .btn-row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin:.5rem 0 .2rem; }
    .btn-row button {
      height: 1.9rem; padding: 0 .9rem; font-size: .86em;
      box-sizing: border-box; font-weight: 400; border: 1px solid transparent;
      margin: 0;
    }
    .btn-row button.secondary, .btn-row button.outline {
      border: 1px solid var(--pico-secondary-border, #b6b6b6);
    }
    .btn-row .msg { margin-left:.4rem; }
    .key-wrap { display: flex; gap: .3rem; }
    .key-wrap input { flex: 1; min-width: 0; }
    .key-eye { height: 2rem !important; flex-shrink: 0; }
    .inline-field { display:flex; align-items:center; gap:.45rem; margin-bottom:.25rem; }
    .inline-field input { width: 4.6rem; margin-bottom: 0; }
    /* 设置页字段行：标签等宽 + 输入框 + 说明独立缩进行 */
    .prot-field { margin-bottom: .5rem; }
    .prot-field .row1 { display:flex; align-items:center; gap:.6rem; }
    .prot-field .row1 > span { width: 9.5em; flex-shrink: 0; }
    .prot-field .row1 input { width: 6rem; margin-bottom: 0; }
    .prot-field .hint { margin: .15rem 0 0 10.1em; }
    /* 新增同步任务：流程式布局 */
    .flow-box {
      border: 1.5px solid var(--pico-primary, #165dfc);
      border-radius: 8px;
      padding: .9rem 1rem .5rem;
      margin-bottom: .7rem;
      background: #f1f6f2;
    }
    .add-flow { display:flex; gap:1rem; align-items:flex-start; }
    .add-flow .lx-col { width: 300px; flex-shrink: 0; display:flex; gap:.5rem; align-items:flex-start; }
    .add-flow .target-col { display:flex; gap:.5rem; align-items:flex-start; }
    .svc-icon-col {
      display:flex; flex-direction:column; align-items:center; gap:.35rem;
      width: 40px; flex-shrink: 0;
    }
    .svc-icon-col img { width: 34px; height: 34px; border-radius: 7px; }
    .svc-icon-col .btn-sm { height: 1.5rem; padding: 0 .45rem; font-size: .74em; }
    .add-flow .arrow-col {
      display:flex; flex-direction:column; align-items:center; gap:.15rem;
      width: 130px; flex-shrink: 0; padding-top: 1rem; text-align:center;
    }
    .arrow-label { font-size:.78em; color:#666; line-height:1.25; white-space:nowrap; }
    .arrow-icon img { width: 1.6rem; height: 1.6rem; border-radius:.25rem; }
    .add-flow .target-col { flex:1; min-width: 260px; }
    .add-flow .opt { display:flex; align-items:center; gap:.3rem; margin:.2rem 0; }
    .opt-hint { margin: -.05rem 0 .2rem 1.35rem; color:#8a8a8a; font-size:.8em; }
    .existing-box { margin:.25rem 0 0 1.3rem; padding-left:.6rem; border-left:2px solid #ddd; }
    /* 媒体库勾选行：单行不折行，路径超长省略 */
    .lib-check { display:flex; align-items:center; gap:.4rem; margin:.18rem 0; white-space:nowrap; }
    .lib-check .lc-name { flex:0 0 auto; overflow:hidden; text-overflow:ellipsis; }
    .lib-check .lc-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.78em; color:#8a8a8a; }
    .line { display:flex; align-items:center; gap:.5rem; margin:.5rem 0; flex-wrap:wrap; }
    .line > span:first-child { white-space:nowrap; }
    .line select { width: auto; margin-bottom:0; }
    .line input { width: 12rem; margin-bottom:0; }
    /* 同步方式解释：独占下一行（不挤在 select 后、不超框），可折行 */
    .mode-desc {
      flex-basis: 100%;
      margin: .15rem 0 0 0;
      font-size: .82em; color: #555; line-height: 1.45;
    }
    /* 同步任务历史批次统计 */
    .batch-head { display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; }
    .batch-stats { display:flex; gap:1rem; flex-wrap:wrap; margin-top:.35rem; font-size:.88em; }
    .st-ok { color:#2f9e44; } .st-bad { color:#e03131; }
    .st-warn { color:#e8590c; } .st-skip { color:#8a8a8a; }
    /* 历史记录页：标签切换 */
    .hist-tab { border: 1px solid #ccc; background: transparent !important; color: var(--pico-primary, #165dfc); }
    .hist-tab.active {
      background: var(--pico-primary, #165dfc) !important;
      border-color: var(--pico-primary, #165dfc) !important;
      color: #fff !important;
      font-weight: 600 !important;
    }
    .hist-tab:not(.active):hover { background: var(--pico-primary-focus, rgba(138,195,152,.25)) !important; }
    .hist-old td { color: #777; }
    .hist-new td { color: #2f9e44; }
    .hist-tag { font-weight: 600; white-space: nowrap; width: 3em; }
    .hist-status { margin-top: .3rem; }
    /* 匹配分说明框（可折叠） */
    details.match-details {
      border: 1px solid var(--pico-primary, #165dfc); border-radius: 8px;
      margin: .8rem 0; padding: .5rem .9rem; background: #f1f6f2;
    }
    details.match-details summary { cursor: pointer; font-weight: 600; color: var(--pico-primary, #165dfc); }
    .match-body { margin-top: .5rem; padding-left: .2rem; font-size: .9em; }
    .match-item { margin-bottom: .35rem; }
    .match-title { font-weight: 600; color: #333; }
    .match-rules { margin: .1rem 0 0 1.2rem; padding: 0; list-style: none; color: #555; }
    .match-note { margin: .4rem 0 0; color: #666; line-height: 1.5; }
    /* 查重历史分页：当前页签高亮 */
    .btn-sm.current { background: var(--pico-primary, #165dfc) !important; color: #fff; }
    .task-edit-form { padding:.4rem 0; }
    table { font-size: .88em; }
    table th, table td { padding: .25rem .5rem; }
    .hint { color:#8a8a8a; font-size:.84em; }
    .ok { color:#2f9e44; } .bad { color:#e03131; }
    .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 0 .9rem; }
    .grid3 { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 .9rem; }
    .multi-box { max-height:9em; overflow:auto; border:1px solid #d6d6d6; border-radius:6px; padding:.35rem .5rem; }
    .checkbox-row { display:flex; gap:1.4rem; flex-wrap:wrap; align-items:center; margin:.25rem 0; }
    .checkbox-row label { display:flex; align-items:center; gap:.25rem; margin-bottom:0; }
    p { margin-bottom: .4rem; }
  </style>
</head>
<body class="app">
  <aside class="sidebar">
    <div>
      <div class="brand"><img src="/static/logo.svg" alt="logo">SongFerry</div>
      <div class="brand-sub">LX 歌单自动同步入库</div>
      <nav>
        <ul>
          <% for (const item of it.nav) { %>
            <li><a href="/<%= item.id %>" class="<%= item.id === it.active ? 'active' : '' %>"><%= item.label %></a></li>
          <% } %>
        </ul>
      </nav>
    </div>
    <div class="sidebar-foot">
      <% if (it.githubUrl) { %>
        <a class="foot-help" href="<%= it.githubUrl %>" target="_blank" rel="noopener">帮助</a>
      <% } %>
      <div class="foot-ver">v<%= it.version %></div>
      <hr class="foot-hr">
      <div class="foot-acct">
        <% if (it.authEnabled) { %>
          <span class="u">👤 <%= it.authUser || '未登录' %></span>
          <% if (it.authUser) { %>
            <form method="post" action="/api/auth/logout" style="display:inline">
              <button type="submit" class="btn-sm secondary">登出</button>
            </form>
          <% } %>
        <% } else { %>
          <span class="u" style="color:#8a8a8a">认证未启用</span>
        <% } %>
      </div>
    </div>
  </aside>
  <main class="content">
    <div class="page">
    <%~ it.body %>
    </div>
  </main>
</body>
</html>
`

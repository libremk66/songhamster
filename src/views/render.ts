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

import { fmtLocal } from './fmt.js'

const eta = new Eta({ views: VIEWS_DIR, cache: true, useWith: true })
// eta v4：resolvePath/readFile 是实例属性（配置后 render('file.eta') 按文件名读模板）
eta.resolvePath = (tpl: string) => (path.isAbsolute(tpl) ? tpl : path.join(VIEWS_DIR, tpl))
eta.readFile = (p: string) => readFileSync(p, 'utf8')

/** 渲染视图文件（无布局，body 片段）——自动注入 fmtLocal（时间本地化展示） */
export function renderBody(name: string, data: Record<string, unknown>): string {
  return eta.render(name + '.eta', { fmtLocal, ...data })
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

/** 整页布局（DaisyUI + htmx）
 * 响应式策略：
 *  - ≥lg（桌面）：左侧侧栏 (aside.sidebar)，菜单竖排
 *  - <lg（移动）：侧栏收进 daisy drawer，底部 5 tab (btm-nav) 常驻
 * 主题：默认跟系统（prefers-color-scheme），可手动切换 light/dark/corporate
 *       data-theme="" 时由 daisy 跟随系统，否则锁定
 */
export const LAYOUT = `<!doctype html>
<html lang="zh-CN" data-theme="<%= it.theme || '' %>">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>SongFerry - LX 歌单自动同步入库</title>
  <link rel="icon" type="image/svg+xml" href="/static/logo.svg">
  <link rel="stylesheet" href="/static/daisy.css">
  <!-- TODO(迁移期): 内容页仍为 Pico 标记（裸 button/input/table），daisy 的 preflight 会重置其样式；
        pico 置于 daisy 之后兜底老页面元素样式，Step2 逐页换成 daisy 类后删除本行 -->
  <link rel="stylesheet" href="/static/pico.css">
  <script src="/static/htmx.min.js"></script>
  <style>
    /* ===== SongFerry 布局微调（基于 DaisyUI 主题变量） ===== */
    body.app { display: flex; min-height: 100vh; margin: 0; padding-bottom: .75rem; } /* 底部留白(移动端) */
    @media (min-width: 1024px) { body.app { padding-bottom: 0; } } /* 桌面无底部留白 */
    aside.sidebar {
      width: 300px; flex-shrink: 0; padding: 1.6rem 1.4rem;
      border-right: 1px solid oklch(var(--bc) / 0.15);
      display: none; /* 移动端默认隐藏 */
    }
    @media (min-width: 1024px) { aside.sidebar { display: flex; flex-direction: column; } }
    aside.sidebar .brand { font-weight: 800; font-size: 1.75rem; line-height: 1.1; margin-bottom: .3rem; display: flex; align-items: center; gap: .5rem; }
    aside.sidebar .brand img { width: 2.1rem; height: 2.1rem; border-radius: .35em; flex-shrink: 0; }
    aside.sidebar .brand-sub { font-size: 1.35rem; color: oklch(var(--bc) / 0.6); margin-bottom: 2rem; }
    aside.sidebar nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    aside.sidebar nav a { display: block; padding: .7rem 1rem; border-radius: 8px; font-size: 1.2em; color: oklch(var(--bc)); text-decoration: none; }
    aside.sidebar nav a:hover { background: oklch(var(--p) / 0.15); }
    aside.sidebar nav a.active { font-weight: 700; background: oklch(var(--p) / 0.2); color: oklch(var(--p)); }
    aside.sidebar .sidebar-foot { margin-top: auto; padding-top: .8rem; font-size: .88em; }
    aside.sidebar .foot-help { display:block; margin-bottom:.2rem; color: oklch(var(--p)); text-decoration:none; }
    aside.sidebar .foot-ver { color: oklch(var(--bc) / 0.6); font-size: .82em; }
    aside.sidebar .foot-hr { border:0; border-top:1px solid oklch(var(--bc) / 0.15); margin:.6rem 0; }
    aside.sidebar .foot-acct { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    aside.sidebar .foot-acct .u { font-size:1.8em; overflow:hidden; text-overflow:ellipsis; max-width: 180px; }

    main.content { flex: 1; min-width: 0; padding: 1.4rem 2rem; display: flex; flex-direction: column; align-items: center; }
    .page { width: 100%; max-width: 1280px; }

    /* ===== 紧凑密度：控件 26px、输入 12px、按钮瘦身贴文字、卡片内边距 14px ===== */
    .btn { height: 1.625rem; min-height: 1.625rem; padding-left: .55rem; padding-right: .55rem; font-size: .75rem; border-radius: .375rem; }
    /* ===== 全站品牌绿(唯一强调色;error 红保留功能性) =====
       --sfg:亮绿(填充/徽章/状态点)  --sfg-deep:深绿(链接/文字/描边)  --sfg-ink:绿上深字 */
    :root {
      --sfg: oklch(0.7 0.12 153);
      --sfg-deep: oklch(0.44 0.1 152);
      --sfg-ink: oklch(0.16 0.03 152);
    }
    /* 钉死根字号 16px:pico 桥 :root{font-size:var(--pico-font-size)} 在宽屏放大到 125%(20px),
       会把所有 rem 尺寸(控件 26px 等)实际放大 25% */
    :root { font-size: 16px; }
    /* 复选框/单选勾选色统一品牌绿 */
    input[type="checkbox"], input[type="radio"] { accent-color: var(--sfg); }
    .checkbox { --chkbg: var(--sfg); --chkfg: var(--sfg-ink); border-color: oklch(var(--bc) / 0.35); }
    .checkbox:checked { border-color: var(--sfg); }
    html[data-theme="light"], html[data-theme="dark"], html[data-theme="corporate"], html[data-theme=""] {
      --p: var(--sfg-deep); --pf: oklch(0.38 0.1 152); --pc: oklch(0.97 0.01 152);
      --su: var(--sfg); --suf: oklch(0.62 0.12 153); --suc: var(--sfg-ink);
      --wa: oklch(0.8 0.07 152); --waf: oklch(0.74 0.09 152); --wac: oklch(0.28 0.07 152);
    }
    /* 主操作(填充型):亮绿底 + 深绿字;字号 11px、窄内边距 */
    .btn-primary { padding-left: .4rem; padding-right: .4rem; font-size: .6875rem; font-weight: 600;
                   background-color: var(--sfg); border-color: var(--sfg); color: var(--sfg-ink); }
    .btn-primary:hover, .btn-primary:focus-visible { background-color: oklch(0.62 0.12 153); border-color: oklch(0.62 0.12 153); }
    .btn-primary:active { background-color: oklch(0.56 0.12 153); border-color: oklch(0.56 0.12 153); }
    .btn-primary:disabled { background-color: oklch(0.8 0.06 153); border-color: oklch(0.8 0.06 153); color: oklch(0.35 0.04 152); }
    /* 次级按钮统一绿(必须显式接管:pico 桥 [type=button] 等属性选择器与 .btn-outline 同特异性且排后,
       不写即被 pico 涂成蓝色) */
    .btn-outline { background-color: transparent; border-color: color-mix(in oklab, var(--sfg-deep) 45%, transparent); color: var(--sfg-deep); }
    .btn-outline:hover { background-color: color-mix(in oklab, var(--sfg) 20%, transparent); border-color: var(--sfg-deep); color: var(--sfg-deep); }
    .btn-ghost { background-color: transparent; color: var(--sfg-deep); }
    .btn-ghost:hover { background-color: color-mix(in oklab, var(--sfg) 20%, transparent); color: var(--sfg-deep); }
    /* pico 桥对 button[type=submit] 强制 width:100%(特异性更高),钉回自适应宽度 */
    button.btn[type="submit"] { width: auto; }
    /* pico 桥的 line-height:1.5+上下内边距会把文字挤偏;去上下内边距 + line-height:1,交还 flex 居中 */
    button.btn { padding-top: 0 !important; padding-bottom: 0 !important; line-height: 1 !important; }
    /* !important: pico 桥的 input:not(...) 属性选择器特异性更高,不加 important 会被压回 ~42px */
    .input, .select, .textarea { height: 1.625rem !important; min-height: 1.625rem !important; font-size: .75rem !important; padding: 0 .5rem !important; border-radius: .375rem !important; }
    .card-body { padding: .875rem; }
    .card-title { font-size: .9rem; }
    .label-text { font-size: .75rem; font-weight: 650; }
    /* 语义次级文字色(LxBridge 借鉴:固定灰阶代替 opacity 混用,主题变量半透明稳定) */
    .c-sub { color: oklch(var(--bc) / 0.62); }  /* 说明/提示级 */
    .c-mid { color: oklch(var(--bc) / 0.78); }  /* 弱强调级(原 opacity-70/80 用途) */
    /* 通用栅格(全站共用:表单双列 / 标签行)——tailwind 变体类在项目内不可靠,统一自带 CSS */
    .fg { display: grid; grid-template-columns: 1fr; gap: .75rem 1.25rem; }
    @media (min-width: 768px) { .fg { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .flow-label-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .3rem; }

    /* ===== 兼容 Pico 旧类（迁移期间过渡，逐步移除） ===== */
    body { font-size: 13px; }
    h2 { font-size: 1.35em; margin-bottom: .55em; }
    h3 { font-size: 1.05em; margin-bottom: .3em; }
    .hint { color: oklch(var(--bc) / 0.6); font-size: .84em; }
    .ok { color: oklch(0.6 0.15 145); }
    .bad { color: oklch(0.6 0.2 25); }
    .btn-sm { font-size: .8em; padding: 0 .6rem; }
    .btn-row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin:.5rem 0 .2rem; }
    .btn-row .msg { margin-left:.4rem; }
    .key-wrap { display: flex; gap: .3rem; }
    .key-wrap input { flex: 1; min-width: 0; }
    .key-eye { flex-shrink: 0; }
    .inline-field { display:flex; align-items:center; gap:.45rem; margin-bottom:.25rem; }
    .inline-field input { width: 4.6rem; margin-bottom: 0; }
    .prot-field { margin-bottom: .5rem; }
    .prot-field .row1 { display:flex; align-items:center; gap:.6rem; }
    .prot-field .row1 > span { width: 9.5em; flex-shrink: 0; }
    .prot-field .row1 input { width: 6rem; margin-bottom: 0; }
    .prot-field .hint { margin: .15rem 0 0 10.1em; }
    .flow-box { padding: .9rem 1rem .5rem; margin-bottom: .7rem; border: 1.5px solid oklch(var(--p) / 0.4); border-radius: 8px; }
    .add-flow { display:flex; gap:1rem; align-items:flex-start; }
    .add-flow .lx-col { width: 300px; flex-shrink: 0; display:flex; gap:.5rem; align-items:flex-start; }
    .add-flow .target-col { display:flex; gap:.5rem; align-items:flex-start; }
    .svc-icon-col { display:flex; flex-direction:column; align-items:center; gap:.35rem; width: 40px; flex-shrink: 0; }
    .svc-icon-col img { width: 34px; height: 34px; border-radius: 7px; }
    .svc-icon-col .btn-sm { height: 1.5rem; padding: 0 .45rem; font-size: .74em; }
    .add-flow .arrow-col { display:flex; flex-direction:column; align-items:center; gap:.15rem; width: 130px; flex-shrink: 0; padding-top: 1rem; text-align:center; }
    .arrow-label { font-size:.78em; color:#666; line-height:1.25; white-space:nowrap; }
    .arrow-icon img { width: 1.6rem; height: 1.6rem; border-radius:.25rem; }
    .add-flow .target-col { flex:1; min-width: 260px; }
    .add-flow .opt { display:flex; align-items:center; gap:.3rem; margin:.2rem 0; }
    .opt-hint { margin: -.05rem 0 .2rem 1.35rem; color:#8a8a8a; font-size:.8em; }
    .existing-box { margin:.25rem 0 0 1.3rem; padding-left:.6rem; border-left:2px solid #ddd; }
    .lib-check { display:flex; align-items:center; gap:.4rem; margin:.18rem 0; white-space:nowrap; }
    .lib-check .lc-name { flex:0 0 auto; overflow:hidden; text-overflow:ellipsis; }
    .lib-check .lc-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.78em; color:#8a8a8a; }
    .line { display:flex; align-items:center; gap:.5rem; margin:.5rem 0; flex-wrap:wrap; }
    .line > span:first-child { white-space:nowrap; }
    .line select { width: auto; margin-bottom:0; }
    .line input { width: 12rem; margin-bottom:0; }
    .mode-desc {
      flex-basis: 100%;
      margin: .15rem 0 0 0;
      font-size: .82em; color: #555; line-height: 1.45;
    }
    .batch-head { display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; }
    .batch-stats { display:flex; gap:1rem; flex-wrap:wrap; margin-top:.35rem; font-size:.88em; }
    .st-ok { color:#2f9e44; } .st-bad { color:#e03131; }
    .st-warn { color:#e8590c; } .st-skip { color:#8a8a8a; }
    details.match-details {
      border: 1px solid oklch(var(--p)); border-radius: 8px;
      margin: .8rem 0; padding: .5rem .9rem;
    }
    details.match-details summary { cursor: pointer; font-weight: 600; color: oklch(var(--p)); }
    .match-body { margin-top: .5rem; padding-left: .2rem; font-size: .9em; }
    .match-item { margin-bottom: .35rem; }
    .match-title { font-weight: 600; color: oklch(var(--bc)); }
    .match-rules { margin: .1rem 0 0 1.2rem; padding: 0; list-style: none; color: oklch(var(--bc) / 0.7); }
    .match-note { margin: .4rem 0 0; color: oklch(var(--bc) / 0.7); line-height: 1.5; }
    table { font-size: .88em; }
    table th, table td { padding: .25rem .5rem; }
    .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 0 .9rem; }
    .grid3 { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 .9rem; }
    .multi-box { max-height:9em; overflow:auto; border:1px solid oklch(var(--bc) / 0.2); border-radius:6px; padding:.35rem .5rem; }
    .checkbox-row { display:flex; gap:1.4rem; flex-wrap:wrap; align-items:center; margin:.25rem 0; }
    .checkbox-row label { display:flex; align-items:center; gap:.25rem; margin-bottom:0; }
    p { margin-bottom: .4rem; }

    /* ===== 移动端导航(<1024px):顶部汉堡条 + 左侧滑出面板;checkbox hack 无 JS ===== */
    #nav-toggle { display: none; }
    .mob-nav, .mob-backdrop, .mob-panel { display: none; }
    @media (max-width: 1023.98px) {
      .mob-nav {
        display: flex; align-items: center; gap: .6rem;
        position: fixed; top: 0; left: 0; right: 0; z-index: 70;
        height: 3.1rem; padding: 0 .8rem;
        background: oklch(var(--b1) / .92); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        border-bottom: 1px solid oklch(var(--bc) / .12);
      }
      .mob-nav .burger {
        display: inline-flex; align-items: center; justify-content: center;
        width: 2.3rem; height: 2.3rem; border-radius: 8px; cursor: pointer;
        border: 1px solid oklch(var(--bc) / .25); background: transparent; color: oklch(var(--bc));
        font-size: 1.3rem; line-height: 1;
      }
      .mob-nav .burger:active { background: oklch(var(--p) / .2); }
      .mob-nav .mob-brand { font-weight: 800; font-size: 1.12rem; }
      .mob-backdrop {
        position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.45);
        opacity: 0; pointer-events: none; transition: opacity .18s ease;
      }
      .mob-panel {
        display: flex; flex-direction: column;
        position: fixed; top: 0; left: 0; bottom: 0; z-index: 90;
        width: 280px; max-width: 84vw;
        background: oklch(var(--b1)); padding: 1.1rem 1rem;
        box-shadow: 0 0 24px rgba(0,0,0,.25);
        transform: translateX(-106%); transition: transform .2s ease;
      }
      #nav-toggle:checked ~ .mob-backdrop { opacity: 1; pointer-events: auto; }
      #nav-toggle:checked ~ .mob-panel { transform: translateX(0); }
      .mob-panel .mob-head { display: flex; align-items: center; gap: .5rem; font-weight: 800; font-size: 1.5rem; }
      .mob-panel .mob-logo { width: 2rem; height: 2rem; border-radius: .35em; }
      .mob-panel .mob-sub { color: oklch(var(--bc) / .6); font-size: .95rem; margin: .15rem 0 1.4rem; }
      .mob-panel ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; overflow-y: auto; }
      .mob-panel li a { display: block; padding: .72rem .9rem; border-radius: 9px; font-size: 1.06em; color: oklch(var(--bc)); text-decoration: none; }
      .mob-panel li a:hover { background: oklch(var(--p) / .15); }
      .mob-panel li a.active { font-weight: 700; background: oklch(var(--p) / .2); color: oklch(var(--p)); }
      .mob-panel .mob-foot { margin-top: auto; padding-top: .7rem; border-top: 1px solid oklch(var(--bc) / .15); font-size: .82em; color: oklch(var(--bc) / .6); }
      /* 移动端触控友好:控件回大到 34px */
      .btn { height: 2.125rem; min-height: 2.125rem; font-size: .8125rem; }
      .input, .select, .textarea { height: 2.125rem !important; min-height: 2.125rem !important; font-size: .8125rem !important; }
      main.content { padding: 4.4rem .7rem 1rem; } /* 顶部让出汉堡条高度 */
    }
  </style>
</head>
<body class="app">

  <!-- 移动端(<1024px)导航:汉堡按钮 checkbox 驱动,点击滑出面板 -->
  <input type="checkbox" id="nav-toggle" autocomplete="off" aria-hidden="true">
  <header class="mob-nav">
    <label for="nav-toggle" class="burger" role="button" aria-label="打开菜单" title="菜单">☰</label>
    <span class="mob-brand">🎵 SongFerry</span>
  </header>
  <label for="nav-toggle" class="mob-backdrop" aria-hidden="true"></label>

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
              <button type="submit" class="btn btn-ghost btn-xs px-2">登出</button>
            </form>
          <% } %>
        <% } else { %>
          <span class="u" style="color:oklch(var(--bc)/0.6)">认证未启用</span>
        <% } %>
      </div>
    </div>
  </aside>

  <main class="content">
    <div class="page">
    <%~ it.body %>
    </div>
  </main>

  <!-- 移动端菜单面板(桌面端 display:none 不渲染影响) -->
  <nav class="mob-panel" aria-label="移动端导航">
    <div class="mob-head"><img src="/static/logo.svg" alt="logo" class="mob-logo">SongFerry</div>
    <div class="mob-sub">LX 歌单自动同步入库</div>
    <ul>
      <% for (const item of it.nav) { %>
        <li><a href="/<%= item.id %>" class="<%= item.id === it.active ? 'active' : '' %>"><%= item.label %></a></li>
      <% } %>
    </ul>
    <div class="mob-foot">v<%= it.version %> · <% if (it.authEnabled && it.authUser) { %>👤 <%= it.authUser %><% } else if (it.authEnabled) { %>未登录<% } else { %>认证未启用<% } %></div>
  </nav>

  <script>
// ===== 全局：同步任务表单辅助（歌单同步页共用） =====
var MODE_DESC = {
  incremental: '增量：只下载源歌单里新增的歌，已成功的歌不重复处理。例：LX 歌单加了 2 首新歌 → 只下载这 2 首并加入目标歌单；其它已下载的歌不动。',
  full: '完全：<%= it.targetName %> 播放列表向 LX 歌单看齐（以 LX 为准，单向同步）——LX 新增的歌会下载并加入；你在 LX 歌单里删除的歌，也会从 <%= it.targetName %> 播放列表中移除（本地文件默认保留）。例：删了 LX 歌单 3 首 → 同步后 <%= it.targetName %> 播放列表同步移除这 3 首。'
}
function toggleExistingId(el, suffix) {
  var box = document.getElementById('existing-box' + suffix)
  if (box) box.style.display = el.checked ? '' : 'none'
}
function showModeDescId(sel, suffix) {
  var d = document.getElementById('mode-desc' + suffix)
  if (d) d.textContent = MODE_DESC[sel.value] || ''
}
  </script>
</body>
</html>
`

/**
 * 「删除任务」确认框（歌单同步页 / 榜单订阅页共用同一份，避免两处文案走样）。
 *
 * 三个复选框 = 用户自己决定连带删什么（File / Playlist / History），
 * 不再用一句"确认删除？"让用户猜。语义与 rules：
 *   · 文件：移入回收站（可恢复）；仍被其它任务引用的会保留（共享保护）
 *   · 歌单：只移除**本任务加入过**的歌（归属保护），歌单容器本身不删
 *   · 历史：删该任务的历史批次；**删历史不影响以后同步**（不会因此重新下载）
 *
 * 页面通过 onclick="sfOpenDel(this)" 触发，按钮上带 data-del-* 属性。
 * htmx 响应按 scope 换表：playlist → #task-table，chart → #ch-subs-rows。
 */
export function delTaskDialog(scope: 'playlist' | 'chart'): string {
  return `
<dialog id="del-dlg" class="modal">
  <div class="modal-box max-w-md">
    <h3 class="text-base font-bold">删除${scope === 'chart' ? '榜单订阅' : '同步任务'}</h3>
    <p class="text-sm mt-2">任务「<b id="del-dlg-name"></b>」将被删除。<span class="c-sub">已下载的文件与歌单默认保留，按需勾选要一并清理的内容：</span></p>
    <div class="mt-3 space-y-2.5">
      <label class="flex items-start gap-2 cursor-pointer" id="del-dlg-filerow">
        <input type="checkbox" id="del-ck-file" class="checkbox checkbox-sm">
        <span class="text-sm">文件
          <span class="text-xs c-sub block">移入回收站（可恢复）。仍被其它任务引用的文件会保留。</span>
        </span>
      </label>
      <label class="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" id="del-ck-pl" class="checkbox checkbox-sm">
        <span class="text-sm">歌单
          <span class="text-xs c-sub block">从歌单中移除本任务加入过的歌（歌单本身保留，不删除）。</span>
        </span>
      </label>
      <label class="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" id="del-ck-hist" class="checkbox checkbox-sm" checked>
        <span class="text-sm">历史记录
          <span class="text-xs c-sub block">本任务的同步历史（进度历史页里的记录）。删历史不影响以后同步，也不会重新下载。</span>
        </span>
      </label>
      <label id="del-dlg-ignorerow" class="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" id="del-dlg-ignore" class="checkbox checkbox-sm" checked>
        <span class="text-sm">永久忽略该歌单
          <span class="text-xs c-sub block">不再自动创建任务。取消勾选：下次监听扫描会重新创建它。</span>
        </span>
      </label>
    </div>
    <div class="modal-action">
      <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('del-dlg').close()">取消</button>
      <button type="button" class="btn btn-error btn-sm" onclick="sfDelConfirm()"><svg aria-hidden="true"><use href="#i-trash"/></svg>确认删除</button>
    </div>
  </div>
</dialog>
<script>
  // ===== 删除任务：三个复选框 + 永久忽略 =====
  var sfDelId = null
  var sfDelScope = '${scope}'
  ;(function () {
    var d = document.getElementById('del-dlg')
    if (!d || d.dataset.bound === '1') return
    d.dataset.bound = '1'
    // 点击遮罩空白处关闭（原生 dialog 默认不响应）
    d.addEventListener('click', function (e) { if (e.target === this) this.close() })
  })()
  function sfOpenDel(btn) {
    sfDelId = btn.getAttribute('data-del-task')
    sfDelScope = btn.getAttribute('data-del-scope') || '${scope}'
    document.getElementById('del-dlg-name').textContent = btn.getAttribute('data-del-name') || ''
    var canIgnore = btn.getAttribute('data-del-ignore') === '1'
    document.getElementById('del-dlg-ignorerow').style.display = canIgnore ? '' : 'none'
    document.getElementById('del-dlg-ignore').checked = canIgnore
    // 文件选项：目标服务器不支持物理删文件时置灰（道理鱼 / Subsonic）
    var canFile = btn.getAttribute('data-del-fdel') === '1'
    var fck = document.getElementById('del-ck-file')
    fck.disabled = !canFile
    fck.checked = false
    document.getElementById('del-dlg-filerow').style.opacity = canFile ? '' : '.5'
    document.getElementById('del-ck-pl').checked = false
    document.getElementById('del-ck-hist').checked = true
    var d = document.getElementById('del-dlg')
    if (d.showModal) d.showModal()
    else if (window.confirm('确认删除该任务？')) sfDelConfirm()
  }
  function sfDelConfirm() {
    var d = document.getElementById('del-dlg')
    var row = document.getElementById('del-dlg-ignorerow')
    var ig = document.getElementById('del-dlg-ignore')
    var fk = document.getElementById('del-ck-file')
    var values = {
      file: (!fk.disabled && fk.checked) ? '1' : '0',
      playlist: document.getElementById('del-ck-pl').checked ? '1' : '0',
      history: document.getElementById('del-ck-hist').checked ? '1' : '0',
      ignore: (ig && ig.checked && row.style.display !== 'none') ? '1' : '0',
      scope: sfDelScope
    }
    if (d.open) d.close()
    htmx.ajax('POST', '/api/task/' + sfDelId + '/delete', {
      target: sfDelScope === 'chart' ? '#ch-subs-rows' : '#task-table',
      swap: 'innerHTML',
      values: values
    })
  }
</script>`
}

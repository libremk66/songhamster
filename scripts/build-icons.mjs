// 从 @tabler/icons 合成 SVG sprite → src/views/icons-sprite.ts(内联进 LAYOUT,零外部请求)
// 用法: node scripts/build-icons.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dir, '..', 'node_modules', '@tabler', 'icons', 'icons', 'outline')
const OUT = join(__dir, '..', 'src', 'views', 'icons-sprite.ts')

// 语义键 → tabler 文件名(缺失时回退 circle 并警告)
const MAP = {
  save: 'device-floppy', plug: 'plug', radar: 'radar', swap: 'arrows-exchange',
  bolt: 'bolt', play: 'player-play', pause: 'player-pause', pencil: 'pencil',
  trash: 'trash', refresh: 'refresh', plus: 'plus', eye: 'eye', eyeOff: 'eye-off',
  download: 'download', pulse: 'activity', scan: 'scan', copy: 'copy',
  folderSearch: 'folder-search', chevronDown: 'chevron-down', chevronUp: 'chevron-up',
  retry: 'rotate-clockwise', search: 'search', music: 'music', clock: 'clock',
  logout: 'logout', check: 'check', alert: 'alert-triangle', listSearch: 'list-search',
  sync: 'refresh', shield: 'shield-check', heart: 'heart', settings: 'settings',
  arrowRight: 'arrow-right', database: 'database', playlist: 'playlist',
}

const warn = []
const syms = []
for (const [key, name] of Object.entries(MAP)) {
  const file = join(SRC, name + '.svg')
  if (!existsSync(file)) { warn.push(`${key} → ${name} 缺失`); continue }
  const svg = readFileSync(file, 'utf8')
  const attrs = (svg.match(/^<svg([^>]*)>/) || [])[1] || ''
  // 保留 viewBox/stroke 等呈现属性,去掉尺寸/xmlns/class/style/id
  const keep = (attrs.match(/(?:viewBox|stroke|stroke-width|stroke-linecap|stroke-linejoin|fill)="[^"]*"/g) || []).join(' ')
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  syms.push(`<symbol id="i-${key}" ${keep}>${inner}</symbol>`)
}
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${syms.join('')}</svg>`
writeFileSync(OUT, `// 自动生成(Tabler Icons, MIT):node scripts/build-icons.mjs 重新生成\nexport const ICON_SPRITE = ${JSON.stringify(sprite)}\n`)
console.log(`✅ 生成 ${syms.length} 个图标 → src/views/icons-sprite.ts`)
if (warn.length) console.log('⚠️ ' + warn.join(' | '))

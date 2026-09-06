/** Tailwind CSS 配置 — SongFerry DaisyUI 主题
 * 扫所有 .eta 模板 + 静态资源，输出 static/daisy.css
 * 主题：light/dark/corporate 三主题；默认跟随系统
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/views/**/*.eta',
    './src/views/render.ts',
    './static/**/*.{html,js}',
  ],
  theme: {
    extend: {
      // 现有侧栏布局宽度（保持桌面版视觉）
      spacing: {
        sidebar: '300px',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: ['light', 'dark', 'corporate'],
    darkTheme: 'dark',
    base: true,
    styled: true,
    utils: true,
    logs: false, // 构建期禁用 [daisyui] 日志（CI 输出更干净）
  },
}

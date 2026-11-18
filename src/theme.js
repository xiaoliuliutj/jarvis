/**
 * 全局配色与字体。
 *
 * 主题方向：绿色调，左侧深绿、右侧偏白。
 * 换色时只改这里；组件里不要再写死十六进制色值。
 * 注意：index.html 和 electron/main.js 里的启动底色也要同步改。
 * 对比度已按 WCAG AA 校过（正文 >= 4.5:1）。
 */

/**
 * Windows 下不要用 Inter 或 -webkit-font-smoothing: antialiased：
 * 前者没随应用打包，后者会关掉 ClearType 子像素渲染，中文小字号会发虚。
 * Segoe UI 负责西文，微软雅黑负责中文。
 */
export const fonts = {
  sans: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  mono: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
}

export const ui = {
  // 分割线统一 2px：1px 在偏白背景上太细，放大后也容易发灰
  dividerWidth: 2,

  // 左侧与顶部：深绿（比最初版本提亮，避免发黑）
  sidebar: {
    bg: '#16372a',
    surface: '#204b37',
    border: 'rgba(170, 225, 190, 0.22)',
    divider: 'rgba(170, 225, 190, 0.20)',
    text: '#eaf4ee',
    subtext: '#b3cabb',
    muted: '#8ba596',
    accent: '#8ae8b3',
    accentSoft: 'rgba(138, 232, 179, 0.14)',
    hover: 'rgba(234, 244, 238, 0.07)',
    ownerRing: 'rgba(138, 232, 179, 0.38)',
    scrollbar: 'rgba(234, 244, 238, 0.20)',
    scrollbarHover: 'rgba(234, 244, 238, 0.35)',
  },

  // 标题栏比侧栏再深一点，形成上边框
  titleBar: {
    bg: '#102c20',
    border: 'rgba(170, 225, 190, 0.18)',
  },

  // 右侧对话画布：偏白，带一点绿灰
  canvas: {
    bg: '#f7faf6',
    surface: '#fdfefd',
    surfaceMuted: '#eef5ef',
    border: '#d2ded5',
    borderStrong: '#bdcec1',
    text: '#1b2b22',
    subtext: '#4e6256',
    muted: '#566b5d',
    placeholder: '#5a6e60',
    codeBg: '#eef5ef',
    codeText: '#1e5c3a',
    scrollbar: 'rgba(42, 127, 82, 0.24)',
    scrollbarHover: 'rgba(42, 127, 82, 0.42)',
  },

  // 浅色画布上的主操作色
  accent: {
    base: '#2a7f52',
    strong: '#226a44',
    soft: 'rgba(42, 127, 82, 0.10)',
    on: '#f7fbf8',
  },

  // 用户消息用深绿实心，和侧栏呼应；不描边
  userBubble: {
    bg: '#2a5d45',
    text: '#f1f9f3',
  },

  error: {
    bg: '#fdf2f2',
    border: '#eccaca',
    text: '#9b2c2c',
  },
}

/** 细滚动条：侧栏和对话区共用，避免两套写法 */
export function thinScrollbar(thumb, hover) {
  return {
    '&::-webkit-scrollbar': { width: '6px' },
    '&::-webkit-scrollbar-track': { background: 'transparent' },
    '&::-webkit-scrollbar-thumb': {
      background: thumb,
      borderRadius: '999px',
    },
    '&::-webkit-scrollbar-thumb:hover': { background: hover },
  }
}

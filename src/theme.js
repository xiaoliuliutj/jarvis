/**
 * 全局配色。
 *
 * 主题方向：深绿侧栏 + 偏白对话画布。
 * 换色时只改这里；组件里不要再写死十六进制色值。
 * 注意：index.html 和 electron/main.js 里的启动底色也要同步改。
 * 对比度已按 WCAG AA 校过（正文 >= 4.5:1）。
 */
export const ui = {
  // 左侧与顶部：深绿
  sidebar: {
    bg: '#0b1f14',
    surface: '#173525',
    border: 'rgba(137, 220, 170, 0.14)',
    divider: 'rgba(137, 220, 170, 0.12)',
    text: '#e4f1e8',
    subtext: '#a9c0b1',
    muted: '#7e9888',
    accent: '#7fe0a8',
    accentSoft: 'rgba(127, 224, 168, 0.12)',
    hover: 'rgba(228, 241, 232, 0.06)',
    ownerRing: 'rgba(127, 224, 168, 0.35)',
    scrollbar: 'rgba(228, 241, 232, 0.16)',
    scrollbarHover: 'rgba(228, 241, 232, 0.28)',
  },

  // 标题栏比侧栏再深一点，形成上边框
  titleBar: {
    bg: '#081a10',
    border: 'rgba(137, 220, 170, 0.10)',
  },

  // 右侧对话画布：偏白，带一点绿灰
  canvas: {
    bg: '#f4f7f2',
    // 不用纯白，留一点绿灰，和画布形成层次
    surface: '#fcfdfb',
    surfaceMuted: '#edf3ee',
    border: '#dbe5dd',
    borderStrong: '#c9d7cc',
    text: '#1b2b22',
    subtext: '#4e6256',
    muted: '#5b6f63',
    placeholder: '#5f7265',
    codeBg: '#edf3ee',
    codeText: '#1e5c3a',
    scrollbar: 'rgba(31, 122, 75, 0.22)',
    scrollbarHover: 'rgba(31, 122, 75, 0.38)',
  },

  // 浅色画布上的主操作色
  accent: {
    base: '#1f7a4b',
    strong: '#17633c',
    soft: 'rgba(31, 122, 75, 0.10)',
    on: '#f7fbf8',
  },

  // 用户消息用深绿实心，和侧栏呼应
  userBubble: {
    bg: '#1d4a33',
    border: '#2a5c41',
    text: '#eef7f1',
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

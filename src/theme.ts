// ECharts 画在 canvas 上读不到 CSS 变量，这里从 styles.css 的 :root 取同一套品牌色。
export const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()

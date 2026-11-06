import { animate, stagger } from 'motion'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// 只改 React 自己的那个文字节点：替换节点会让 React 之后的金额更新落到看不见的旧节点上。
// React 中途更新了金额（节点内容不再是我们写的值）就立刻停下，以真实值为准。
function countUp(el: HTMLElement) {
  const node = el.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE || el.childNodes.length !== 1) return
  const text = node.nodeValue ?? '', match = text.match(/\d[\d,]*(\.(\d+))?/)
  if (!match) return
  const target = parseFloat(match[0].replace(/,/g, '')), digits = match[2]?.length ?? 0
  let written = text, controls: ReturnType<typeof animate> | undefined
  controls = animate(0, target, {
    duration: 1.1, ease: [.16, 1, .3, 1],
    onUpdate: value => {
      if (node.nodeValue !== written) { controls?.stop(); return }
      written = node.nodeValue = text.replace(match[0], value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
    },
  })
}

// 切换页面时：卡片依次弹性浮入，大数字从 0 滚动到位。系统开了"减少动态效果"就不播放。
export function playEntrance(root: HTMLElement | null) {
  if (!root || reduced()) return
  animate(root.querySelectorAll('.panel, .account-page-source-card, .returns-stat, .returns-summary-card'), { opacity: [0, 1], transform: ['translateY(16px) scale(.985)', 'translateY(0) scale(1)'] }, { delay: stagger(.04), type: 'spring', stiffness: 220, damping: 26 })
  // 页面内容可能稍后才渲染出来，所以 1.2 秒内新出现的大数字也一并处理
  const done = new WeakSet<Element>(), run = () => root.querySelectorAll<HTMLElement>('.hero-int, .returns-stat-primary .numeric').forEach(el => { if (!done.has(el)) { done.add(el); countUp(el) } })
  run()
  const watcher = new MutationObserver(run)
  watcher.observe(root, { childList: true, subtree: true })
  setTimeout(() => watcher.disconnect(), 1200)
}

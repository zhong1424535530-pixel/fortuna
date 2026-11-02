import { currentLang, onLangChange, translate } from './i18n'

// 英文模式下的兜底：页面里没有经过 t() 的中文文字（图表以外），按对照表就地翻译。
// 新增或修改的文字、常见的提示属性都会被处理；对照表里没有的保持中文。
const CJK = /[一-鿿]/
const ATTRIBUTES = ['aria-label', 'placeholder', 'title', 'alt']

function text(node: Text) {
  const value = node.nodeValue
  if (!value || !CJK.test(value)) return
  const core = value.trim()
  const out = translate(core)
  if (out !== core) node.nodeValue = value.replace(core, out)
}
function element(el: Element) {
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name)
    if (value && CJK.test(value)) { const out = translate(value); if (out !== value) el.setAttribute(name, out) }
  }
}
function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { text(root as Text); return }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const tag = (root as Element).tagName
  if (tag === 'SCRIPT' || tag === 'STYLE') return
  element(root as Element)
  const tree = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let node = tree.nextNode(); node; node = tree.nextNode()) node.nodeType === Node.TEXT_NODE ? text(node as Text) : element(node as Element)
}

export function startDomTranslation() {
  if (typeof document === 'undefined') return
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') text(record.target as Text)
      else if (record.type === 'attributes') element(record.target as Element)
      else record.addedNodes.forEach(walk)
    }
  })
  const apply = () => {
    observer.disconnect()
    if (currentLang() !== 'en') return
    walk(document.body)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES })
  }
  onLangChange(apply)
  apply()
}

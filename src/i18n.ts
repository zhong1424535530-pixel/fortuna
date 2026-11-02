import { useSyncExternalStore } from 'react'
import { en as enBase } from './i18n-en.ts'
import { enPages } from './i18n-en-pages.ts'
import { enMore } from './i18n-en-more.ts'
import { enErrors } from './i18n-en-errors.ts'
import { enUi } from './i18n-en-ui.ts'
import { enPatterns } from './i18n-en-patterns.ts'

const en: Record<string, string> = { ...enBase, ...enPages, ...enMore, ...enErrors, ...enUi }

// 页面文字的中英文切换：中文原文就是键，英文模式查表，没翻到的地方直接显示中文，不会空白。
export type Lang = 'zh' | 'en'
const KEY = 'language'
const titles: Record<Lang, string> = { zh: 'Fortuna · 资管宝', en: 'Fortuna · Personal Asset Manager' }

function initial(): Lang {
  try { const saved = localStorage.getItem(KEY); if (saved === 'zh' || saved === 'en') return saved } catch { /* 读不到就按浏览器语言。 */ }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let lang: Lang = initial()
const listeners = new Set<() => void>()
function apply() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = titles[lang]
}
apply()

export const currentLang = () => lang
export function setLang(next: Lang) {
  if (next === lang) return
  lang = next
  try { localStorage.setItem(KEY, next) } catch { /* 记不住语言不影响使用。 */ }
  apply()
  listeners.forEach(listener => listener())
}
// 组件里调用一次，语言切换时会重新渲染；返回当前语言。
export const useLang = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => lang)

// t('共 {n} 项', { n: 3 })：{名字} 会被替换成对应的值。
export function t(text: string, vars?: Record<string, string | number>): string {
  const out = lang === 'en' ? translate(text) : text
  return vars ? out.replace(/\{(\w+)\}/g, (_: string, name: string) => String(vars[name] ?? '')) : out
}

// 先查对照表；再按 enPatterns 里的整句模板；带 · 或 → 的组合按段翻译（账户名等保持原样）；
// 最后对含中文标点的句子，把里面出现的已知短语逐个替换成英文。都没有就保持原文。
const PUNCTUATION: Record<string, string> = { '：': ': ', '；': '; ', '，': ', ', '。': '. ', '、': ', ', '（': ' (', '）': ')' }
let phrases: RegExp | null = null
export function translate(text: string): string {
  const exact = en[text]
  if (exact !== undefined) return exact
  for (const [pattern, build] of enPatterns) { const m = pattern.exec(text); if (m) return build(m, translate) }
  if (!/[\u4e00-\u9fff]/.test(text)) return text
  const edge = edgeMatch(text)
  if (edge) return edge
  const parts = text.split(/(\s·\s|\s→\s)/)
  if (parts.length > 1) return parts.map((part, index) => index % 2 ? part : translate(part)).join('')
  if (!/[：；，。、（）]/.test(text)) return text
  const labelled = text.split('：')
  if (labelled.length > 1) { const joined = labelled.map(translate).join(': '); if (joined !== labelled.join(': ')) return joined }
  phrases ??= new RegExp(Object.keys(en).filter(key => key.length > 5).sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  let changed = false
  const replaced = text.replace(phrases, key => { changed = true; return en[key] })
  return changed ? replaced.replace(/[：；，。、（）]/g, mark => PUNCTUATION[mark]).replace(/\s+$/, '') : text
}

// 前面带数字或名称的句子（如「3笔持仓的…」「{名称}，平台尚未返回…」）：词条是句子的开头或结尾时，剩下的部分原样保留或继续翻译。
let edgeKeys: string[] | null = null
function edgeMatch(text: string): string | null {
  edgeKeys ??= Object.keys(en).filter(key => (key.match(/[\u4e00-\u9fff]/g)?.length ?? 0) >= 4)
  for (const key of edgeKeys) {
    if (text.length <= key.length) continue
    if (text.endsWith(key)) { const rest = text.slice(0, -key.length).trim(); return `${/[\u4e00-\u9fff]/.test(rest) ? translate(rest) : rest}${/^[,.;:]/.test(en[key]) ? '' : ' '}${en[key]}` }
    if (text.startsWith(key)) { const rest = text.slice(key.length).trim(); return `${en[key]}${/\s$/.test(en[key]) ? '' : ' '}${/[\u4e00-\u9fff]/.test(rest) ? translate(rest) : rest}` }
  }
  return null
}
export const onLangChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

// 日期和数字的显示地区跟随语言。
export const locale = () => lang === 'zh' ? 'zh-CN' : 'en-US'

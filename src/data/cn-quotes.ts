import { localRequest, workspace } from './workspace.ts'

export type CnQuote = { name: string; price: number; prevClose: number; at: number }

// 最近一次取到的行情：A股按6位代码（人民币），美股按 us:TSLA（美元）；取不到时保留上次价格。
export let cnQuotes: Record<string, CnQuote> = {}
export function setCnQuotes(next: Record<string, CnQuote>) { cnQuotes = next }
let pending: Promise<void> | null = null

// 手动资产对应的行情键；只有A股和美股有自动行情。
export function quoteKey(asset: { market: string; symbol: string }) {
  return asset.market === 'cn' ? asset.symbol : asset.market === 'us' ? 'us:' + asset.symbol.trim().toUpperCase() : null
}
const codesInUse = () => workspace.manualAssets.flatMap(asset => quoteKey(asset) ?? [])

export function readCnQuotes(codes: string[]): Promise<Record<string, CnQuote>> {
  const wanted = [...new Set(codes)].filter(code => /^(\d{6}|us:[A-Z]{1,5}(\.[A-Z])?)$/.test(code))
  if (!wanted.length) return Promise.resolve({})
  return localRequest<{ quotes: Record<string, CnQuote> }>('/api/cn-quotes?codes=' + wanted.join(',')).then(value => value.quotes)
}

export function refreshCnQuotes(): Promise<void> {
  if (pending) return pending
  const codes = codesInUse()
  if (!codes.length) return Promise.resolve()
  pending = readCnQuotes(codes)
    .then(quotes => { cnQuotes = { ...cnQuotes, ...quotes }; window.dispatchEvent(new CustomEvent('portfolio-data-change', { detail: 'market' })) })
    .catch(() => { /* 行情暂不可用时保留上次价格。 */ })
    .finally(() => { pending = null })
  return pending
}

export function startCnQuoteUpdates() {
  if (typeof window === 'undefined') return () => {}
  // 新增或修改手动资产后立刻补取行情；自己发出的 market 事件不再触发，避免循环。
  const onChange = (event: Event) => { if (!(event instanceof CustomEvent && ['market', 'market-status'].includes(event.detail))) void refreshCnQuotes() }
  void refreshCnQuotes()
  const timer = window.setInterval(() => { void refreshCnQuotes() }, 300000)
  window.addEventListener('portfolio-data-change', onChange)
  return () => { window.clearInterval(timer); window.removeEventListener('portfolio-data-change', onChange) }
}

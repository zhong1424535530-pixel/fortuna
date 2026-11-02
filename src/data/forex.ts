export const FX_HOUR = 3600000
export const FX_SOURCE = 'exchangerate.dev'
export type FxQuote = { rate: number; quotedAt: number; fetchedAt: number; source: typeof FX_SOURCE; kind: 'live' | 'ecb_daily' | 'market_daily'; session: 'open' | 'weekend' | 'interbank_closed' }
export const forex = { quote: null as FxQuote | null, error: '' }
export function validFxQuote(value: unknown, now = Date.now()): value is FxQuote {
  if (!value || typeof value !== 'object') return false
  const q = value as FxQuote
  return q.source === FX_SOURCE && typeof q.rate === 'number' && Number.isFinite(q.rate) && q.rate >= .1 && q.rate <= 100
    && Number.isSafeInteger(q.quotedAt) && q.quotedAt >= 1500000000000 && q.quotedAt <= now + 300000
    && Number.isSafeInteger(q.fetchedAt) && q.fetchedAt >= q.quotedAt - 300000 && q.fetchedAt <= now + 300000
    && ['live', 'ecb_daily', 'market_daily'].includes(q.kind) && ['open', 'weekend', 'interbank_closed'].includes(q.session)
}
export const usdCny = () => forex.quote?.rate ?? null
export function toUsd(amount: number | null, currency: 'USD' | 'CNY', rate = usdCny()): number | null {
  if (amount === null) return null
  if (currency === 'USD' || amount === 0) return amount
  return rate === null ? null : amount / rate
}
export function fxLabel() { return forex.quote ? `1 美元 = ${forex.quote.rate.toFixed(4)} 人民币` : '美元／人民币汇率待获取' }
export function fxNote() {
  const q = forex.quote
  if (!q) return forex.error || '尚未取得汇率，人民币换算暂不可用；原始人民币资料仍可保存。'
  const time = new Date(q.quotedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  return `来源 ${q.source} · 报价时间 ${time}（北京时间） · ${q.kind === 'live' ? '免费市场报价约延迟15分钟' : '上游当前提供每日参考汇率'} · ${q.session === 'open' ? '交易时段' : '休市期间沿用最近报价'} · 每小时查询。${forex.error || (Date.now() - q.fetchedAt > FX_HOUR ? '已超过更新间隔，沿用上次成功报价。' : '')}`
}
let pending: Promise<void> | null = null
async function loadFx(refresh: boolean) {
  try {
    const response = await fetch('/api/forex' + (refresh ? '/refresh' : ''), { method: refresh ? 'POST' : 'GET', headers: { 'X-Investment-App': '1' }, signal: AbortSignal.timeout(22000) })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error || '汇率服务暂不可用，沿用上次成功报价。')
    if (value.quote !== null && !validFxQuote(value.quote)) throw new Error('汇率资料无法核对，保留上次成功报价。')
    if (value.quote && (!forex.quote || value.quote.quotedAt >= forex.quote.quotedAt)) forex.quote = value.quote
    forex.error = typeof value.error === 'string' ? value.error : ''
  } catch (error) { forex.error = error instanceof Error ? error.message : '汇率读取失败。' }
}
export const initializeForex = () => loadFx(false)
export function refreshForex(): Promise<void> {
  if (pending) return pending
  pending = loadFx(true).then(() => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('portfolio-data-change', { detail: 'fx' })) }).finally(() => { pending = null })
  return pending
}
export function startForexUpdates() {
  let active = true, running = false, nextAttemptAt = 0, timer: number | undefined
  const dueAt = () => Math.max(nextAttemptAt, forex.quote ? forex.quote.fetchedAt + FX_HOUR : 0)
  const schedule = () => { window.clearTimeout(timer); if (active) timer = window.setTimeout(() => { void refresh() }, Math.max(1000, dueAt() - Date.now())) }
  const refresh = async () => {
    if (!active || running) return
    if (dueAt() > Date.now()) { schedule(); return }
    running = true; nextAttemptAt = Date.now() + FX_HOUR
    try { await refreshForex() } finally { running = false; schedule() }
  }
  const visible = () => { if (document.visibilityState === 'visible') void refresh() }
  void refresh()
  document.addEventListener('visibilitychange', visible)
  return () => { active = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
}

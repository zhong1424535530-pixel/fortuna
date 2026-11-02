import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FX_HOUR, FX_SOURCE, validFxQuote } from '../src/data/forex.ts'
import { requestJson } from './connection-http.mjs'

export function parseFxQuote(value, now = Date.now()) {
  const kind = value?.sources?.CNY ?? value?.source
  const q = { rate: value?.rates?.CNY, quotedAt: Date.parse(value?.effective_at?.CNY ?? value?.data_updated_at), fetchedAt: now, source: FX_SOURCE, kind, session: value?.market_session }
  const maxAge = kind === 'live' && q.session === 'open' ? 6 * FX_HOUR : 7 * 24 * FX_HOUR
  if (value?.result !== 'success' || value.base !== 'USD' || value.stale?.CNY === true || !validFxQuote(q, now) || now - q.quotedAt > maxAge) throw new Error('汇率报价无法核对或已过期，沿用上次成功值。')
  return q
}
export function createForexService(folder, dependencies = {}) {
  const fetchJson = dependencies.requestJson ?? requestJson, now = dependencies.now ?? Date.now
  const path = join(folder, 'forex-cache.json')
  let pending = null, lastAttempt = null, error = ''
  function read() {
    try { const value = JSON.parse(readFileSync(path, 'utf8')); return validFxQuote(value, now()) ? value : null } catch { return null }
  }
  function list() {
    const quote = read()
    return { quote, error: error || (quote && now() - quote.fetchedAt >= FX_HOUR ? '汇率等待更新，沿用上次成功报价。' : '') }
  }
  function refresh() {
    if (pending) return pending
    const quote = read()
    if (quote && now() - quote.fetchedAt < FX_HOUR || lastAttempt !== null && now() - lastAttempt < 60000) return Promise.resolve(list())
    lastAttempt = now()
    pending = (async () => {
      try {
        const next = parseFxQuote(await fetchJson('https://api.exchangerate.dev/v1/latest/USD?symbols=CNY'), now())
        if (quote && next.quotedAt < quote.quotedAt) throw new Error('汇率来源返回了更早的报价，沿用上次成功值。')
        mkdirSync(folder, { recursive: true, mode: 0o700 })
        const temp = path + '.' + randomUUID() + '.tmp'
        try { writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); renameSync(temp, path) } finally { try { unlinkSync(temp) } catch { /* 已落盘或没有创建临时文件。 */ } }
        error = ''
      } catch { error = '汇率更新未成功，保留上次报价；未取得汇率的人民币项目暂不换算。' }
      return list()
    })().finally(() => { pending = null })
    return pending
  }
  return { list, refresh }
}

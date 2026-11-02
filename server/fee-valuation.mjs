import { feeAssets, feeInUnit, validFeeValuations } from '../src/data/fee-valuation.ts'
import { minuteOpenPrice } from './reward-valuation.mjs'
import { requestJson } from './connection-http.mjs'

const minuteOf = row => Math.floor(row.time / 60000) * 60000
const keyOf = (asset, at) => asset + ':' + at
const feeItems = row => [...row.fees, ...(row.type === '手续费' ? [{ asset: row.asset, quantity: row.quantity }] : [])]

export async function valueTransactionFees(records, previous = [], fetchJson = requestJson) {
  const prices = new Map(), required = new Map()
  for (const row of [...previous, ...records]) if (validFeeValuations(row)) {
    for (const quote of row.feeValuations ?? []) prices.set(keyOf(quote.asset, quote.at), quote)
  }
  for (const row of records) {
    if (!['spot', 'usdm'].includes(row.scope) || !['已完成', '已记录'].includes(row.status)) continue
    for (const fee of feeItems(row)) if (feeInUnit(row, fee, 'USDT') === null && /^[A-Z0-9]{1,40}$/.test(fee.asset)) {
      const minutes = required.get(fee.asset) ?? new Set()
      if (!prices.has(keyOf(fee.asset, minuteOf(row)))) minutes.add(minuteOf(row))
      required.set(fee.asset, minutes)
    }
  }
  const started = Date.now()
  let requests = 0
  // shortcut: 单轮最多32次报价，45秒后不再发起新请求；大量历史由后续轮次继续补齐。
  for (const [asset, wanted] of required) {
    const minutes = [...wanted].sort((a, b) => a - b)
    for (let index = 0; index < minutes.length && requests < 32 && Date.now() - started < 45000;) {
      const from = minutes[index], to = Math.min(from + 999 * 60000, minutes.at(-1))
      const pair = asset + 'USDT'
      const params = new URLSearchParams({ symbol: pair, interval: '1m', startTime: String(from), endTime: String(to + 59999), limit: '1000' })
      for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
        if (requests >= 32 || Date.now() - started >= 45000) break
        requests++
        try {
          const data = await fetchJson(host + '/api/v3/klines?' + params)
          if (!Array.isArray(data) || data.length > 1000) continue
          for (const candle of data) {
            const at = candle?.[0]
            if (!Number.isSafeInteger(at) || at < from || at > to || !wanted.has(at)) continue
            const price = minuteOpenPrice(candle, at)
            if (price !== null && !prices.has(keyOf(asset, at))) prices.set(keyOf(asset, at), { asset, price, at, pair })
          }
          if (minutes.filter(at => at >= from && at <= to).every(at => prices.has(keyOf(asset, at)))) break
        } catch { /* 缺历史价格时保留原币，下一次补查继续，不用现价替代。 */ }
      }
      while (index < minutes.length && minutes[index] <= to) index++
    }
  }
  let missing = 0
  const valued = records.map(row => {
    if (!['spot', 'usdm'].includes(row.scope) || !['已完成', '已记录'].includes(row.status)) return row
    const feeValuations = feeAssets(row).flatMap(asset => prices.get(keyOf(asset, minuteOf(row))) ?? [])
    const result = feeValuations.length ? { ...row, feeValuations } : row
    missing += feeItems(row).filter(fee => feeInUnit(result, fee, 'USDT') === null).length
    return result
  })
  return { records: valued, missing }
}

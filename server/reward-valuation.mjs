import { canValueReward } from '../src/data/transaction-rewards.ts'
import { validTransactionState } from '../src/data/transactions.ts'
import { Decimal, decimal, requestJson } from './connection-http.mjs'

const Exact = Decimal.clone({ precision: 100 })
const minuteOf = row => Math.floor(row.time / 60000) * 60000
const priceKey = row => row.asset + ':' + minuteOf(row)
const quoteCursors = new Map()


export function minuteOpenPrice(candle, at) {
  try {
    if (!Array.isArray(candle) || candle.length < 12 || candle[0] !== at || candle[6] !== at + 59999 || !Number.isSafeInteger(candle[8]) || candle[8] <= 0 || typeof candle[1] !== 'string') return null
    const price = decimal(candle[1], '历史价格')
    if (!price.gt(0) || price.gte('1e30') || price.decimalPlaces() > 36 || !decimal(candle[5], '成交量').gt(0)) return null
    return price.toFixed()
  } catch { return null }
}

export async function valueRewards(records, previous = [], fetchJson = requestJson) {
  const prices = new Map()
  for (const row of previous) if (canValueReward(row) && row.rewardValuation?.basis === 'minute-open') prices.set(priceKey(row), row.rewardValuation)
  let requests = 0, missing = 0
  async function quote(row) {
    const key = priceKey(row)
    if (prices.has(key)) return prices.get(key)
    prices.set(key, null)
    if (!/^[A-Z0-9]{1,40}$/.test(row.asset)) return null
    const at = minuteOf(row)
    for (const tail of ['USDT', 'USDC']) for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      // shortcut: 每轮最多补64次报价并轮换起点；服务重启后从头补查，大量历史再考虑保存游标。
      if (requests >= 64) return null
      requests++
      const pair = row.asset + tail
      const params = new URLSearchParams({ symbol: pair, interval: '1m', startTime: String(at), endTime: String(at + 59999), limit: '1' })
      try {
        const data = await fetchJson(host + '/api/v3/klines?' + params)
        const candle = Array.isArray(data) && data.length === 1 && data[0]
        const price = minuteOpenPrice(candle, at)
        if (price === null) continue
        const value = { price, at, pair, basis: 'minute-open' }
        prices.set(key, value)
        return value
      } catch { /* 历史价格缺失不使用当前价格，不阻断原记录保存。 */ }
    }
    return null
  }
  const valued = new Array(records.length)
  const identity = records.find(canValueReward)?.identity
  const start = (quoteCursors.get(identity) ?? 0) % Math.max(1, records.length)
  for (let offset = 0; offset < records.length; offset++) {
    const index = (start + offset) % records.length, row = records[index]
    if (!canValueReward(row)) { valued[index] = row; continue }
    const stable = ['USDT', 'USDC'].includes(row.asset)
    if (!stable && !prices.has(priceKey(row)) && requests < 64) quoteCursors.set(identity, (index + 1) % records.length)
    const price = stable ? { price: '1', at: row.time, pair: '', basis: 'parity' } : await quote(row)
    if (price) {
      const rewardValuation = { ...price, usdtQuantity: new Exact(row.quantity).mul(price.price).toDecimalPlaces(36).toFixed() }
      const result = { ...row, rewardValuation }
      if (validTransactionState({ records: [result], syncs: [] })) { valued[index] = result; continue }
    }
    missing++
    valued[index] = row
  }
  return { records: valued, missing }
}

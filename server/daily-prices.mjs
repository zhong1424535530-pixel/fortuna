import { exchanges, networks } from '../src/data/live-types.ts'
import { calendarToday } from '../src/data/return-range.ts'
import { validDayOpen } from '../src/data/daily-pnl.ts'
import { visibleHoldings } from '../src/data/holding-visibility.ts'
import { parseLlamaPrices, walletCoinKey } from './wallet-prices.mjs'
import { ConnectionError, decimal, requestJson, validChange24h } from './connection-http.mjs'

// shortcut: 交易所仅映射已确认身份的常见币种，其他币日初价未接入时按0，增加币种时补充明确映射。
const coinIds = { BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', USDT: 'tether', USDC: 'usd-coin', DOGE: 'dogecoin', SUI: 'sui', PEPE: 'pepe', FDUSD: 'first-digital-usd', WIF: 'dogwifcoin', BONK: 'bonk' }
let cacheDate = '', cached = new Map()
const changeCache = new Map()

export function parsePriceChanges24h(data, keys) {
  if (!data?.coins || typeof data.coins !== 'object' || Array.isArray(data.coins)) throw new ConnectionError('24小时行情格式无法识别。', 502)
  return new Map(keys.filter(key => validChange24h(data.coins[key])).map(key => [key, data.coins[key]]))
}

async function readPriceChanges24h(holdings, fetchJson, now) {
  const keys = [...new Set(holdings.filter(asset => asset.usdPrice !== null && !validChange24h(asset.change24h)).map(dailyPriceKey).filter(Boolean))]
  const result = new Map(), pending = []
  const timestamp = Math.floor(now.getTime() / 1000)
  for (const key of keys) {
    const saved = changeCache.get(key)
    if (saved && timestamp >= saved.at && timestamp - saved.at < 60) result.set(key, saved.value)
    else pending.push(key)
  }
  // shortcut: 与日初价一样单次最多补200种，持仓更大时再增加后台分批查询。
  for (let start = 0; start < Math.min(pending.length, 200); start += 100) {
    const chunk = pending.slice(start, start + 100)
    try {
      const data = await fetchJson('https://coins.llama.fi/percentage/' + chunk.map(encodeURIComponent).join(',') + '?period=24h&lookForward=false&timestamp=' + timestamp)
      for (const [key, value] of parsePriceChanges24h(data, chunk)) { result.set(key, value); changeCache.set(key, { value, at: timestamp }) }
    } catch { /* 查不到24小时行情时保留横线，不影响现价与今日盈亏。 */ }
  }
  if (changeCache.size > 10000) changeCache.clear()
  return result
}

export function dailyPriceKey(asset) {
  if (asset.market !== 'crypto') return null
  const evm = asset.id.match(/^evm:(\d+):(native|0x[0-9a-fA-F]{40})$/)
  if (evm) {
    const network = networks.find(item => item.chainId === Number(evm[1]))
    return network ? walletCoinKey({ chainId: network.chainId, address: evm[2] === 'native' ? null : evm[2], coinId: network.coinId }) : null
  }
  if (asset.id === 'bitcoin:native') return 'coingecko:bitcoin'
  if (/^solana:(native|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(asset.id)) return asset.id === 'solana:native' ? 'coingecko:solana' : asset.id
  const prefix = asset.id.split(':')[0]
  return exchanges.some(exchange => exchange.id === prefix) && asset.id === prefix + ':' + asset.symbol && coinIds[asset.symbol] ? 'coingecko:' + coinIds[asset.symbol] : null
}

export async function addDailyOpenPrices(parts, fetchJson = requestJson, now = new Date()) {
  const date = calendarToday(now)
  const midnight = Date.parse(date + 'T00:00:00+08:00') / 1000
  if (cacheDate !== date) { cacheDate = date; cached = new Map() }
  const cache = cached
  const holdings = visibleHoldings(parts.filter(part => part.account.status !== 'error').flatMap(part => part.holdings))
  const eligibleIds = new Set(holdings.map(asset => asset.id))
  const binanceAssets = [...new Map(holdings.filter(asset => asset.market === 'crypto' && asset.usdPrice !== null && asset.id === 'binance:' + asset.symbol && /^[A-Z0-9]{1,40}$/.test(asset.symbol) && asset.symbol !== 'USD' && asset.symbol !== 'USDT').map(asset => [asset.id, asset])).values()]
  for (const asset of holdings) if (validDayOpen(asset.dayOpen) && asset.dayOpen.date === date) cache.set(dailyPriceKey(asset) ?? asset.id, asset.dayOpen)
  const changesWork = readPriceChanges24h(holdings, fetchJson, now).catch(() => new Map())
  const keys = [...new Set([...holdings.filter(asset => asset.usdPrice !== null).map(dailyPriceKey).filter(Boolean), ...(binanceAssets.length ? ['coingecko:tether'] : [])])]
  // shortcut: 单次最多补200种日初报价，更多持仓时再增加后台分批查询。
  const missing = keys.filter(key => !cache.has(key)).slice(0, 200)
  for (let start = 0; start < missing.length; start += 100) {
    const chunk = missing.slice(start, start + 100)
    try {
      const data = await fetchJson('https://coins.llama.fi/prices/historical/' + midnight + '/' + chunk.map(encodeURIComponent).join(',') + '?searchWidth=5m')
      for (const [key, quote] of parseLlamaPrices(data, chunk, midnight * 1000)) {
        const reference = { date, usdPrice: Number(quote.price), at: quote.at }
        if (validDayOpen(reference)) cache.set(key, reference)
      }
    } catch { /* 缺少日初价不阻断余额读取；前端按本人要求记0。 */ }
  }
  const tether = cache.get('coingecko:tether')
  if (validDayOpen(tether) && tether.date === date) {
    const pending = binanceAssets.filter(asset => !cache.has(dailyPriceKey(asset)) && !cache.has(asset.id)).slice(0, 32)
    // shortcut: 每轮最多补32个币安零点报价，更多币种下轮继续；只接受零点第一分钟有成交的价格。
    for (let start = 0; start < pending.length; start += 8) await Promise.all(pending.slice(start, start + 8).map(async asset => {
      const params = new URLSearchParams({ symbol: asset.symbol + 'USDT', interval: '1m', timeZone: '8', startTime: String(midnight * 1000), endTime: String(midnight * 1000 + 59999), limit: '1' })
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try {
          const data = await fetchJson(host + '/api/v3/klines?' + params)
          const row = Array.isArray(data) && data[0]
          if (!Array.isArray(row) || row[0] !== midnight * 1000 || row[6] !== midnight * 1000 + 59999 || !Number.isSafeInteger(row[8]) || row[8] <= 0) throw new Error()
          const price = decimal(row[1]).mul(tether.usdPrice)
          const reference = { date, usdPrice: price.toNumber(), at: midnight }
          if (!validDayOpen(reference)) throw new Error()
          cache.set(dailyPriceKey(asset) ?? asset.id, reference)
          break
        } catch { /* 日初价缺失下轮重试，不套用24小时开盘价。 */ }
      }
    }))
  }
  const changes24h = await changesWork
  return parts.map(part => ({ ...part, holdings: part.holdings.map(asset => {
    if (!eligibleIds.has(asset.id) || asset.market !== 'crypto' || asset.usdPrice === null || part.account.status === 'error') return asset
    const quote = cache.get(dailyPriceKey(asset) ?? asset.id)
    return { ...asset, change24h: validChange24h(asset.change24h) ? asset.change24h : changes24h.get(dailyPriceKey(asset)) ?? null, ...(quote ? { dayOpen: quote } : {}) }
  }) }))
}

import { ConnectionError, decimal, requestJson, validChange24h } from './connection-http.mjs'
const cache = new Map()
const chainNames = { 1: 'ethereum', 10: 'optimism', 56: 'bsc', 100: 'xdai', 137: 'polygon', 324: 'era', 8453: 'base', 42161: 'arbitrum', 43114: 'avax', 534352: 'scroll' }
const geckoPlatforms = { 1: 'ethereum', 10: 'optimistic-ethereum', 56: 'binance-smart-chain', 100: 'xdai', 137: 'polygon-pos', 324: 'zksync', 8453: 'base', 42161: 'arbitrum-one', 43114: 'avalanche', 534352: 'scroll' }
export const walletCoinKey = coin => coin.address ? `${coin.chainId === 'solana' ? 'solana' : chainNames[coin.chainId]}:${coin.chainId === 'solana' ? coin.address : coin.address.toLowerCase()}` : 'coingecko:' + coin.coinId
export function parseLlamaPrices(data, keys, now = Date.now(), maxAge = 3600) {
  if (!data || typeof data.coins !== 'object' || data.coins === null || Array.isArray(data.coins)) throw new ConnectionError('价格服务返回格式无法识别。', 502)
  const result = new Map()
  for (const key of keys) {
    const entry = data.coins[key]
    if (!entry) continue
    try {
      const price = decimal(entry.price)
      if (!price.gt(0) || !Number.isFinite(entry.timestamp) || Math.abs(now / 1000 - entry.timestamp) > maxAge || entry.confidence != null && (!Number.isFinite(entry.confidence) || entry.confidence < .2 || entry.confidence > 1)) continue
      result.set(key, { price: price.toFixed(), source: 'DeFiLlama', at: entry.timestamp })
    } catch { /* 无可靠报价时保留未知。 */ }
  }
  return result
}
export async function walletPrices(coins, fetchJson = requestJson, force = false) {
  const unique = [...new Map(coins.map(coin => [walletCoinKey(coin), coin])).entries()]
  const result = new Map(), pending = []
  for (const [key, coin] of unique) {
    const saved = cache.get(key)
    if (!force && saved && Date.now() - saved.savedAt < 60000) result.set(key, saved)
    else pending.push([key, coin])
  }
  for (let start = 0; start < pending.length; start += 100) {
    const keys = pending.slice(start, start + 100).map(([key]) => key)
    try {
      const prices = parseLlamaPrices(await fetchJson('https://coins.llama.fi/prices/current/' + keys.map(encodeURIComponent).join(',')), keys, Date.now(), force ? 300 : 3600)
      for (const [key, quote] of prices) result.set(key, quote)
    } catch { /* 单个来源失败后继续免费备用来源。 */ }
  }
  const groups = new Map()
  for (const [key, coin] of pending.filter(([key]) => !result.has(key))) {
    const platform = coin.address && geckoPlatforms[coin.chainId]
    const group = platform ? 'token:' + platform : !coin.address && coin.coinId ? 'coin' : null
    if (group) groups.set(group, [...(groups.get(group) ?? []), [key, coin]])
  }
  for (const [group, entries] of groups) for (let start = 0; start < entries.length; start += 30) {
    const chunk = entries.slice(start, start + 30), token = group.startsWith('token:')
    const params = new URLSearchParams({ vs_currencies: 'usd', include_last_updated_at: 'true', include_24hr_change: 'true', [token ? 'contract_addresses' : 'ids']: chunk.map(([, coin]) => token ? coin.address.toLowerCase() : coin.coinId).join(',') })
    try {
      const data = await fetchJson('https://api.coingecko.com/api/v3/simple/' + (token ? 'token_price/' + group.slice(6) : 'price') + '?' + params)
      for (const [key, coin] of chunk) {
        const quote = data[token ? coin.address.toLowerCase() : coin.coinId]
        if (!quote || !Number.isFinite(quote.last_updated_at) || Math.abs(Date.now() / 1000 - quote.last_updated_at) > (force ? 300 : 3600)) continue
        const price = decimal(quote.usd)
        if (price.gt(0)) result.set(key, { price: price.toFixed(), source: 'CoinGecko', at: quote.last_updated_at, change24h: validChange24h(quote.usd_24h_change) ? quote.usd_24h_change : null })
      }
    } catch { /* 免费备用来源也无价时不把币当作零元。 */ }
  }
  // 代币只能按自身地址报价，不能套用所在链原生币的价格。
  const krakenPairs = { bitcoin: 'XBTUSD', ethereum: 'ETHUSD', solana: 'SOLUSD', tether: 'USDTUSD', 'usd-coin': 'USDCUSD' }
  for (const coinId of new Set(pending.filter(([key, coin]) => !coin.address && !result.has(key)).map(([, coin]) => coin.coinId))) {
    const pair = krakenPairs[coinId]
    if (!pair) continue
    try {
      const data = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=' + pair)
      if (!Array.isArray(data?.error) || data.error.length || !data.result) continue
      const price = decimal(Object.values(data.result)[0]?.c?.[0])
      if (price.gt(0)) for (const [key, coin] of pending) if (!coin.address && coin.coinId === coinId && !result.has(key)) result.set(key, { price: price.toFixed(), source: 'Kraken', at: Math.floor(Date.now() / 1000) })
    } catch { /* 免费来源都失败后保留无价状态。 */ }
  }
  for (const [key, quote] of result) {
    if (!cache.has(key) || cache.get(key).at !== quote.at) cache.set(key, { ...quote, savedAt: Date.now() })
  }
  if (cache.size > 10000) cache.clear()
  return result
}

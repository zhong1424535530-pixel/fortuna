import ccxt from 'ccxt'
import { exchanges, networks } from '../src/data/live-types.ts'
import { visibleHoldings } from '../src/data/holding-visibility.ts'
import { buildBinanceMarket } from './binance-reader.mjs'
import { cents, ConnectionError, decimal, nativePrices, nativePriceTimes, requestJson } from './connection-http.mjs'
import { walletCoinKey, walletPrices } from './wallet-prices.mjs'
import { transactionAssetId } from '../src/data/transaction-summary.ts'
import { coinKey } from '../src/data/asset-identity.ts'

const nativeSymbols = [['USDT', 'tether'], ['USDC', 'usd-coin'], ['BTC', 'bitcoin'], ['ETH', 'ethereum'], ['BNB', 'binancecoin']]
const providers = new Set(exchanges.map(item => item.id))

function walletCoin(asset) {
  const evm = asset.id.match(/^evm:(\d+):(native|0x[0-9a-fA-F]{40})$/)
  if (evm) {
    const network = networks.find(item => item.chainId === Number(evm[1]))
    return network ? { chainId: network.chainId, coinId: evm[2] === 'native' ? network.coinId : undefined, address: evm[2] === 'native' ? undefined : evm[2] } : null
  }
  if (asset.id === 'bitcoin:native') return { coinId: 'bitcoin' }
  const sol = asset.id.match(/^solana:(native|[1-9A-HJ-NP-Za-km-z]{32,44})$/)
  return sol ? { chainId: 'solana', coinId: sol[1] === 'native' ? 'solana' : undefined, address: sol[1] === 'native' ? undefined : sol[1] } : null
}

async function contractMarks(type, fetchJson, now) {
  const urls = {
    binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
    okx: 'https://www.okx.com/api/v5/public/mark-price?instType=SWAP',
    bybit: 'https://api.bybit.com/v5/market/tickers?category=linear',
    bitget: 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
    gate: 'https://api.gateio.ws/api/v4/futures/usdt/contracts',
    bitunix: 'https://fapi.bitunix.com/api/v1/futures/market/tickers',
  }
  const data = await fetchJson(urls[type])
  if (type === 'okx' && data?.code !== '0' || type === 'bybit' && data?.retCode !== 0 || type === 'bitget' && data?.code !== '00000' || type === 'bitunix' && String(data?.code) !== '0') throw new ConnectionError('合约行情暂不可用。', 502)
  const rows = type === 'binance' || type === 'gate' ? data : type === 'bybit' ? data.result?.list : data.data
  if (!Array.isArray(rows)) throw new ConnectionError('合约行情格式无法识别。', 502)
  const result = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const symbol = String(row.symbol ?? row.instId ?? row.name ?? '').replace(/-SWAP$/, '').replace(/[_-]/g, '')
    if (!/^[A-Z0-9]+(?:USDT|USDC)$/.test(symbol)) continue
    try {
      const price = decimal(row.markPrice ?? row.markPx ?? row.mark_price)
      const at = row.time ?? row.ts
      if (!price.gt(0) || at !== undefined && (!Number.isSafeInteger(Number(at)) || Math.abs(now - Number(at)) > 300000)) continue
      result.set(symbol, { price: price.toFixed(), at: at === undefined ? now : Number(at) })
    } catch { /* 一个合约无有效标记价不影响其他合约。 */ }
  }
  return result
}

async function exchangeQuotes(type, usd, { fetchJson, spot, futures, now, usdTimes }) {
  const prices = new Map(usd)
  const times = new Map(usdTimes)
  const spotWork = (async () => {
    if (!spot) return
    if (type === 'binance') {
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try {
          const rows = await fetchJson(host + '/api/v3/ticker/price')
          if (!Array.isArray(rows)) throw new Error()
          const native = Object.fromEntries(nativeSymbols.map(([symbol, id]) => [id, usd.get(symbol)]))
          for (const [symbol, price] of buildBinanceMarket(rows, native).usd) { prices.set(symbol, price); if (!times.has(symbol)) times.set(symbol, now) }
          return
        } catch { /* 主站失败后尝试原有公开备用站。 */ }
      }
      return
    }
    if (type === 'bitunix') {
      const data = await fetchJson('https://openapi.bitunix.com/api/spot/v1/common/rate/list')
      if (String(data?.code) !== '0' || !Array.isArray(data.data)) throw new Error()
      for (const row of data.data) {
        try { if (usd.has(row.quoteSymbol) && decimal(row.rate).gt(0)) { prices.set(row.baseSymbol, decimal(row.rate).mul(usd.get(row.quoteSymbol)).toFixed()); times.set(row.baseSymbol, now) } } catch { /* 无报价时保留旧值。 */ }
      }
      return
    }
    const client = new ccxt[type]({ enableRateLimit: true, timeout: 18000 })
    client.number = String
    client.has.fetchCurrencies = false
    const deadline = Date.now() + 45000
    client.fetch = async (url, method = 'GET', headers) => {
      if (method !== 'GET' || Date.now() > deadline) throw new ConnectionError('行情查询超时。', 502)
      const data = await fetchJson(url, { headers })
      if (type === 'okx' && data?.code !== '0' || type === 'bybit' && data?.retCode !== 0 || type === 'bitget' && data?.code !== '00000') throw new ConnectionError('公开行情暂不可用。', 502)
      return data
    }
    try {
      const tickers = await client.fetchTickers(undefined, { type: 'spot' })
      for (const ticker of Object.values(tickers)) {
        if (typeof ticker?.symbol !== 'string') continue
        const [base, quote] = ticker.symbol.split('/')
        try {
          if (quote !== 'USDT' || !usd.has(quote) || ticker.timestamp != null && Math.abs(now - Number(ticker.timestamp)) > 300000) continue
          const price = decimal(ticker.last)
          if (price.gt(0)) { prices.set(base, price.mul(usd.get(quote)).toFixed()); times.set(base, ticker.timestamp == null ? now : Number(ticker.timestamp)) }
        } catch { /* 跳过无效的单个报价。 */ }
      }
    } finally { await client.close() }
  })()
  const marksWork = futures ? contractMarks(type, fetchJson, now) : Promise.resolve(new Map())
  const [, marks] = await Promise.allSettled([spotWork, marksWork])
  return { spot: prices, times, marks: marks.status === 'fulfilled' ? marks.value : new Map() }
}

export async function readMarketPrices(snapshot, { fetchJson = requestJson, native = nativePrices, exchangeQuotes: quotesFor = exchangeQuotes, stockQuote = async () => null, connections = [], now = new Date() } = {}) {
  const holdings = visibleHoldings(snapshot.holdings), result = { holdings: new Map(), contracts: new Map() }
  if (!holdings.length && !snapshot.contracts.length) return result
  const accountTypes = new Map(snapshot.accounts.map(account => [account.id, connections.find(item => 'live-' + item.id === account.sourceId)?.type]))
  const types = new Set([...holdings.filter(asset => asset.market === 'crypto').map(asset => asset.id.split(':')[0]), ...snapshot.contracts.map(position => accountTypes.get(position.accountId))].filter(type => providers.has(type)))
  const rates = types.size ? await native(true).catch(() => ({})) : {}
  const usd = new Map([['USD', '1']])
  const sourceTimes = native === nativePrices ? nativePriceTimes() : {}
  const usdTimes = new Map([['USD', now.getTime()]])
  for (const [symbol, id] of nativeSymbols) {
    try { if (decimal(rates[id]).gt(0)) { usd.set(symbol, decimal(rates[id]).toFixed()); usdTimes.set(symbol, sourceTimes[id] ?? now.getTime()) } } catch { /* 缺美元报价不默认稳定币等于1。 */ }
  }
  await Promise.allSettled([...types].map(async type => {
    const assets = holdings.filter(asset => asset.market === 'crypto' && asset.id.startsWith(type + ':'))
    const positions = snapshot.contracts.filter(position => accountTypes.get(position.accountId) === type)
    const data = await quotesFor(type, usd, { fetchJson, spot: assets.length > 0, futures: positions.length > 0, now: now.getTime(), usdTimes })
    for (const asset of assets) if (data.spot.has(asset.symbol)) result.holdings.set(asset.id, { usdPrice: data.spot.get(asset.symbol), at: data.times?.get(asset.symbol) ?? now.getTime() })
    for (const position of positions) {
      const mark = data.marks.get(position.symbol), settle = position.symbol.endsWith('USDC') ? 'USDC' : 'USDT'
      if (mark && usd.has(settle)) result.contracts.set(position.id, { usdPrice: decimal(mark.price).mul(usd.get(settle)).toFixed(), at: mark.at })
    }
  }).concat((async () => {
    const assets = holdings.map(asset => ({ asset, coin: walletCoin(asset) })).filter(item => item.coin)
    if (!assets.length) return
    const quotes = await walletPrices(assets.map(item => item.coin), fetchJson, true)
    for (const { asset, coin } of assets) {
      const quote = quotes.get(walletCoinKey(coin))
      if (quote) result.holdings.set(asset.id, { usdPrice: quote.price, at: quote.at * 1000 })
    }
  })(),
  // shortcut: 沿用单轮32只股票的查询上限，持仓更多时再增加分批更新。
  ...holdings.filter(asset => asset.market === 'us' && asset.id.startsWith('binance:equity:')).slice(0, 32).map(async asset => {
    const price = await stockQuote(asset)
    if (price !== null) result.holdings.set(asset.id, { usdPrice: price, at: now.getTime() })
  })))
  if (!result.holdings.size && !result.contracts.size) throw new ConnectionError('暂未取得新的市场报价，保留上次价格。', 502)
  return result
}

export function applyMarketPrices(snapshot, quotes, now = new Date()) {
  const valid = (quote, oldTime) => {
    if (!quote || !Number.isSafeInteger(quote.at) || quote.at <= 0 || quote.at > now.getTime() + 30000 || now.getTime() - quote.at > 3600000 || quote.at < (Date.parse(oldTime ?? '') || 0)) return null
    try { const price = decimal(quote.usdPrice); return price.gt(0) && price.lte(1e12) ? price : null } catch { return null }
  }
  return { ...snapshot, holdings: snapshot.holdings.map(asset => {
    const quote = quotes.holdings.get(asset.id), price = valid(quote, asset.priceUpdatedAt)
    if (!price) return asset
    try {
      const positions = asset.positions.map(position => {
        const quantity = decimal(position.quantityText ?? position.quantity, '持有数量')
        if (quantity.toNumber() !== position.quantity) throw new Error()
        return { ...position, valueCents: cents(quantity.mul(price)) }
      })
      return { ...asset, usdPrice: price.toNumber(), priceUpdatedAt: new Date(quote.at).toISOString(), positions }
    } catch { return asset }
  }), contracts: snapshot.contracts.map(position => {
    const quote = quotes.contracts.get(position.id), price = valid(quote, position.priceUpdatedAt)
    if (!price) return position
    try { cents(price.mul(decimal(position.quantity))); return { ...position, markPriceUsd: price.toNumber(), priceUpdatedAt: new Date(quote.at).toISOString() } } catch { return position }
  }) }
}

export async function readTransactionFeePrices(state, { marketPrices = readMarketPrices, now = new Date() } = {}) {
  const assets = new Map()
  const add = (row, asset, token) => {
    const id = transactionAssetId(row, asset, token)
    if (['coin:tether', 'coin:usd-coin'].includes(coinKey({ id, market: 'crypto' })) || /^(?:binance|okx|bybit|bitget|gate|bitunix):(?:USDT|USDC)$/.test(id)) return
    assets.set(id, { id, symbol: asset, market: 'crypto', usdPrice: null, positions: [] })
  }
  for (const row of state.records) {
    for (const fee of row.fees) add(row, fee.asset)
    if (['手续费', '充值', '提现'].includes(row.type)) add(row, row.asset)
    if (row.scope.startsWith('wallet:') && ['收到', '转出'].includes(row.type)) for (const move of row.movements ?? []) add(row, move.asset, move.token)
  }
  if (!assets.size) return []
  // 只借用公开报价入口，空持仓用于查价，不写入账户或资产余额。
  assets.set('binance:USDT', { id: 'binance:USDT', symbol: 'USDT', market: 'crypto', usdPrice: null, positions: [] })
  const quotes = await marketPrices({ accounts: [], holdings: [...assets.values()], contracts: [] }, { now })
  const settle = quotes.holdings.get('binance:USDT')
  const valid = quote => quote && Number.isSafeInteger(quote.at) && quote.at <= now.getTime() + 30000 && now.getTime() - quote.at <= 300000 && decimal(quote.usdPrice).gt(0) && decimal(quote.usdPrice).lte('1e12')
  if (!valid(settle)) throw new ConnectionError('暂未取得USDT报价，收付和手续费原始金额保留。', 502)
  const result = new Map()
  for (const [id, quote] of quotes.holdings) {
    if (!assets.has(id) || id === 'binance:USDT') continue
    try {
      if (!valid(quote)) continue
      const key = coinKey({ id, market: 'crypto' }), price = decimal(quote.usdPrice).div(settle.usdPrice)
      if (!price.gt(0) || price.gt('1e12')) continue
      result.set(key, { key, price: price.toFixed(), at: Math.min(quote.at, settle.at) })
    } catch { /* 单币缺价不使用旧成交价或猜测金额。 */ }
  }
  return [...result.values()]
}

import { createHmac, createHash } from 'node:crypto'
import { cents, ConnectionError, decimal, holding, icons, nativeChanges24h, nativePrices, requestJson, validChange24h } from './connection-http.mjs'
import { parseWalletScope, stockBidPrice, walletScopes } from './binance-wallets.mjs'
import { parseBinanceMarginPools } from './binance-margin.mjs'
import { validMarginPools } from '../src/data/margin-risk.ts'
import { readBinanceExitOrders } from './binance-protection.mjs'
const spot = 'https://api.binance.com'
const futures = 'https://fapi.binance.com'
const allowed = new Set(['/sapi/v1/account/apiRestrictions', '/api/v3/account', '/fapi/v3/account', '/fapi/v3/positionRisk', '/fapi/v1/symbolConfig', '/fapi/v1/multiAssetsMargin', '/fapi/v1/openAlgoOrders', '/sapi/v1/asset/wallet/balance'])
const historyAllowed = new Set(['/api/v3/myTrades', '/sapi/v1/capital/deposit/hisrec', '/sapi/v1/capital/withdraw/history', '/sapi/v1/asset/transfer', '/fapi/v1/userTrades', '/fapi/v1/income', '/sapi/v1/rebate/taxQuery'])
export function signQuery(params, secret) { const query = new URLSearchParams(params).toString(); return query + '&signature=' + createHmac('sha256', secret).update(query).digest('hex') }
export function parseBinanceUid(value) {
  const uid = typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9][0-9]{0,29}$/.test(uid)) throw new ConnectionError('币安UID无法确认，暂不替换已有账户资料。', 502)
  return uid
}
export function checkReadOnly(value) {
  if (!value || value.enableReading !== true) throw new ConnectionError('无法确认这把密钥具有读取权限，本次不读取账户。')
  const flags = ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableSpotAndMarginTrading', 'enableMargin', 'enableFutures', 'enableVanillaOptions', 'enablePortfolioMarginTrading', 'enableFixApiTrade']
  if (flags.some(flag => value[flag] === true)) throw new ConnectionError('这把密钥包含交易、转账或提现权限，请改用仅开启读取的密钥。')
}
export async function createBinanceClient(credentials, fetchJson = requestJson) {
  const clock = await fetchJson(spot + '/api/v3/time')
  if (!Number.isSafeInteger(clock?.serverTime) || Math.abs(clock.serverTime - Date.now()) > 86400000) throw new ConnectionError('平台时间无法校准。', 502)
  const offset = clock.serverTime - Date.now()
  const signed = async (base, path, params = {}) => {
    if (!(allowed.has(path) || historyAllowed.has(path)) || base !== (path.startsWith('/fapi/') ? futures : spot)) throw new ConnectionError('不允许调用该接口。')
    return fetchJson(base + path + '?' + signQuery({ ...params, recvWindow: '5000', timestamp: String(Date.now() + offset) }, credentials.apiSecret), { headers: { 'X-MBX-APIKEY': credentials.apiKey } })
  }
  checkReadOnly(await signed(spot, '/sapi/v1/account/apiRestrictions'))
  return signed
}
let marketCache
export function buildBinanceMarket(tickers, native = {}, nativeChanges = {}, now = Date.now()) {
  const usd = new Map([['USD', '1']]), priorUsd = new Map([['USD', '1']]), symbols = new Map(), changes24h = new Map()
  for (const [symbol, id] of [['USDT', 'tether'], ['USDC', 'usd-coin'], ['BTC', 'bitcoin'], ['ETH', 'ethereum'], ['BNB', 'binancecoin']]) {
    if (native[id] === undefined) continue
    try {
      const price = decimal(native[id])
      if (!price.gt(0)) continue
      usd.set(symbol, price.toFixed())
      if (validChange24h(nativeChanges[id]) && nativeChanges[id] > -100) priorUsd.set(symbol, price.div(decimal(nativeChanges[id], '24小时涨跌', true).div(100).plus(1)).toFixed())
    } catch { /* 无可靠美元报价时继续由交易对补全。 */ }
  }
  const quotes = ['FDUSD', 'USDT', 'USDC', 'TUSD', 'USDP', 'DAI', 'BTC', 'ETH', 'BNB']
  const pairs = []
  for (const item of tickers) {
    if (typeof item?.symbol !== 'string') continue
    const quoteAsset = quotes.find(quote => item.symbol.length > quote.length && item.symbol.endsWith(quote))
    if (!quoteAsset) continue
    try {
      if (item.price === undefined && (!Number.isSafeInteger(item.closeTime) || Math.abs(now - item.closeTime) > 300000)) continue
      const price = decimal(item.price ?? item.lastPrice, '现货报价')
      if (!price.gt(0)) continue
      const pair = { baseAsset: item.symbol.slice(0, -quoteAsset.length), quoteAsset, price }
      try {
        const open = decimal(item.openPrice, '24小时前报价')
        if (open.gt(0) && Number.isSafeInteger(item.openTime) && Number.isSafeInteger(item.closeTime) && Math.abs(now - item.closeTime) <= 300000 && Math.abs(item.closeTime - item.openTime - 86400000) <= 60000) pair.priorPrice = open
      } catch { /* 只有现价时仍可估值，24小时涨跌保持未知。 */ }
      symbols.set(item.symbol, pair); pairs.push(pair)
    } catch { /* 单个交易对报价异常不清空其他报价。 */ }
  }
  for (let pass = 0; pass < 4; pass++) for (const pair of pairs) {
    if (!usd.has(pair.baseAsset) && usd.has(pair.quoteAsset)) usd.set(pair.baseAsset, pair.price.mul(usd.get(pair.quoteAsset)).toFixed())
    if (!usd.has(pair.quoteAsset) && usd.has(pair.baseAsset)) usd.set(pair.quoteAsset, decimal(usd.get(pair.baseAsset)).div(pair.price).toFixed())
    if (pair.priorPrice && !priorUsd.has(pair.baseAsset) && priorUsd.has(pair.quoteAsset)) priorUsd.set(pair.baseAsset, pair.priorPrice.mul(priorUsd.get(pair.quoteAsset)).toFixed())
    if (pair.priorPrice && !priorUsd.has(pair.quoteAsset) && priorUsd.has(pair.baseAsset)) priorUsd.set(pair.quoteAsset, decimal(priorUsd.get(pair.baseAsset)).div(pair.priorPrice).toFixed())
  }
  for (const [symbol, price] of usd) if (priorUsd.has(symbol)) {
    const change = decimal(price).div(priorUsd.get(symbol)).minus(1).mul(100).toNumber()
    if (validChange24h(change)) changes24h.set(symbol, change)
  }
  return { usd, symbols, changes24h }
}
async function marketData() {
  if (marketCache && Date.now() - marketCache.at < 30000) return marketCache
  const warnings = []
  const quotes = (async () => {
    for (const path of ['/api/v3/ticker/24hr', '/api/v3/ticker/price']) for (const base of [spot, 'https://data-api.binance.vision']) {
      try { const data = await requestJson(base + path); if (!Array.isArray(data)) throw new ConnectionError('行情格式无法识别。', 502); return data }
      catch (error) { warnings.push((base === spot ? '币安行情主站：' : '币安备用行情：') + (error instanceof ConnectionError ? error.message : '暂不可用')) }
    }
    return []
  })()
  const [tickers, native] = await Promise.all([quotes, nativePrices().catch(() => ({}))])
  const result = buildBinanceMarket(tickers, native, nativeChanges24h())
  if (!result.usd.has('USDT') || !result.usd.has('USDC')) warnings.push('部分结算币美元报价未能取得；数量保留，缺报价的金额暂不计入。')
  marketCache = { ...result, at: Date.now(), warning: warnings.join('；') }; return marketCache
}
export function parseFuturesBalances(assets, usd, accountId) {
  const holdings = []
  let pnl = decimal(0), missingPnl = false
  const missingAssets = new Set()
  for (const item of assets) {
    const qty = decimal(item.walletBalance, '合约余额', true), profit = decimal(item.unrealizedProfit, '合约浮盈亏', true), price = usd.get(item.asset)
    if (qty.isNegative()) throw new ConnectionError('合约出现负资产余额，暂不能按普通保证金模式合计。', 502)
    if ((qty.gt(0) || !profit.isZero()) && !price) { missingAssets.add(item.asset); if (!profit.isZero()) missingPnl = true }
    if (qty.gt(0)) holdings.push(holding('binance:' + item.asset, accountId, item.asset, item.asset, qty.toFixed(), price ?? null, '币安合约钱包余额'))
    if (price) pnl = pnl.plus(profit.mul(price))
  }
  return { holdings, pnlCents: missingPnl ? null : cents(pnl), missingAssets }
}
export async function readBinance(connection, credentials) {
  const signed = await createBinanceClient(credentials)
  const market = await marketData()
  const sourceId = 'live-' + connection.id
  const account = (suffix, name, kind, accountGroup) => ({ id: sourceId + '-' + suffix, sourceId, name: connection.name + ' · ' + name, kind, accountGroup, originName: name, icon: '/icons/binance.svg', color: '#dbc478', status: 'ok', updatedAt: new Date().toISOString(), warning: '', pnlCents: 0 })
  const stockMarket = path => requestJson(spot + '/sapi/v1/equity/market/' + path, { headers: { 'X-MBX-APIKEY': credentials.apiKey } })
  const walletDiscovery = Promise.allSettled([signed(spot, '/sapi/v1/asset/wallet/balance', { needBalanceDetail: 'true' }), stockMarket('exchangeInfo')])
  const tasks = [
    { account: account('spot', '现货', '交易所', '现货'), read: async acc => {
      const data = await signed(spot, '/api/v3/account', { omitZeroBalances: 'true' })
      if (!Array.isArray(data?.balances)) throw new ConnectionError('现货余额格式无法识别。', 502)
      acc.uid = parseBinanceUid(data.uid)
      acc.identity = createHash('sha256').update(acc.uid).digest('hex')
      const holdings = data.balances.flatMap(item => { const qty = decimal(item.free).plus(decimal(item.locked)); return qty.gt(0) ? [holding('binance:' + item.asset, acc.id, item.asset, item.asset, qty.toFixed(), market.usd.get(item.asset) ?? null, '币安现货余额与公开报价')] : [] })
      return { holdings, contracts: [] }
    } },
    { account: account('usdm', 'U本位合约', '合约账户', '合约'), read: async acc => {
      const [data, positions, configurations, marginMode] = await Promise.all([signed(futures, '/fapi/v3/account'), signed(futures, '/fapi/v3/positionRisk'), signed(futures, '/fapi/v1/symbolConfig').catch(() => null), signed(futures, '/fapi/v1/multiAssetsMargin').catch(() => null)])
      if (!Array.isArray(data?.assets) || !Array.isArray(positions)) throw new ConnectionError('合约资料格式无法识别。', 502)
      const { holdings, pnlCents, missingAssets } = parseFuturesBalances(data.assets, market.usd, acc.id)
      acc.pnlCents = pnlCents
      const positionRows = positions.filter(item => !decimal(item.positionAmt, '合约数量', true).isZero()).map(risk => {
        const details = data.positions?.find(position => position.symbol === risk.symbol && position.positionSide === risk.positionSide) ?? {}
        const configuration = Array.isArray(configurations) ? configurations.find(item => item.symbol === risk.symbol) : null
        return { ...details, ...risk, ...(configuration ?? {}) }
      })
      const exitOrders = await readBinanceExitOrders(positionRows, symbol => signed(futures, '/fapi/v1/openAlgoOrders', { symbol, algoType: 'CONDITIONAL' }), market.usd)
      const contracts = positionRows.map((item, index) => {
        if (!/(USDT|USDC)$/.test(item.symbol)) throw new ConnectionError('发现超出普通U本位范围的合约，暂不合计该账户，避免错误估值。', 502)
        const amount = decimal(item.positionAmt, '合约数量', true), quote = market.usd.get(item.marginAsset || 'USDT')
        if (!quote) missingAssets.add(item.marginAsset || 'USDT')
        const mark = quote ? decimal(item.markPrice).mul(quote) : null, entry = quote ? decimal(item.entryPrice).mul(quote) : null
        const marginType = String(item.marginType ?? '').toLowerCase()
        const isolated = marginType === 'isolated' || item.isolated === true || decimal(item.isolatedMargin ?? 0, '逐仓保证金', true).gt(0)
        const marginMode = isolated ? '逐仓' : ['cross', 'crossed'].includes(marginType) || item.isolated === false ? '全仓' : '未知'
        if (marginMode === '未知') { acc.status = 'partial'; acc.warning = '部分仓位保证金方式或杠杆未能读取。' }
        return { exitOrders: exitOrders[index], id: acc.id + ':' + item.symbol + ':' + item.positionSide, symbol: item.symbol, name: item.symbol + ' · U本位', accountId: acc.id, direction: amount.isNegative() ? '做空' : '做多', quantity: amount.abs().toNumber(), baseAsset: market.symbols.get(item.symbol)?.baseAsset ?? item.symbol.replace(/(USDT|USDC)$/, ''), icon: icons[item.symbol.replace(/(USDT|USDC)$/, '')] ?? '', entryPriceUsd: entry?.toNumber() ?? null, markPriceUsd: mark?.toNumber() ?? null, leverage: item.leverage ? decimal(item.leverage).toNumber() : null, marginMode, marginCents: !quote || item.positionInitialMargin == null ? null : cents(decimal(item.positionInitialMargin).mul(quote)), liquidationPriceUsd: quote && decimal(item.liquidationPrice ?? 0).gt(0) ? decimal(item.liquidationPrice).mul(quote).toNumber() : null, unrealizedPnlCents: quote ? cents(decimal(item.unRealizedProfit, '单仓浮盈亏', true).mul(quote)) : null }
      })
      const marginPools = parseBinanceMarginPools(data, positionRows, contracts, marginMode?.multiAssetsMargin)
      acc.marginPools = validMarginPools(marginPools) ? marginPools : []
      if (missingAssets.size) { acc.status = 'partial'; acc.warning = [...missingAssets].join('、') + '的美元报价暂不可用；余额和仓位数量已保留，缺报价金额与盈亏暂不计入。' }
      return { holdings, contracts }
    } },
  ]
  const results = await Promise.all(tasks.map(async task => { try { const result = await task.read(task.account); const missing = result.holdings.filter(item => item.usdPrice === null).length; if (missing) { task.account.status = 'partial'; task.account.warning = [task.account.warning, missing + '项资产没有美元报价，只保留数量。', market.warning].filter(Boolean).join('；') }; task.account.updatedAt = new Date().toISOString(); return { account: task.account, ...result } } catch (error) { return { account: { ...task.account, status: 'error', updatedAt: null, warning: error instanceof ConnectionError ? error.message : '币安资料暂时无法读取。' }, holdings: [], contracts: [] } } }))
  const identity = results[0].account.identity
  if (!identity) throw new ConnectionError('现货账户身份未能确认，暂不合入余额；请核对读取权限后重试。', 502)
  const coverage = []
  let wallets, stockSymbols = null
  try {
    const [walletResult, equityResult] = await walletDiscovery
    if (walletResult.status !== 'fulfilled') throw walletResult.reason
    const data = walletResult.value, equities = equityResult.status === 'fulfilled' ? equityResult.value : null
    if (!Array.isArray(data) || data.length > 100 || data.some(wallet => typeof wallet?.walletName !== 'string')) throw new ConnectionError('钱包列表格式无法识别。', 502)
    wallets = data
    if (Array.isArray(equities?.symbols)) stockSymbols = new Set(equities.symbols.map(item => item.symbol).filter(symbol => typeof symbol === 'string'))
  } catch (error) {
    for (const scope of walletScopes) coverage.push({ suffix: scope.suffix, label: scope.label, group: scope.group, status: 'error', warning: error instanceof ConnectionError ? error.message : '钱包明细暂不可用。' })
  }
  if (wallets) {
    const extra = []
    for (const scope of walletScopes) {
      try {
        const acc = account(scope.suffix, scope.label, '交易所', scope.group)
        const parsed = parseWalletScope(wallets, scope, acc.id, market.usd, stockSymbols)
        if (!parsed) { coverage.push({ suffix: scope.suffix, label: scope.label, group: scope.group, status: 'pending', warning: '币安未返回此钱包，尚不能确认余额。' }); continue }
        acc.originName = parsed.originName
        if (parsed.holdings.length) extra.push({ account: acc, holdings: parsed.holdings, contracts: [] })
        coverage.push({ suffix: scope.suffix, label: scope.label, group: scope.group, status: 'ok', warning: '' })
      } catch (error) { coverage.push({ suffix: scope.suffix, label: scope.label, group: scope.group, status: 'error', warning: error instanceof ConnectionError ? error.message : '钱包明细无法识别。' }) }
    }
    const stocks = extra.flatMap(part => part.holdings).filter(asset => asset.market === 'us')
    const quotes = new Map()
    // shortcut: 一次刷新最多查询32种股票，其余保留数量；大规模股票组合再增加分批后台读取。
    await Promise.all([...new Set(stocks.map(asset => asset.symbol))].slice(0, 32).map(async symbol => {
      try { quotes.set(symbol, stockBidPrice(await stockMarket('quote?symbol=' + encodeURIComponent(symbol)), symbol)) } catch { /* 休市、空报价或访问受限时保留数量。 */ }
    }))
    for (const part of extra) {
      part.holdings = part.holdings.map(asset => asset.market !== 'us' ? asset : holding(asset.id, part.account.id, asset.symbol, asset.name, asset.positions[0].quantityText, quotes.get(asset.symbol) ?? null, asset.source, { market: 'us', category: '股票', description: '来自币安股票钱包明细；按本次读取的盘口买价估值，并非最新成交价或买入成本。' }))
      if (part.holdings.some(asset => asset.usdPrice === null)) { part.account.status = 'partial'; part.account.warning = '部分资产报价暂不可用；保留数量，缺报价部分未计入净值。股票使用盘口买价估值。' }
    }
    results.push(...extra)
    const coveredNames = ['spot', '现货', '现货账户', 'usdmfutures', 'usdm', 'umfutures', 'usdⓢmfutures', ...walletScopes.flatMap(scope => scope.names)]
    const otherWallets = wallets.filter(wallet => !coveredNames.includes(wallet.walletName.toLowerCase().replace(/[\s_-]/g, ''))).map(wallet => wallet.walletName.slice(0, 60))
    if (otherWallets.length) { results[0].account.status = 'partial'; results[0].account.warning = [results[0].account.warning, '暂未纳入的钱包：' + [...new Set(otherWallets)].join('、')].filter(Boolean).join('；') }
  }
  results[0].account.walletCoverage = coverage
  for (const part of results) {
    part.account.identity = identity
    part.holdings = part.holdings.map(asset => asset.market === 'crypto' ? { ...asset, change24h: market.changes24h.get(asset.symbol) ?? null } : asset)
  }
  return results
}

import { createHash } from 'node:crypto'
import ccxt from 'ccxt'
import { exchanges } from '../src/data/live-types.ts'
import { cents, ConnectionError, decimal, holding, icons, nativePrices, requestJson } from './connection-http.mjs'

const badData = () => new ConnectionError('平台余额资料不完整，已保留上次资料。', 502)
export function exchangeIdentity(type, value) {
  const uid = typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9][0-9]{0,29}$/.test(uid)) throw new ConnectionError('无法确认账户身份，暂不合入余额。', 502)
  return { uid, identity: type + ':' + createHash('sha256').update(uid).digest('hex') }
}
export function checkExchangePermissions(type, info) {
  const allowed = type === 'okx' ? info?.perm === 'read_only' : type === 'bybit' ? info?.readOnly === 1 : info?.permType === 'read-only'
  if (!allowed) throw new ConnectionError('请使用仅有读取权限的密钥。')
}
export function parseExchangeBalances(type, balance, scope) {
  const raw = balance?.info
  let rows
  if (type === 'okx') rows = scope === 'funding' ? raw?.data : raw?.data?.[0]?.details
  if (type === 'bybit') {
    if (scope !== 'funding' && (!Array.isArray(raw?.result?.list) || raw.result.list.length !== 1)) throw badData()
    rows = scope === 'funding' ? raw?.result?.balance : raw?.result?.list?.[0]?.coin
  }
  if (type === 'bitget') rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : raw?.data?.assets
  if (type === 'gate') rows = Array.isArray(raw) ? raw : raw && [raw]
  if (!Array.isArray(rows)) throw badData()
  return rows.map(row => {
    const symbol = row.ccy ?? row.coin ?? row.marginCoin ?? row.currency
    if (typeof symbol !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(symbol)) throw badData()
    for (const field of ['liab', 'crossLiab', 'isoLiab', 'borrowAmount', 'spotBorrow', 'debt', 'borrowed']) {
      if (row[field] !== undefined && row[field] !== '' && !decimal(row[field], '借款', true).isZero()) throw new ConnectionError('此账户有借款，暂不能按普通资产余额汇总。', 502)
    }
    let quantity, pnl = decimal(0)
    if (type === 'okx') {
      pnl = scope === 'funding' ? decimal(0) : decimal(row.upl, '浮动盈亏', true)
      quantity = scope === 'funding' ? decimal(row.bal) : decimal(row.eq, '账户净值', true).minus(pnl)
    } else if (type === 'bybit') {
      quantity = decimal(row.walletBalance, '账户余额', true)
      pnl = scope === 'funding' || scope === 'spot' ? decimal(0) : decimal(row.unrealisedPnl, '浮动盈亏', true)
    } else if (type === 'bitget') {
      const equity = row.accountEquity ?? row.equity
      pnl = equity === undefined ? decimal(0) : row.equity !== undefined && row.balance !== undefined ? decimal(row.equity, '账户净值', true).minus(decimal(row.balance, '账户余额', true)) : decimal(row.unrealizedPL ?? row.unrealisedPnl, '浮动盈亏', true)
      quantity = equity === undefined ? row.balance !== undefined ? decimal(row.balance) : decimal(row.available).plus(decimal(row.frozen)).plus(decimal(row.locked ?? '0')) : decimal(equity, '账户净值', true).minus(pnl)
    } else {
      quantity = scope === 'spot' ? decimal(row.available).plus(decimal(row.locked)) : decimal(row.total, '合约余额', true)
      pnl = scope === 'spot' ? decimal(0) : decimal(row.unrealised_pnl, '浮动盈亏', true)
    }
    if (quantity.isNegative()) throw new ConnectionError('账户出现负余额，暂不能按普通资产汇总。', 502)
    return { symbol, quantity: quantity.toFixed(), pnl: pnl.toFixed() }
  })
}
export function valueExchangeBalances(type, accountId, rows, usd) {
  const holdings = [], seen = new Set()
  let pnl = decimal(0), missingPnl = false
  for (const row of rows) {
    if (seen.has(row.symbol)) throw badData()
    seen.add(row.symbol)
    const price = usd.get(row.symbol), profit = decimal(row.pnl, '浮动盈亏', true)
    if (decimal(row.quantity).gt(0)) holdings.push(holding(type + ':' + row.symbol, accountId, row.symbol, row.symbol, row.quantity, price ?? null, '平台账户余额'))
    if (!profit.isZero()) { if (price) pnl = pnl.plus(profit.mul(price)); else missingPnl = true }
  }
  return { holdings, pnlCents: missingPnl ? null : cents(pnl) }
}
export function parseExchangePositions(rows, accountId, usd) {
  if (!Array.isArray(rows)) throw badData()
  return rows.filter(row => decimal(row.contracts, '合约数量').gt(0)).map(row => {
    const [base, quoteAndSettle] = String(row.symbol).split('/')
    const [quote, settle = quote] = (quoteAndSettle ?? '').split(':')
    if (!base || !quote || !['long', 'short'].includes(row.side)) throw badData()
    const quotePrice = usd.get(quote), settlePrice = usd.get(settle)
    const price = value => value === undefined || value === null || value === '' || !quotePrice || !decimal(value).gt(0) ? null : decimal(value).mul(quotePrice).toNumber()
    const money = value => value === undefined || value === null || value === '' || !settlePrice ? null : cents(decimal(value, '合约金额', true).mul(settlePrice))
    const quantity = decimal(row.contracts).mul(decimal(row.contractSize))
    if (row.info === undefined) throw badData()
    // shortcut: 只转换线性合约；反向与期权需单独确认计价和数量后再接入。
    if (row.symbol.split(':')[0].endsWith('/USD') || !['USDT', 'USDC'].includes(settle)) throw new ConnectionError('本次包含尚未支持的合约计价类型，已保留旧资料。', 502)
    const markPriceUsd = price(row.markPrice)
    return { id: `${accountId}:${row.id ?? row.symbol}:${row.side}`, symbol: base + quote, name: row.symbol, icon: icons[base] ?? '', accountId, direction: row.side === 'long' ? '做多' : '做空', quantity: quantity.toNumber(), baseAsset: base, entryPriceUsd: price(row.entryPrice), markPriceUsd, leverage: row.leverage === undefined || row.leverage === null ? null : decimal(row.leverage).gt(0) ? decimal(row.leverage).toNumber() : null, marginMode: row.marginMode === 'cross' ? '全仓' : row.marginMode === 'isolated' ? '逐仓' : '未知', marginCents: money(row.initialMargin), liquidationPriceUsd: row.liquidationPrice && decimal(row.liquidationPrice, '强平价', true).gt(0) ? price(row.liquidationPrice) : null, unrealizedPnlCents: money(row.unrealizedPnl) }
  })
}
export async function readExchange(connection, credentials) {
  const type = connection.type, label = exchanges.find(item => item.id === type)
  const exchange = new ccxt[type]({ apiKey: credentials.apiKey, secret: credentials.apiSecret, password: credentials.passphrase, enableRateLimit: true, timeout: 18000, options: { defaultType: 'spot' } })
  exchange.number = String
  exchange.has.fetchCurrencies = false
  const deadline = Date.now() + 95000
  exchange.fetch = async (url, method = 'GET', headers) => {
    if (method !== 'GET' || Date.now() > deadline) throw new ConnectionError('只允许查询资产，或本次读取已超时。', 502)
    const data = await requestJson(url, { headers })
    if (type === 'okx' && data?.code !== '0' || type === 'bitget' && data?.code !== '00000' || type === 'bybit' && data?.retCode !== 0) throw new ConnectionError('平台拒绝本次查询，请核对密钥、口令和读取权限。', 502)
    const path = new URL(url).pathname
    if (type === 'bitget' && /\/account\/(assets|accounts|funding-assets)$/.test(path) && !Array.isArray(data.data) && !Array.isArray(data.data?.assets)) throw badData()
    if (type === 'okx' && path === '/api/v5/account/positions' && !Array.isArray(data.data) || type === 'bybit' && path === '/v5/position/list' && !Array.isArray(data.result?.list) || type === 'bitget' && /\/position\/(all-position|current-position)$/.test(path) && !Array.isArray(data.data) && !Array.isArray(data.data?.list)) throw badData()
    return data
  }
  try {
    let identity, tasks
    if (type === 'okx') {
      const info = (await exchange.privateGetAccountConfig()).data?.[0]
      checkExchangePermissions(type, info); identity = exchangeIdentity(type, info?.uid)
      tasks = [{ id: 'trading', name: '交易账户', params: { type: 'spot' }, positions: {} }, { id: 'funding', name: '资金账户', params: { type: 'funding' } }]
    } else if (type === 'bybit') {
      const info = (await exchange.privateGetV5UserQueryApi()).result
      checkExchangePermissions(type, info); identity = exchangeIdentity(type, info?.userID)
      const status = (await exchange.privateGetV5AccountInfo()).result?.unifiedMarginStatus
      if (![1, 3, 4, 5, 6].includes(status)) throw badData()
      exchange.options.enableUnifiedMargin = status === 3 || status === 4
      exchange.options.enableUnifiedAccount = status >= 5
      exchange.options.unifiedMarginStatus = status
      tasks = status === 1 ? [{ id: 'spot', name: '现货', params: { type: 'spot' } }, { id: 'usdm', name: 'U本位合约', params: { type: 'swap', subType: 'linear' }, positions: { category: 'linear', settleCoin: 'USDT', paginate: true } }] : [{ id: 'unified', name: '统一账户', params: { type: 'spot' }, positions: { category: 'linear', settleCoin: 'USDT', paginate: true } }]
      tasks.push({ id: 'funding', name: '资金账户', params: { type: 'funding' } })
    } else if (type === 'bitget') {
      const info = (await exchange.privateUtaGetV3AccountInfo()).data
      checkExchangePermissions(type, info); identity = exchangeIdentity(type, info?.userId)
      const mode = (await exchange.privateUtaGetV3AccountSettings()).data?.accountMode
      if (!['unified', 'hybrid'].includes(mode)) throw new ConnectionError('账户模式尚未确认，暂不替换已有余额。', 502)
      const uta = mode === 'unified'
      exchange.options.uta = uta
      tasks = uta ? [{ id: 'unified', name: '统一账户', params: { type: 'spot', uta: true }, positions: { uta: true, productType: 'USDT-FUTURES', paginate: true } }, { id: 'funding', name: '资金账户', params: { type: 'funding', uta: true } }] : [{ id: 'spot', name: '现货', params: { type: 'spot', uta: false } }, { id: 'usdm', name: 'U本位合约', params: { type: 'swap', productType: 'USDT-FUTURES', uta: false }, positions: { productType: 'USDT-FUTURES', uta: false } }]
    } else {
      const info = await exchange.privateAccountGetDetail()
      identity = exchangeIdentity(type, info?.user_id)
      if (info?.key?.mode !== 1) throw new ConnectionError('芝麻统一账户暂未接入，请使用普通账户。', 502)
      exchange.options.unifiedAccount = false
      tasks = [{ id: 'spot', name: '现货', params: { type: 'spot', marginMode: 'spot' } }, { id: 'usdm', name: 'U本位合约', params: { type: 'swap', settle: 'usdt' }, positions: { type: 'swap', settle: 'usdt' } }]
    }
    const native = await nativePrices().catch(() => ({}))
    const usd = new Map([['USD', '1']])
    for (const [symbol, id] of [['USDT', 'tether'], ['USDC', 'usd-coin'], ['BTC', 'bitcoin'], ['ETH', 'ethereum'], ['BNB', 'binancecoin']]) if (native[id]) usd.set(symbol, String(native[id]))
    try {
      const tickers = await exchange.fetchTickers(undefined, { type: 'spot' })
      for (const ticker of Object.values(tickers)) {
        const [base, quote] = ticker.symbol.split('/')
        if (quote === 'USDT' && usd.has('USDT') && ticker.last !== undefined && ticker.last !== null && decimal(ticker.last).gt(0)) usd.set(base, decimal(ticker.last).mul(usd.get('USDT')).toFixed())
      }
    } catch { /* 报价失败保留真实数量，金额标为待估值。 */ }
    const sourceId = 'live-' + connection.id, results = []
    for (const task of tasks) {
      const account = { id: sourceId + '-' + task.id, sourceId, name: connection.name + ' · ' + task.name, kind: task.positions ? '合约账户' : '交易所', icon: label.icon, color: '#91ad9c', ...identity, status: 'partial', updatedAt: null, warning: '仅包含本次成功读取的账户；理财、借贷、期权及其他未接入范围不包含在内。', pnlCents: null }
      try {
        const balance = await exchange.fetchBalance(task.params)
        const values = valueExchangeBalances(type, account.id, parseExchangeBalances(type, balance, task.id), usd)
        const contracts = task.positions ? parseExchangePositions(await exchange.fetchPositions(undefined, task.positions), account.id, usd) : []
        Object.assign(account, { pnlCents: values.pnlCents, updatedAt: new Date().toISOString() })
        results.push({ account, holdings: values.holdings, contracts })
      } catch (error) { results.push({ account: { ...account, status: 'error', warning: error instanceof ConnectionError ? error.message : '此账户暂时读取失败，请核对密钥、口令、读取权限或网络。' }, holdings: [], contracts: [] }) }
    }
    return results
  } catch (error) { throw error instanceof ConnectionError ? error : new ConnectionError('平台查询失败，请核对密钥、口令、读取权限或网络。', 502) }
  finally { await exchange.close() }
}

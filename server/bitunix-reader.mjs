import { createHash, randomBytes } from 'node:crypto'
import { ConnectionError, decimal, nativePrices, requestJson } from './connection-http.mjs'
import { exchangeIdentity, parseExchangePositions, valueExchangeBalances } from './exchange-reader.mjs'

export function signBitunix(params, apiKey, secret, nonce, timestamp, spot = false) {
  const query = Object.keys(params).sort().map(key => key + (spot ? '=' : '') + params[key]).join('')
  const hash = value => createHash('sha256').update(value).digest('hex')
  return hash(hash(nonce + timestamp + apiKey + query) + secret)
}
export function parseBitunixBalance(rows, futures = false) {
  if (!Array.isArray(rows) || futures && (rows.length !== 1 || rows[0]?.marginCoin !== 'USDT')) throw new ConnectionError('Bitunix余额资料不完整，已保留旧资料。', 502)
  return rows.map(row => {
    const symbol = futures ? row.marginCoin : row.coin
    if (typeof symbol !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(symbol)) throw new ConnectionError('Bitunix币种无法识别。', 502)
    const quantity = futures ? decimal(row.available).plus(decimal(row.frozen)).plus(decimal(row.margin)) : decimal(row.balance).plus(decimal(row.balanceLocked))
    const pnl = futures ? decimal(row.crossUnrealizedPNL, '浮动盈亏', true).plus(decimal(row.isolationUnrealizedPNL, '浮动盈亏', true)) : decimal(0)
    return { symbol, quantity: quantity.toFixed(), pnl: pnl.toFixed() }
  })
}
export async function readBitunix(connection, credentials) {
  const deadline = Date.now() + 95000
  const get = async (base, path, params = {}, privateRequest = true) => {
    if (Date.now() > deadline) throw new ConnectionError('Bitunix读取超时，已保留上次资料。', 502)
    const nonce = randomBytes(16).toString('hex'), timestamp = String(Date.now())
    const headers = privateRequest ? { 'api-key': credentials.apiKey, nonce, timestamp, sign: signBitunix(params, credentials.apiKey, credentials.apiSecret, nonce, timestamp, base.includes('openapi.')), 'Content-Type': 'application/json' } : {}
    const query = new URLSearchParams(params).toString()
    const response = await requestJson(base + path + (query ? '?' + query : ''), { headers })
    if (String(response?.code) !== '0' || response.data === null || response.data === undefined) throw new ConnectionError('Bitunix查询失败，请核对密钥、读取权限或网络。', 502)
    return response.data
  }
  const spot = 'https://openapi.bitunix.com', futures = 'https://fapi.bitunix.com'
  const identity = exchangeIdentity('bitunix', (await get(spot, '/api/spot/v1/user/info')).uid)
  const native = await nativePrices().catch(() => ({})), usd = new Map([['USD', '1']])
  for (const [symbol, id] of [['USDT', 'tether'], ['USDC', 'usd-coin'], ['BTC', 'bitcoin'], ['ETH', 'ethereum']]) if (native[id]) usd.set(symbol, String(native[id]))
  try {
    const rates = await get(spot, '/api/spot/v1/common/rate/list', {}, false)
    if (Array.isArray(rates)) for (const row of rates) if (usd.has(row.quoteSymbol) && typeof row.baseSymbol === 'string' && decimal(row.rate).gt(0)) usd.set(row.baseSymbol, decimal(row.rate).mul(usd.get(row.quoteSymbol)).toFixed())
  } catch { /* 缺报价保留数量。 */ }
  let tickers = []
  try { const data = await get(futures, '/api/v1/futures/market/tickers', {}, false); if (Array.isArray(data)) tickers = data } catch { /* 合约参考价可留空。 */ }
  const sourceId = 'live-' + connection.id, results = []
  for (const scope of ['spot', 'usdm']) {
    const account = { id: sourceId + '-' + scope, sourceId, name: connection.name + (scope === 'spot' ? ' · 现货' : ' · U本位合约'), kind: scope === 'spot' ? '交易所' : '合约账户', icon: '', color: '#91ad9c', ...identity, status: 'partial', updatedAt: null, warning: '仅包含现货和USDT合约；其他账户、理财及借贷尚未接入。', pnlCents: null }
    try {
      const rows = scope === 'spot' ? await get(spot, '/api/spot/v1/user/account') : await get(futures, '/api/v1/futures/account', { marginCoin: 'USDT' })
      const values = valueExchangeBalances('bitunix', account.id, parseBitunixBalance(rows, scope !== 'spot'), usd)
      let contracts = []
      if (scope !== 'spot') {
        const positions = await get(futures, '/api/v1/futures/position/get_pending_positions', { includeSubAccounts: 'false' })
        if (!Array.isArray(positions)) throw new ConnectionError('Bitunix合约资料不完整。', 502)
        contracts = parseExchangePositions(positions.map(row => {
          if (typeof row.symbol !== 'string' || !row.symbol.endsWith('USDT')) throw new ConnectionError('Bitunix合约计价暂不支持。', 502)
          return { info: row, id: row.positionId, symbol: row.symbol.slice(0, -4) + '/USDT:USDT', side: row.side === 'LONG' ? 'long' : row.side === 'SHORT' ? 'short' : '', contracts: row.qty, contractSize: '1', entryPrice: row.avgOpenPrice, markPrice: tickers.find(item => item.symbol === row.symbol)?.markPrice, initialMargin: row.margin, unrealizedPnl: row.unrealizedPNL, leverage: row.leverage, marginMode: row.marginMode === 'CROSS' ? 'cross' : row.marginMode === 'ISOLATION' ? 'isolated' : '', liquidationPrice: row.liqPrice }
        }), account.id, usd)
      }
      Object.assign(account, { pnlCents: values.pnlCents, updatedAt: new Date().toISOString() })
      results.push({ account, holdings: values.holdings, contracts })
    } catch (error) { results.push({ account: { ...account, status: 'error', warning: error instanceof ConnectionError ? error.message : 'Bitunix资料暂时读取失败。' }, holdings: [], contracts: [] }) }
  }
  return results
}

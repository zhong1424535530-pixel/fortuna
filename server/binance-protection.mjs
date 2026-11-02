import { ConnectionError, decimal } from './connection-http.mjs'
import { validExitOrders } from '../src/data/contract-protection.ts'

const kinds = { TAKE_PROFIT: '止盈', TAKE_PROFIT_MARKET: '止盈', STOP: '止损', STOP_MARKET: '止损', TRAILING_STOP_MARKET: '移动止损' }
const enabled = value => value === true || value === 'true'

export function parseBinanceExitOrders(rows, position, usdQuote) {
  if (!Array.isArray(rows) || rows.length > 1000) return null
  try {
    const amount = decimal(position.positionAmt, '持仓数量', true)
    if (amount.isZero() || !['BOTH', 'LONG', 'SHORT'].includes(position.positionSide)
      || position.positionSide === 'LONG' && amount.isNegative() || position.positionSide === 'SHORT' && amount.isPositive()) return null
    const closingSide = amount.isNegative() ? 'BUY' : 'SELL'
    const orders = []
    for (const row of rows) {
      if (!row || typeof row.symbol !== 'string' || !['BOTH', 'LONG', 'SHORT'].includes(row.positionSide) || !['BUY', 'SELL'].includes(row.side)) return null
      if (row.symbol !== position.symbol || row.positionSide !== position.positionSide || row.side !== closingSide) continue
      if (row.algoType !== 'CONDITIONAL' || row.algoStatus !== 'NEW' || !Object.hasOwn(kinds, row.orderType)) return null
      if (![undefined, true, false, 'true', 'false'].includes(row.closePosition) || ![undefined, true, false, 'true', 'false'].includes(row.reduceOnly)) return null
      if (enabled(row.closePosition) && (enabled(row.reduceOnly) || !['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(row.orderType))) return null
      // shortcut: 单向模式未标只减仓/全平的反向单无法确认用途；核实更多订单关联资料后再识别。
      if (position.positionSide === 'BOTH' && !enabled(row.reduceOnly) && !enabled(row.closePosition)) return null
      const id = typeof row.algoId === 'string' ? row.algoId : Number.isSafeInteger(row.algoId) ? String(row.algoId) : ''
      const kind = kinds[row.orderType]
      const trigger = kind === '移动止损' ? null : decimal(row.triggerPrice, '止盈止损触发价')
      if (trigger && !trigger.gt(0)) return null
      const quantity = enabled(row.closePosition) ? null : decimal(row.quantity, '委托数量').toNumber()
      const quote = usdQuote == null ? null : decimal(usdQuote, '结算币美元报价')
      if (quote && !quote.gt(0)) return null
      orders.push({ id, kind, triggerPriceUsd: trigger && quote ? trigger.mul(quote).toNumber() : null, quantity,
        triggerBasis: row.workingType === 'MARK_PRICE' ? '标记价' : row.workingType === 'CONTRACT_PRICE' ? '最新价' : '未知' })
    }
    return validExitOrders(orders) ? orders : null
  } catch { return null }
}

export async function readBinanceExitOrders(positions, fetchOrders, usd) {
  const symbols = [...new Set(positions.map(position => position.symbol))]
  const rows = new Map()
  for (let i = 0; i < symbols.length; i += 4) {
    await Promise.all(symbols.slice(i, i + 4).map(async symbol => {
      try { rows.set(symbol, await fetchOrders(symbol)) } catch (error) {
        console.warn('[合约止盈止损] 查询失败', symbol, error instanceof ConnectionError ? error.message : '返回异常')
        rows.set(symbol, null)
      }
    }))
  }
  return positions.map(position => {
    const result = parseBinanceExitOrders(rows.get(position.symbol), position, usd.get(position.symbol.endsWith('USDC') ? 'USDC' : 'USDT'))
    if (result === null && rows.get(position.symbol) != null) console.warn('[合约止盈止损] 订单资料或持仓对应关系无法确认', position.symbol)
    return result
  })
}

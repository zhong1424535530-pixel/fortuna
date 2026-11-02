import { createHash } from 'node:crypto'
import { ConnectionError, Decimal } from './connection-http.mjs'
const Exact = Decimal.clone({ precision: 100 })
export const walletDataError = () => new ConnectionError('免费来源的记录资料不完整，此范围未读全，原记录保留。', 502)
export function walletNumber(value, signed = false) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value) && !(value instanceof Exact)) throw walletDataError()
  let number
  try { number = new Exact(value) } catch { throw walletDataError() }
  if (!number.isFinite() || number.abs().gte('1e30') || !signed && number.isNegative() || number.decimalPlaces() > 36) throw walletDataError()
  return number
}
export function walletUnits(value, decimals) {
  const raw = typeof value === 'string' ? value : Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
  if (!/^\d{1,78}$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw walletDataError()
  const digits = BigInt(raw).toString().padStart(decimals + 1, '0')
  const result = decimals ? digits.slice(0, -decimals) + '.' + digits.slice(-decimals) : digits
  return walletNumber(result).toFixed()
}
export function walletText(value, limit = 100) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f]/.test(value)) throw walletDataError()
  return value
}
export function makeWalletRecord(connection, network, operation) {
  const amounts = new Map()
  for (const move of operation.moves) {
    const quantity = walletNumber(move.quantity, true), key = walletText(move.token)
    if (!amounts.has(key)) amounts.set(key, { token: key, asset: walletText(move.asset, 40), quantity: walletNumber('0', true), counterparties: new Set() })
    const entry = amounts.get(key)
    if (entry.asset !== move.asset) throw walletDataError()
    entry.quantity = entry.quantity.plus(quantity)
    if (move.counterparty) entry.counterparties.add(walletText(move.counterparty, 256))
  }
  const movements = [...amounts.values()].filter(move => !move.quantity.isZero()).map(move => ({ token: move.token, asset: move.asset, quantity: walletNumber(move.quantity.abs()).toFixed(), direction: move.quantity.isNegative() ? 'out' : 'in', counterparty: move.counterparties.size === 1 ? [...move.counterparties][0] : move.counterparties.size ? '多个地址' : '' }))
  const incoming = movements.filter(move => move.direction === 'in'), outgoing = movements.filter(move => move.direction === 'out')
  if (operation.swap && movements.length && (!incoming.length || !outgoing.length)) throw new ConnectionError('兑换只取得了一侧资产，未把它冒充收到或转出；原记录保留。', 502)
  let type
  if (incoming.length && outgoing.length) { if (!operation.swap) return null; type = '兑换' }
  else if (incoming.length) type = '收到'
  else if (outgoing.length) type = '转出'
  else if (operation.failedType) type = operation.failedType
  else return null
  if (movements.length > 100) throw walletDataError()
  const primary = (type === '转出' ? outgoing[0] : incoming[0]) ?? { asset: network.symbol, quantity: '0', counterparty: '' }
  const owner = connection.address, identity = createHash('sha256').update((connection.walletFamily ?? 'evm') + ':' + owner).digest('hex')
  return { id: `wallet:${network.id}:${owner}:${operation.hash}`, connectionId: connection.id, connectionName: connection.name, identity,
    scope: 'wallet:' + network.id, account: network.name, type, time: operation.time, asset: primary.asset, quantity: primary.quantity, symbol: '', quoteAsset: '', quoteQuantity: null, price: null,
    fees: operation.fees, realizedPnl: null, pnlAsset: '', status: operation.status, orderId: '', txHash: operation.hash, network: network.name, address: primary.counterparty,
    note: operation.note ?? '', relatedTradeId: '', movements, walletOwner: owner }
}

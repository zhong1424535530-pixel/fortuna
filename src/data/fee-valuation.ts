import { Decimal } from 'decimal.js'
import type { Transaction } from './transactions.ts'

const Money = Decimal.clone({ precision: 100 })
export type FeeValuation = { asset: string; price: string; at: number; pair: string }
const priceText = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/.test(value) && new Money(value).gt(0)

export function feeAssets(row: Transaction) {
  return [...new Set([...row.fees.map(fee => fee.asset), ...(row.type === '手续费' ? [row.asset] : [])])]
}

export function validFeeValuations(row: Transaction) {
  if (row.feeValuations === undefined) return true
  if (!['spot', 'usdm'].includes(row.scope) || !Array.isArray(row.feeValuations) || row.feeValuations.length > 4) return false
  const assets = feeAssets(row), seen = new Set<string>()
  for (const quote of row.feeValuations) {
    if (!quote || !assets.includes(quote.asset) || !/^[A-Z0-9]{1,40}$/.test(quote.asset) || quote.pair !== quote.asset + 'USDT' || quote.at !== Math.floor(row.time / 60000) * 60000 || !priceText(quote.price) || seen.has(quote.asset) || Object.keys(quote).some(key => !['asset', 'price', 'at', 'pair'].includes(key))) return false
    seen.add(quote.asset)
  }
  return true
}

export function feeInUnit(row: Transaction, fee: { asset: string; quantity: string }, unit: string): string | null {
  const quantity = new Money(fee.quantity)
  if (quantity.isZero() || fee.asset === unit) return quantity.toFixed()
  if (fee.asset === row.asset && row.quoteAsset === unit && row.price !== null && new Money(row.price).gt(0)) return quantity.mul(row.price).toFixed()
  if (unit !== 'USDT' || !validFeeValuations(row)) return null
  const quote = row.feeValuations?.find(quote => quote.asset === fee.asset)
  return quote ? quantity.mul(quote.price).toFixed() : null
}

// 手续费统一折成 USDT（按成交当分钟价）；缺历史价的保留原币，不用现价替代。
export function feesAsUsdt(row: Transaction, fees = row.fees) {
  let usdt = new Money(0), converted = false
  const rest: typeof fees = []
  for (const fee of fees) {
    const value = feeInUnit(row, fee, 'USDT')
    if (value === null) rest.push(fee)
    else { usdt = usdt.plus(value); converted = true }
  }
  return converted ? [{ asset: 'USDT', quantity: usdt.toDecimalPlaces(8).plus(0).toFixed() }, ...rest] : rest
}

export const feeRecordKey = (row: Transaction) => JSON.stringify([row.id, row.identity, row.scope, row.type, row.time, row.asset, row.quantity, row.fees])

import Decimal from 'decimal.js'
import type { DayOpenPrice } from './live-types.ts'
import type { Account, Holding } from './portfolio.ts'
import { calendarToday } from './return-range.ts'

export function validDayOpen(value: unknown): value is DayOpenPrice {
  if (!value || typeof value !== 'object') return false
  const quote = value as DayOpenPrice
  if (typeof quote.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date) || !Number.isFinite(quote.usdPrice) || quote.usdPrice <= 0 || quote.usdPrice > 1e12 || !Number.isSafeInteger(quote.at) || quote.at <= 0) return false
  const midnight = Date.parse(quote.date + 'T00:00:00+08:00')
  return Number.isFinite(midnight) && calendarToday(new Date(midnight)) === quote.date && Math.abs(quote.at - midnight / 1000) <= 300
}

export function heldTodayPnl(items: Holding[], accountList: ReadonlyArray<Pick<Account, 'id' | 'status' | 'updatedAt'>>, today = calendarToday()) {
  let total = new Decimal(0), opening = new Decimal(0), missingCount = 0, calculatedCount = 0
  for (const asset of items.flatMap(item => item.members ?? [item])) for (const position of asset.positions) {
    const account = accountList.find(item => item.id === position.accountId)
    const priceTime = asset.priceUpdatedAt ?? account?.updatedAt
    const time = priceTime ? new Date(priceTime) : null
    if (!validDayOpen(asset.dayOpen) || asset.dayOpen.date !== today || asset.usdPrice === null || !Number.isFinite(asset.usdPrice) || asset.usdPrice < 0 || asset.manualPrice || !time || !Number.isFinite(time.getTime()) || calendarToday(time) !== today || account?.status === 'error') { missingCount++; continue }
    try {
      const quantity = new Decimal(position.quantityText ?? position.quantity)
      if (!quantity.isFinite() || quantity.isNegative() || quantity.toNumber() !== position.quantity) throw new Error('数量无效')
      total = total.plus(new Decimal(asset.usdPrice).minus(asset.dayOpen.usdPrice).mul(quantity))
      opening = opening.plus(new Decimal(asset.dayOpen.usdPrice).mul(quantity))
      calculatedCount++
    } catch { missingCount++ }
  }
  const pnlCents = total.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  const change = opening.gt(0) ? total.div(opening).mul(100).toNumber() : null
  const changePercent = change !== null && Number.isFinite(change) && Math.abs(change) <= Number.MAX_SAFE_INTEGER ? change : null
  return Number.isSafeInteger(pnlCents) ? { pnlCents, missingCount, calculatedCount, changePercent } : { pnlCents: 0, missingCount: missingCount + calculatedCount, calculatedCount: 0, changePercent: null }
}

export function todayPriceChange(asset: Holding, accountList: ReadonlyArray<Pick<Account, 'id' | 'status' | 'updatedAt'>>, today = calendarToday()) {
  if (asset.members) return heldTodayPnl([asset], accountList, today).changePercent
  // 与今日盈亏共用资料有效性检查，缺价、跨日或读取失败时不显示虚假涨跌。
  if (!validDayOpen(asset.dayOpen) || !heldTodayPnl([asset], accountList, today).calculatedCount) return null
  const change = new Decimal(asset.usdPrice!).div(asset.dayOpen.usdPrice).minus(1).mul(100).toNumber()
  return Number.isFinite(change) && Math.abs(change) <= Number.MAX_SAFE_INTEGER ? change : null
}

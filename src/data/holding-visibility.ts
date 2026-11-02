import Decimal from 'decimal.js'
import type { Holding } from './portfolio.ts'

const Money = Decimal.clone({ precision: 60 })

export function visibleHoldings<T extends Pick<Holding, 'id' | 'usdPrice' | 'positions'>>(items: readonly T[]): T[] {
  const values = new Map<string, Decimal | null>()
  for (const asset of items) {
    if (values.has(asset.id) && values.get(asset.id) === null) continue
    try {
      if (asset.usdPrice === null || !Number.isFinite(asset.usdPrice) || asset.usdPrice < 0) throw new Error()
      let quantity = new Money(0)
      for (const position of asset.positions) {
        const amount = new Money(position.quantityText ?? position.quantity)
        if (!amount.isFinite() || amount.isNegative() || amount.toNumber() !== position.quantity) throw new Error()
        quantity = quantity.plus(amount)
      }
      // 用未舍入金额判断，避免0.9999美元显示成1美元后漏掉。
      values.set(asset.id, (values.get(asset.id) ?? new Money(0)).plus(quantity.mul(asset.usdPrice)))
    } catch { values.set(asset.id, null) }
  }
  return items.filter(asset => values.get(asset.id) === null || values.get(asset.id)!.gte(1))
}

import Decimal from 'decimal.js'
import { coinKey } from './asset-identity.ts'
import { accountBalances, assetAccountGroups, holdingValueCents, sortedHoldings } from './portfolio.ts'
import type { AssetAccountGroup, Holding } from './portfolio.ts'
import { visibleHoldings } from './holding-visibility.ts'

export function overviewHoldings(items: readonly Holding[] = sortedHoldings) {
  items = items.flatMap(asset => asset.members ?? [asset])
  const eligible = new Set(visibleHoldings(items.map(asset => ({ ...asset, id: coinKey(asset) }))).map(asset => asset.id))
  const groups = new Map<string, { id: string; assets: Holding[]; valueCents: number; missingPrices: number }>()
  for (const asset of items) {
    const id = coinKey(asset)
    if (!eligible.has(id)) continue
    let group = groups.get(id)
    if (!group) { group = { id, assets: [], valueCents: 0, missingPrices: 0 }; groups.set(id, group) }
    group.assets.push(asset)
    group.valueCents += holdingValueCents(asset)
    if (asset.usdPrice === null) group.missingPrices++
  }
  return [...groups.values()].sort((a, b) => b.valueCents - a.valueCents)
}

export function mergeHoldingRows(items: readonly Holding[]) {
  return overviewHoldings(items).map(group => {
    if (group.assets.length === 1) return group.assets[0]
    let quantity = new Decimal(0), value = new Decimal(0)
    for (const asset of group.assets) for (const position of asset.positions) {
      const amount = new Decimal(position.quantityText ?? position.quantity)
      quantity = quantity.plus(amount)
      if (asset.usdPrice !== null) value = value.plus(amount.mul(asset.usdPrice))
    }
    const first = group.assets[0]
    return {
      ...first, id: group.id, members: group.assets,
      fxPending: group.assets.some(asset => asset.fxPending),
      icon: group.assets.find(asset => asset.icon)?.icon ?? first.icon,
      usdPrice: group.missingPrices || quantity.isZero() ? null : value.div(quantity).toNumber(),
      positions: group.assets.flatMap(asset => asset.positions),
      priceUpdatedAt: group.assets.every(asset => asset.priceUpdatedAt) ? group.assets.map(asset => asset.priceUpdatedAt!).sort()[0] : undefined,
    }
  })
}

export function overviewSources(groups: readonly AssetAccountGroup[] = assetAccountGroups(), balances = accountBalances) {
  return groups.map(group => {
    const entries = balances.filter(account => group.accountIds.includes(account.id))
    return {
      ...group,
      icon: group.id.startsWith('wallet:') ? '/icons/wallet-networks.png' : group.icon,
      valueCents: entries.reduce((sum, account) => sum + account.assetsCents, 0),
      unread: entries.length === 0 || entries.every(account => account.kind !== '手动账户' && !account.updatedAt),
      color: entries[0]?.color ?? '#9fffd2',
    }
  }).sort((a, b) => b.valueCents - a.valueCents)
}

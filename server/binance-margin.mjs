import { Decimal } from 'decimal.js'

const Money = Decimal.clone({ precision: 100 })
const value = (input, signed = false) => typeof input === 'string' && input.length <= 80 && (signed ? /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/ : /^(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/).test(input) ? new Money(input) : null
const sum = values => values.some(item => item === null) ? null : values.reduce((total, item) => total.plus(item), new Money(0)).toFixed()

// 同一全仓资金池只列一次；逐仓的余额必须包含该仓未实现盈亏。
export function parseBinanceMarginPools(data, rawPositions, contracts, multiAssets) {
  const pools = [], cross = new Map()
  for (let i = 0; i < contracts.length; i++) {
    const position = contracts[i], raw = rawPositions[i]
    if (position.marginMode === '逐仓') {
      pools.push({ id: 'isolated:' + position.id, label: `${position.symbol} ${position.direction} · 逐仓`, asset: raw.marginAsset || position.symbol.match(/(USDT|USDC)$/)?.[0] || 'USD', maintenance: value(raw.maintMargin)?.toFixed() ?? null, balance: sum([value(raw.isolatedWallet), value(raw.unRealizedProfit, true)]) })
    } else {
      const asset = raw.marginAsset || position.symbol.match(/(USDT|USDC)$/)?.[0] || 'USD'
      if (!cross.has(asset)) cross.set(asset, [])
      cross.get(asset).push(position.marginMode === '全仓' ? value(raw.maintMargin) : null)
    }
  }
  if (!cross.size) return pools
  if (multiAssets === true) {
    // 混合逐仓时不能直接使用账户总保证金作为全仓分母。
    const complete = !pools.length && [...cross.values()].flat().every(item => item !== null)
    pools.unshift({ id: 'multi-assets', label: '联合保证金 · 全仓', asset: 'USD', maintenance: complete ? value(data.totalMaintMargin)?.toFixed() ?? null : null, balance: complete ? value(data.totalMarginBalance, true)?.toFixed() ?? null : null })
  } else {
    for (const [asset, maintenance] of cross) {
      const balance = data.assets?.find(item => item.asset === asset)
      pools.push({ id: 'cross:' + asset, label: asset + ' 全仓', asset, maintenance: multiAssets === false ? sum(maintenance) : null, balance: multiAssets === false ? sum([value(balance?.crossWalletBalance, true), value(balance?.crossUnPnl, true)]) : null })
    }
  }
  return pools
}

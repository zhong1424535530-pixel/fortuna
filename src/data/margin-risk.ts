import { Decimal } from 'decimal.js'
import type { LiveAccount, LiveContract, MarginPool } from './live-types.ts'

const amount = (value: unknown, signed = false) => typeof value === 'string' && value.length <= 80 && (signed ? /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/ : /^(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/).test(value)
export function validMarginPools(value: unknown): value is MarginPool[] {
  return Array.isArray(value) && value.length <= 1000 && new Set(value.map(row => row?.id)).size === value.length && value.every(row => row && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200 && typeof row.label === 'string' && row.label.length > 0 && row.label.length <= 160 && typeof row.asset === 'string' && /^[A-Z0-9]{1,20}$/.test(row.asset) && (row.maintenance === null || amount(row.maintenance)) && (row.balance === null || amount(row.balance, true)))
}

export function marginRatio(pool: MarginPool) {
  if (pool.maintenance === null || pool.balance === null) return { percent: null, exhausted: false }
  const maintenance = new Decimal(pool.maintenance), balance = new Decimal(pool.balance)
  if (balance.lte(0)) return { percent: null, exhausted: maintenance.gt(0) }
  const percent = maintenance.div(balance).mul(100).toNumber()
  return { percent: Number.isFinite(percent) ? percent : null, exhausted: false }
}

type MarginAccount = Pick<LiveAccount, 'id' | 'name' | 'updatedAt' | 'status' | 'marginPools'>
export function marginRows(accounts: readonly MarginAccount[], contracts: readonly Pick<LiveContract, 'id' | 'accountId' | 'symbol' | 'direction' | 'marginMode'>[], selectedIds?: readonly string[]) {
  return accounts.filter(account => (!selectedIds || selectedIds.includes(account.id)) && contracts.some(position => position.accountId === account.id)).flatMap(account => {
    const pools = account.marginPools?.length ? account.marginPools : [...new Map(contracts.filter(position => position.accountId === account.id).map(position => {
      const isolated = position.marginMode === '逐仓'
      const asset = position.symbol.match(/(USDT|USDC)$/)?.[0] ?? 'USD'
      const id = isolated ? position.id : position.marginMode + ':' + asset
      return [id, { id, label: isolated ? `${position.symbol} ${position.direction} · 逐仓` : `${asset} ${position.marginMode} · 资料待获取`, asset, maintenance: null, balance: null } satisfies MarginPool]
    })).values()]
    return pools.map(pool => ({ ...pool, key: account.id + ':' + pool.id, accountName: account.name, updatedAt: account.updatedAt, status: account.status }))
  })
}

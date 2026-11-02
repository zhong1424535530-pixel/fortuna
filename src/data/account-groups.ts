import { binanceGroups } from './live-types.ts'
import type { BinanceGroup, LiveAccount } from './live-types.ts'

// 兼容刷新前保存的现货、U本位账户，不改账户编号及历史成本。
export function binanceAccountGroup(account: Pick<LiveAccount, 'id' | 'kind' | 'accountGroup'>): BinanceGroup | null {
  if (account.accountGroup) return account.accountGroup
  if (account.id.endsWith('-spot')) return '现货'
  if (account.id.endsWith('-usdm') || account.kind === '合约账户') return '合约'
  return null
}

export function visibleBinanceGroups(accounts: (Pick<LiveAccount, 'id' | 'kind'> & Partial<Pick<LiveAccount, 'accountGroup' | 'status' | 'pnlCents'>>)[], fundedIds: Set<string>, contractIds: Set<string>) {
  return binanceGroups.filter(group => accounts.some(account => binanceAccountGroup(account) === group && (fundedIds.has(account.id) || contractIds.has(account.id) || account.pnlCents != null && account.pnlCents !== 0 || account.status && account.status !== 'ok')))
}

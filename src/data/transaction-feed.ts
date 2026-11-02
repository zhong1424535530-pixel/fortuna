import { Decimal } from 'decimal.js'
import { isTransactionReward, rewardDescription, rewardUsdtValue } from './transaction-rewards.ts'
import { buildContractHistory } from './contract-history.ts'
import type { ContractRound } from './contract-history.ts'
import { filterTransactions } from './transactions.ts'
import type { Transaction, TransactionFilters, TransactionState } from './transactions.ts'
import type { summarizeTransactions } from './transaction-summary.ts'

export const transactionCategories = ['全部', '合约', '现货', '转账', '充值', '提现', '兑换', '奖励'] as const
export type TransactionCategory = (typeof transactionCategories)[number]
export type TransactionEntry =
  | { kind: 'contract'; category: '合约'; time: number; id: string; round: ContractRound }
  | { kind: 'transaction'; category: Exclude<TransactionCategory, '全部' | '合约'>; time: number; id: string; row: Transaction }
  | { kind: 'rewards'; category: '奖励'; time: number; id: string; rows: Transaction[]; asset: string; quantity: string; label: string }
export type TransactionPageResult = { entries: TransactionEntry[]; totals: ReturnType<typeof summarizeTransactions>; sources: [string, string][]; walletPeers: Record<string, string[]>; recordCount: number; total: number; page: number; pages: number }

export function transactionCategory(row: Transaction): Exclude<TransactionCategory, '全部' | '合约'> | null {
  if (isTransactionReward(row)) return '奖励'
  if (row.scope === 'usdm' || row.type === '账户间转账') return null
  if (row.type === '充值' || row.type === '提现' || row.type === '兑换') return row.type
  if (['收到', '转出'].includes(row.type)) return '转账'
  return row.scope === 'spot' && ['买入', '卖出'].includes(row.type) ? '现货' : null
}

export function buildTransactionFeed(state: TransactionState, fundingFixes: Record<string, string> = {}, netFixes: Record<string, string> = {}) {
  const history = buildContractHistory(state, fundingFixes, netFixes)
  const entries: TransactionEntry[] = history.rounds.map(round => ({ kind: 'contract', category: '合约', id: round.id, time: round.closedAt ?? round.lastAt, round }))
  for (const row of state.records) {
    const category = transactionCategory(row)
    if (category) entries.push({ kind: 'transaction', category, id: row.id, time: row.time, row: category === '奖励' && row.type !== '奖励' ? { ...row, type: '奖励' } : row })
  }
  return { entries: entries.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)), warnings: history.warnings }
}

export function filterTransactionFeed(entries: TransactionEntry[], category: TransactionCategory, filters: TransactionFilters, status = '已平仓'): TransactionEntry[] {
  const ids = new Set(filterTransactions(entries.flatMap(entry => entry.kind === 'transaction' ? [entry.row] : []), filters).map(row => row.id))
  const from = filters.start ? Date.parse(filters.start + 'T00:00:00+08:00') : -Infinity
  const to = filters.end ? Date.parse(filters.end + 'T23:59:59.999+08:00') : Infinity
  const query = filters.query.trim().toLowerCase()
  return entries.filter(entry => {
    if (category !== '全部' && entry.category !== category) return false
    if (entry.kind !== 'contract') return entry.kind === 'transaction' && ids.has(entry.id)
    const round = entry.round
    return (!status || round.status === status) && (!filters.source || round.connectionId === filters.source) && entry.time >= from && entry.time <= to && (!query || [round.symbol, round.asset, round.connectionName, round.direction, ...round.fills.map(fill => fill.row.orderId)].some(value => value.toLowerCase().includes(query)))
  })
}

// 同一天、同账户、同奖励类型、同折算币的奖励合成一张卡，避免小额返佣淹没交易；只有一笔时保持原样。
export function groupRewards(entries: TransactionEntry[]): TransactionEntry[] {
  const groups = new Map<string, Extract<TransactionEntry, { kind: 'transaction' }>[]>()
  const keyOf = (entry: TransactionEntry) => {
    if (entry.kind !== 'transaction' || entry.category !== '奖励') return ''
    const row = entry.row
    return [new Date(entry.time).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), row.connectionId, row.account, rewardDescription(row), rewardUsdtValue(row) === null ? row.asset : 'USDT'].join('|')
  }
  for (const entry of entries) {
    const key = keyOf(entry)
    if (key && entry.kind === 'transaction') groups.set(key, [...groups.get(key) ?? [], entry])
  }
  const result: TransactionEntry[] = []
  for (const entry of entries) {
    const key = keyOf(entry), members = key ? groups.get(key)! : []
    if (members.length < 2) { result.push(entry); continue }
    if (members[0] !== entry) continue
    const rows = members.map(member => member.row), asset = key.split('|').at(-1)!
    const quantity = rows.reduce((sum, row) => sum.plus(rewardUsdtValue(row) ?? row.quantity), new Decimal(0)).toFixed()
    result.push({ kind: 'rewards', category: '奖励', time: entry.time, id: 'rewards:' + key, rows, asset, quantity, label: rewardDescription(rows[0]) })
  }
  return result
}

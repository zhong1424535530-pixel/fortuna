import { Decimal } from 'decimal.js'
import type { ContractRound } from './contract-history.ts'
import type { Transaction } from './transactions.ts'
import { isTransactionReward } from './transaction-rewards.ts'
import { calendarToday } from './return-range.ts'

const Money = Decimal.clone({ precision: 80 })
export const returnCategories = ['合约交易盈亏', '奖励收入', '资金费', '交易手续费', '转账费用'] as const
export type ReturnMarket = 'all' | 'crypto' | 'contracts' | 'us' | 'cn' | 'cash' | 'other'
export type ReturnEntry = { id: string; time: number; asset: string; amount: string; category: (typeof returnCategories)[number]; row: Transaction }
export type ReturnDay = { label: string; amount: string; cumulative: string }
export type ReturnFilters = { start: number; end: number; source: string; market: ReturnMarket; asset: string }

export function buildReturnEntries(records: Transaction[]): ReturnEntry[] {
  const rows = new Map(records.map(row => [row.id, row]))
  const entries: ReturnEntry[] = []
  for (const row of rows.values()) {
    const completed = row.status === '已完成' || row.status === '已记录'
    // 链上失败交易仍可能实际支付矿工费，其他失败/处理中记录不计入。
    if (!completed && !(row.status === '失败' && row.scope.startsWith('wallet:'))) continue
    const add = (category: ReturnEntry['category'], asset: string, amount: string, suffix: string) => {
      entries.push({ id: row.id + ':' + suffix, time: row.time, asset, amount: new Money(amount).toFixed(), category, row })
    }
    const trade = rows.get(row.relatedTradeId)
    const linkedTrade = trade && trade.scope === 'usdm' && ['买入', '卖出'].includes(trade.type) && ['已完成', '已记录'].includes(trade.status) ? trade : null
    if (completed) {
      if (row.scope === 'usdm' && ['买入', '卖出'].includes(row.type) && row.realizedPnl !== null) add('合约交易盈亏', row.pnlAsset, row.realizedPnl, 'pnl')
      else if (row.scope === 'usdm' && row.type === '已实现盈亏') {
        if (!linkedTrade || linkedTrade.pnlAsset !== row.asset || linkedTrade.realizedPnl === null || !new Money(linkedTrade.realizedPnl).eq(row.quantity)) add('合约交易盈亏', row.asset, row.quantity, 'pnl')
      } else if (isTransactionReward(row)) add('奖励收入', row.asset, row.quantity, 'reward')
      else if (row.type === '资金费') add('资金费', row.asset, row.quantity, 'funding')
      else if (row.type === '手续费' && (!linkedTrade || !linkedTrade.fees.some(fee => fee.asset === row.asset && new Money(fee.quantity).negated().eq(row.quantity)))) add('交易手续费', row.asset, row.quantity, 'fee')
    }
    row.fees.forEach((fee, index) => add(['买入', '卖出', '兑换'].includes(row.type) ? '交易手续费' : '转账费用', fee.asset, new Money(fee.quantity).negated().toFixed(), 'fee:' + index))
  }
  return entries.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
}

export function returnMarketMatches(scope: string, market: ReturnMarket) {
  return market === 'all' || (market === 'contracts' ? scope === 'usdm' : market === 'crypto' ? scope === 'spot' || scope === 'spot-rebate' || scope.startsWith('wallet:') || scope === 'capital' : false)
}

export function filterReturnEntries(entries: ReturnEntry[], filter: ReturnFilters) {
  return entries.filter(entry => entry.time >= filter.start && entry.time <= filter.end && (!filter.source || 'live-' + entry.row.connectionId === filter.source) && (!filter.asset || entry.asset === filter.asset) && returnMarketMatches(entry.row.scope, filter.market))
}

export function returnTotal(entries: Pick<ReturnEntry, 'asset' | 'amount'>[]): string | null {
  if (!entries.length || new Set(entries.map(entry => entry.asset)).size !== 1) return null
  return entries.reduce((sum, entry) => sum.plus(entry.amount), new Money(0)).toFixed()
}

export function returnDays(entries: Pick<ReturnEntry, 'time' | 'asset' | 'amount'>[]): ReturnDay[] {
  if (new Set(entries.map(entry => entry.asset)).size > 1) return []
  const days = new Map<string, Decimal>()
  for (const entry of entries) {
    const label = calendarToday(new Date(entry.time))
    days.set(label, (days.get(label) ?? new Money(0)).plus(entry.amount))
  }
  let cumulative = new Money(0)
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([label, amount]) => {
    cumulative = cumulative.plus(amount)
    return { label, amount: amount.toFixed(), cumulative: cumulative.toFixed() }
  })
}

export function returnDaySlots(days: ReturnDay[], start: number, end: number) {
  const first = start ? calendarToday(new Date(start)) : days[0]?.label ?? calendarToday(new Date(end))
  const last = calendarToday(new Date(end)), byDate = new Map(days.map(day => [day.label, day]))
  const slots: { label: string; amount: string | null; cumulative: string | null }[] = []
  for (let time = Date.parse(first + 'T00:00:00Z'); time <= Date.parse(last + 'T00:00:00Z'); time += 86400000) {
    const label = new Date(time).toISOString().slice(0, 10)
    slots.push(byDate.get(label) ?? { label, amount: null, cumulative: null })
  }
  return slots
}

type DaySlot = { label: string; amount: string | null; cumulative: string | null }
const DATE = /^\d{4}-\d{2}-\d{2}$/
// 日期跨度超过 60 天（约两个月）时，每日柱子太密，改成每周一根
export const WEEKLY_AFTER_DAYS = 60
export function isWeekly(slots: DaySlot[]) {
  const first = slots[0]?.label, last = slots.at(-1)?.label
  return !!first && !!last && DATE.test(first) && DATE.test(last) && (Date.parse(last + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / 86400000 + 1 > WEEKLY_AFTER_DAYS
}
// 按周一起算的自然周合并；标签用周一的日期。一周内全是空日则仍为空。
export function groupWeeks(slots: DaySlot[]): DaySlot[] {
  const weeks = new Map<string, Decimal | null>()
  for (const slot of slots) {
    const date = new Date(slot.label + 'T00:00:00Z')
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
    const label = date.toISOString().slice(0, 10), total = weeks.get(label) ?? null
    weeks.set(label, slot.amount === null ? total : (total ?? new Money(0)).plus(slot.amount))
  }
  // 首尾之间没有记录的周也补一根空位，时间轴才均匀
  const labels = [...weeks.keys()].sort(), result: DaySlot[] = []
  if (!labels.length) return result
  for (let time = Date.parse(labels[0] + 'T00:00:00Z'); time <= Date.parse(labels.at(-1)! + 'T00:00:00Z'); time += 7 * 86400000) {
    const label = new Date(time).toISOString().slice(0, 10), amount = weeks.get(label) ?? null
    result.push({ label, amount: amount === null ? null : amount.toFixed(), cumulative: null })
  }
  return result
}

export function returnRanking(entries: ReturnEntry[], by: 'asset' | 'source') {
  const groups = new Map<string, { id: string; label: string; amounts: ReturnEntry[] }>()
  for (const entry of entries) {
    const id = by === 'source' ? entry.row.identity : entry.row.symbol || entry.asset
    const group = groups.get(id) ?? { id, label: by === 'source' ? entry.row.connectionName : entry.row.symbol || entry.asset, amounts: [] }
    group.amounts.push(entry)
    groups.set(id, group)
  }
  return [...groups.values()].map(group => ({ id: group.id, label: group.label, amount: returnTotal(group.amounts), count: group.amounts.length }))
    .sort((a, b) => new Money(b.amount ?? 0).abs().comparedTo(new Money(a.amount ?? 0).abs()))
}

export function closedReturnStats(rounds: ContractRound[]) {
  const closed = rounds.filter(round => round.status === '已平仓' && round.closedAt !== null)
  const confirmed = closed.filter(round => round.netPnl !== null && !round.warnings.length)
  const sameAsset = new Set(confirmed.map(round => round.pnlAsset)).size <= 1
  const wins = confirmed.filter(round => new Money(round.netPnl!).gt(0))
  const losses = confirmed.filter(round => new Money(round.netPnl!).lt(0))
  const net = returnTotal(confirmed.map(round => ({ asset: round.pnlAsset, amount: round.netPnl! })))
  // 各分项独立展示，不让未换算的手续费挡住已保存的平仓盈亏与资金费。
  const gross = returnTotal(closed.filter(round => round.realizedPnl !== null).map(round => ({ asset: round.pnlAsset, amount: round.realizedPnl! })))
  // 手动补录整轮净盈亏的交易：净盈亏与已读到的平仓盈亏、手续费、资金费之差，来自读取范围之外的费用，单独列出才能让各项相加等于净收益。
  const manual = confirmed.filter(round => round.netManual)
  const netGap = manual.length && sameAsset ? manual.reduce((sum, round) => sum.plus(round.netPnl!).minus(round.realizedPnl ?? 0).minus(round.feePnl ?? 0).minus(round.fundingPnl ?? 0), new Money(0)).toFixed() : null
  const grossBySign = (positive: boolean) => {
    const part = closed.filter(round => round.realizedPnl !== null && (positive ? new Money(round.realizedPnl).gt(0) : new Money(round.realizedPnl).lt(0)))
    return part.length ? returnTotal(part.map(round => ({ asset: round.pnlAsset, amount: round.realizedPnl! }))) : '0'
  }
  const funding = returnTotal(closed.filter(round => round.fundingPnl !== null).map(round => ({ asset: round.pnlAsset, amount: round.fundingPnl! })))
  const nativeFees = new Map<string, Decimal>()
  const feeValues = closed.map(round => {
    for (const fee of round.fees) nativeFees.set(fee.asset, (nativeFees.get(fee.asset) ?? new Money(0)).minus(fee.quantity))
    if (round.feePnl !== undefined) return round.feePnl
    return round.fees.length && round.fees.every(fee => fee.asset === round.pnlAsset || new Money(fee.quantity).isZero())
      ? round.fees.reduce((sum, fee) => sum.minus(fee.quantity), new Money(0)).toFixed() : null
  })
  const fees = feeValues.every(value => value !== null) ? returnTotal(closed.map((round, index) => ({ asset: round.pnlAsset, amount: feeValues[index]! }))) : null
  const winning = wins.reduce((sum, round) => sum.plus(round.netPnl!), new Money(0))
  const losing = losses.reduce((sum, round) => sum.plus(round.netPnl!), new Money(0)).abs()
  const longCount = closed.filter(round => round.direction === '做多').length
  return { closed, confirmed, net, netGap, gross, grossWin: grossBySign(true), grossLoss: grossBySign(false), funding, fees, nativeFees: [...nativeFees].filter(([, amount]) => !amount.isZero()).map(([asset, amount]) => ({ asset, amount: amount.toFixed() })), wins: wins.length, losses: losses.length, flat: confirmed.length - wins.length - losses.length,
    longCount, shortCount: closed.length - longCount,
    averageWin: sameAsset && wins.length ? winning.div(wins.length).toFixed() : null,
    averageLoss: sameAsset && losses.length ? losing.div(losses.length).toFixed() : null,
    winRate: sameAsset && confirmed.length ? wins.length / confirmed.length * 100 : null,
    payoff: sameAsset && wins.length && losses.length ? winning.div(wins.length).div(losing.div(losses.length)).toFixed() : null }
}

export function closedReturnDays(rounds: ContractRound[]): ReturnDay[] {
  return returnDays(closedReturnStats(rounds).confirmed.map(round => ({ time: round.closedAt!, asset: round.pnlAsset, amount: round.netPnl! })))
}

export function closedReturnCalendarDays(rounds: ContractRound[]) {
  const days = new Map<string, ContractRound[]>()
  for (const round of rounds) {
    if (round.closedAt === null || round.status === '持仓中') continue
    const date = calendarToday(new Date(round.closedAt))
    const group = days.get(date) ?? []
    group.push(round); days.set(date, group)
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => {
    const stats = closedReturnStats(group)
    const pending = group.length - stats.confirmed.length
    return { date, count: group.length, pending, amount: pending ? null : stats.net }
  })
}

export function closedFundingBreakdown(rounds: ContractRound[], entries: ReturnEntry[]) {
  const stats = closedReturnStats(rounds)
  const unknown = { income: null, expense: null }
  const known = stats.closed.filter(round => round.fundingPnl !== null)
  if (!known.length || stats.funding === null) return unknown
  let income = new Money(0), expense = new Money(0)
  const groups = new Map<string, ContractRound[]>()
  for (const round of known) {
    const key = round.identity + ':' + round.symbol
    const group = groups.get(key) ?? []
    group.push(round); groups.set(key, group)
  }
  for (const entry of entries) if (entry.category === '资金费') {
    const owners = (groups.get(entry.row.identity + ':' + entry.row.symbol) ?? []).filter(round => round.openedAt !== null && entry.time > round.openedAt && entry.time < round.closedAt! && entry.asset === round.pnlAsset)
    if (owners.some(round => round.fundingManual)) continue
    if (owners.length > 1) return unknown
    if (owners.length === 1) {
      if (new Money(entry.amount).gte(0)) income = income.plus(entry.amount)
      else expense = expense.plus(entry.amount)
    }
  }
  for (const round of known.filter(round => round.fundingManual)) {
    if (new Money(round.fundingPnl!).gte(0)) income = income.plus(round.fundingPnl!)
    else expense = expense.plus(round.fundingPnl!)
  }
  return income.plus(expense).eq(stats.funding) ? { income: income.toFixed(), expense: expense.toFixed() } : unknown
}

// 盈利各自占盈利合计、亏损各自占亏损合计；盈亏并存时分居零轴两侧，每侧最长占半宽。
export function rankShares(amounts: (string | null)[]) {
  const values = amounts.map(amount => new Money(amount ?? 0))
  const gains = values.reduce((sum, value) => value.gt(0) ? sum.plus(value) : sum, new Money(0))
  const losses = values.reduce((sum, value) => value.lt(0) ? sum.plus(value.abs()) : sum, new Money(0))
  const diverging = gains.gt(0) && losses.gt(0)
  return { diverging, bars: values.map(value => {
    const side = value.lt(0) ? losses : gains
    const percent = side.isZero() ? 0 : value.abs().div(side).mul(100).toNumber()
    return { percent, width: diverging ? percent / 2 : percent }
  }) }
}

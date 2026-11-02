import { feeInUnit } from './fee-valuation.ts'
import { Decimal } from 'decimal.js'
import type { EquityPoint } from './equity-history.ts'
import type { ReturnDay, ReturnEntry } from './returns-analysis.ts'
import { returnTotal } from './returns-analysis.ts'
import { calendarToday } from './return-range.ts'
import { isTransactionReward } from './transaction-rewards.ts'
import type { TransactionState } from './transactions.ts'

const Money = Decimal.clone({ precision: 80 })
type SpotAmounts = Record<'opening' | 'closing' | 'buys' | 'sells' | 'incoming' | 'outgoing' | 'fees' | 'rewards', string | null>
export type PeriodTrade = { id: string; label: string; account: string; market: string; amount: string | null; count: number; reason: string; partial?: boolean; components?: SpotAmounts }
export type PeriodFilter = { start: number; end: number; source: string; unit: string }
type Position = NonNullable<EquityPoint['investmentPositions']>[number]
type Account = NonNullable<EquityPoint['investmentAccounts']>[number]

export function periodSpotPnl(values: SpotAmounts): string | null {
  if (Object.values(values).some(value => value === null)) return null
  return new Money(values.closing!).minus(values.opening!).plus(values.sells!).minus(values.buys!).minus(values.incoming!).plus(values.outgoing!).plus(values.fees!).minus(values.rewards!).toFixed()
}

export function tradingRanking(entries: ReturnEntry[]) {
  const groups = new Map<string, ReturnEntry[]>()
  for (const entry of entries) {
    if (entry.category !== '合约交易盈亏') continue
    const key = entry.row.identity + ':' + entry.row.symbol
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(entry)
  }
  return [...groups].map(([id, group]) => ({ id, label: group[0].row.symbol || '未注明品种', account: group[0].row.connectionName, amount: returnTotal(group), count: group.length, entries: group }))
    .sort((a, b) => new Money(b.amount ?? 0).abs().comparedTo(new Money(a.amount ?? 0).abs()))
}

// 只使用流水自带的历史价格；缺少价格时保留原币，不用今天的行情倒算。
export function valueRecordedEntries(entries: ReturnEntry[], unit: string) {
  const valued: ReturnEntry[] = [], missing: ReturnEntry[] = []
  for (const entry of entries) {
    let amount: string | null = entry.asset === unit ? entry.amount : new Money(entry.amount).isZero() ? '0' : null
    if (amount === null && entry.category === '奖励收入' && unit === 'USDT' && entry.row.rewardValuation?.basis === 'minute-open') amount = entry.row.rewardValuation.usdtQuantity
    if (amount === null && entry.category === '交易手续费') amount = feeInUnit(entry.row, { asset: entry.asset, quantity: entry.amount }, unit)
    if (amount === null) missing.push(entry)
    else valued.push({ ...entry, asset: unit, amount })
  }
  return { entries: valued, missing }
}

export function periodAnchors(points: readonly EquityPoint[], filter: PeriodFilter) {
  // 仅使用边界附近真实记录，并把实际起止时间展示出来；旧记录不向过去补平线。
  const opening = points.find(point => point.t * 1000 >= filter.start && point.t * 1000 <= filter.start + 300000)
  const closing = [...points].reverse().find(point => point.t * 1000 <= filter.end && point.t * 1000 >= filter.end - 300000)
  return { opening, closing }
}

// 现货、股票、其他资产的统一起止：范围起点附近有快照就按范围算；
// 起点之前还没有记录时，从范围内最早的快照起算，结束同理取最后一份快照，不向过去补平线。
export function spotWindow(points: readonly EquityPoint[], filter: PeriodFilter): PeriodFilter {
  const anchors = periodAnchors(points, filter)
  const usable = points.filter(point => point.investmentPositions && point.investmentAccounts && point.t * 1000 >= filter.start && point.t * 1000 <= filter.end)
  if (!usable.length) return filter
  return { ...filter, start: anchors.opening ? filter.start : usable[0].t * 1000, end: anchors.closing ? filter.end : usable.at(-1)!.t * 1000 }
}

export type SpotGroup = 'crypto' | 'stocks' | 'other'
export const spotGroupOf = (market: string): SpotGroup => market === 'crypto' ? 'crypto' : market === 'us' || market === 'cn' ? 'stocks' : 'other'

// 按北京日期取每天最后一份快照，用同一起点逐日重算期间盈亏；某天任一品种算不出来就留空，不补零。
export function spotGroupDays(state: TransactionState, points: readonly EquityPoint[], filter: PeriodFilter, current: Position[], accountList: Account[], group: SpotGroup): ReturnDay[] {
  const window = spotWindow(points, filter), lastOfDay = new Map<string, EquityPoint>()
  for (const point of points) if (point.investmentPositions && point.investmentAccounts && point.t * 1000 > window.start && point.t * 1000 <= window.end) {
    const label = calendarToday(new Date(point.t * 1000)), previous = lastOfDay.get(label)
    if (!previous || previous.t < point.t) lastOfDay.set(label, point)
  }
  const days: ReturnDay[] = []
  let before = new Money(0)
  for (const [label, point] of [...lastOfDay].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = spotPeriodRows(state, points, { ...window, end: point.t * 1000 }, current, accountList).filter(row => spotGroupOf(row.market) === group)
    if (!rows.length || rows.some(row => row.amount === null)) continue
    const total = returnTotal(rows.map(row => ({ asset: window.unit, amount: row.amount! })))
    if (total === null) continue
    days.push({ label, amount: new Money(total).minus(before).toFixed(), cumulative: total })
    before = new Money(total)
  }
  return days
}

export function periodQuote(point: EquityPoint, unit: string): Decimal | null {
  if (unit === 'USD') return new Money(1)
  const ids = new Set((point.investmentPositions ?? []).filter(row => row[1] === unit).map(row => row[0]))
  const value = point.prices.find(row => row[0] === 'binance:' + unit || ids.has(row[0]))?.[1]
  return value && value > 0 ? new Money(value) : null
}

export function spotPeriodRows(state: TransactionState, points: readonly EquityPoint[], filter: PeriodFilter, current: Position[], accountList: Account[]): PeriodTrade[] {
  const { opening, closing } = periodAnchors(points, filter)
  const knownAccounts = new Map([...accountList, ...(opening?.investmentAccounts ?? []), ...(closing?.investmentAccounts ?? [])].map(account => [account[0], account]))
  const selectedAccount = (account: Account | undefined, manual = false) => !!account && (!filter.source || account[1] === filter.source) && (manual ? account[3] !== '链上' : ['现货', '股票', '手动'].includes(account[3]))
  const candidates = new Map<string, Position>()
  for (const position of [...(opening?.investmentPositions ?? []), ...(closing?.investmentPositions ?? []), ...current]) {
    const account = knownAccounts.get(position[3])
    const manual = position[0].startsWith('manual-')
    if (position[2] !== 'cash' && (['crypto', 'us', 'cn'].includes(position[2]) || manual || account?.[3] === '手动') && selectedAccount(account, manual)) candidates.set(position[0] + ':' + position[3], position)
  }
  // 完全卖光的品种也要保留，不只看当前持仓。
  for (const row of state.records) if (row.scope === 'spot' && ['买入', '卖出'].includes(row.type) && row.time >= filter.start && row.time <= filter.end) {
    const account = [...knownAccounts.values()].find(account => account[1] === 'live-' + row.connectionId && account[3] === '现货')
    if (selectedAccount(account)) {
      const position: Position = ['binance:' + row.asset, row.asset, 'crypto', account![0], '0', null]
      const key = position[0] + ':' + position[3]
      if (!candidates.has(key)) candidates.set(key, position)
    }
  }
  return [...candidates].map(([id, position]) => {
    const account = knownAccounts.get(position[3])!
    const result: PeriodTrade = { id, label: position[1], market: position[2], account: account[2], amount: null, count: 0, reason: '' }
    const unavailable = (reason: string) => ({ ...result, reason })
    // shortcut: 人工修改日志没有投入/取出金额，接入完整变动记录前不推算手动收益。
    if (position[0].startsWith('manual-') || account[3] === '手动') return unavailable('手动资产缺少完整的期间投入、取出记录')
    if (!opening) return unavailable('缺少所选期初的持仓记录')
    if (!closing || closing.t <= opening.t) return unavailable('缺少所选期末的持仓记录')
    if (!opening.investmentPositions || !closing.investmentPositions) return unavailable('旧记录缺少持仓数量，不能核对期间买卖')
    const beforeAccount = opening.investmentAccounts?.find(row => row[0] === account[0]), afterAccount = closing.investmentAccounts?.find(row => row[0] === account[0])
    if (!beforeAccount || !afterAccount || beforeAccount[4] !== 'ok' || afterAccount[4] !== 'ok') return unavailable('期初或期末账户资料未读全')
    if (position[2] !== 'crypto') return unavailable('股票成交、分红记录尚未接入，不能还原本期盈亏')
    if (account[0] !== account[1] + '-spot') return unavailable('该子账户的买卖及划转资料尚未接入')
    const startPrice = periodQuote(opening, filter.unit), endPrice = periodQuote(closing, filter.unit)
    if (!startPrice || !endPrice) return unavailable('缺少期初或期末的' + filter.unit + '换算价格')
    const before = opening.investmentPositions.find(row => row[0] === position[0] && row[3] === position[3])
    const after = closing.investmentPositions.find(row => row[0] === position[0] && row[3] === position[3])
    if (before?.[5] === null || after?.[5] === null) return unavailable('期初或期末持仓缺少有效价格')
    const scope = state.syncs.find(sync => 'live-' + sync.connectionId === account[1] && sync.key === 'spot:' + position[1] + filter.unit && sync.status === 'ok' && (sync.coverage?.from ?? sync.from) <= opening.t * 1000 && (sync.coverage?.to ?? sync.to) >= closing.t * 1000)
    if (!scope) return unavailable('买卖记录未覆盖整个所选期间')
    if (scope.coverage && state.records.filter(row => row.identity === scope.identity && row.scope === 'spot' && ['买入', '卖出'].includes(row.type) && 'spot:' + row.symbol === scope.key && row.time >= scope.coverage!.from && row.time <= scope.coverage!.to).length !== scope.coverage.count) return unavailable('已保存成交条数与读取范围不一致')
    const rows = state.records.filter(row => 'live-' + row.connectionId === account[1] && row.time > opening.t * 1000 && row.time <= closing.t * 1000 && ['已记录', '已完成'].includes(row.status))
    if (rows.some(row => ['充值', '提现', '账户间转账', '其他收支', '兑换'].includes(row.type) && row.asset === position[1])) return unavailable('期间有该资产的转入转出，缺少发生时估值')
    const values: SpotAmounts = { opening: new Money(before?.[5] ?? 0).div(100).div(startPrice).toFixed(), closing: new Money(after?.[5] ?? 0).div(100).div(endPrice).toFixed(), buys: '0', sells: '0', incoming: '0', outgoing: '0', fees: '0', rewards: '0' }
    let quantity = new Money(before?.[4] ?? 0)
    for (const row of rows) {
      if (row.scope === 'spot' && ['买入', '卖出'].includes(row.type)) {
        if (row.quoteAsset === position[1]) return unavailable('涉及币币换仓，需要补齐历史换算价格')
        if (row.asset === position[1]) {
          if (row.quoteAsset !== filter.unit || row.quoteQuantity === null || row.price === null) return unavailable('部分买卖缺少可核对的成交金额')
          result.count++
          const field = row.type === '买入' ? 'buys' : 'sells'
          values[field] = new Money(values[field]!).plus(row.quoteQuantity).toFixed()
          quantity = quantity.plus(new Money(row.quantity).mul(row.type === '买入' ? 1 : -1))
        }
        for (const fee of row.fees.filter(fee => fee.asset === position[1])) {
          if (row.asset !== position[1] || row.quoteAsset !== filter.unit || row.price === null) return unavailable('持仓已扣费用缺少历史换算价格')
          quantity = quantity.minus(fee.quantity)
          values.fees = new Money(values.fees!).plus(new Money(fee.quantity).mul(row.price)).toFixed()
        }
      } else if (isTransactionReward(row) && row.asset === position[1] && row.scope !== 'usdm') {
        if (filter.unit !== 'USDT' || !row.rewardValuation) return unavailable('收到的奖励缺少发生时估值')
        quantity = quantity.plus(row.quantity)
        values.rewards = new Money(values.rewards!).plus(row.rewardValuation.usdtQuantity).toFixed()
      }
    }
    if (!quantity.eq(after?.[4] ?? 0)) return unavailable('期末数量与期间买卖对不上，需补齐流水')
    // shortcut: 数量相符不能证明其他交易对没有往返买卖；完整账单接入前保留部分标记。
    const discovery = state.syncs.find(sync => 'live-' + sync.connectionId === account[1] && sync.key === 'coverage:spot')
    const partial = !discovery || discovery.status !== 'ok' || discovery.from > opening.t * 1000 || discovery.to < closing.t * 1000
    return { ...result, amount: periodSpotPnl(values), partial, reason: partial ? '已记录部分；其他交易对的买卖范围尚未读全' : '按实际保存的期初、期末估值及买卖记录计算', components: values }
  })
}

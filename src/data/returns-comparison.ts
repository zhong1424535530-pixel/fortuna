import { Decimal } from 'decimal.js'
import { calendarToday } from './return-range.ts'
import type { ReturnRange } from './return-range.ts'
import type { EquityPoint } from './equity-history.ts'
import type { TransactionState } from './transactions.ts'
import { buildReturnEntries, filterReturnEntries } from './returns-analysis.ts'
import type { ReturnEntry } from './returns-analysis.ts'
import { periodAnchors, periodQuote, spotPeriodRows, spotWindow, valueRecordedEntries } from './returns-period.ts'
import type { PeriodFilter } from './returns-period.ts'

const Money = Decimal.clone({ precision: 80 }), DAY = 86400000
export type CalendarPeriod = 'month' | 'year' | null
type Bounds = { start: number; end: number }
type Position = NonNullable<EquityPoint['investmentPositions']>[number]
type Account = NonNullable<EquityPoint['investmentAccounts']>[number]
const midnight = (date: string) => Date.parse(date + 'T00:00:00+08:00')
const sum = (values: (string | null)[]) => values.every(value => value === null) ? null : values.reduce<Decimal>((total, value) => total.plus(value ?? 0), new Money(0)).toFixed()

function previousCalendarEnd(end: number, period: Exclude<CalendarPeriod, null>) {
  const local = new Date(end + 8 * 3600000), year = local.getUTCFullYear(), month = local.getUTCMonth()
  const target = new Date(Date.UTC(year - (period === 'year' ? 1 : 0), month - (period === 'month' ? 1 : 0), 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(local.getUTCDate(), lastDay))
  target.setUTCHours(local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds())
  return target.getTime() - 8 * 3600000
}

export function comparisonPeriods(range: ReturnRange, calendar: CalendarPeriod = null, now = Date.now()) {
  const today = calendarToday(new Date(now))
  if (range.period === '全部时间') return { current: { start: 0, end: now }, previous: null, label: '累计记录' }
  const days = range.period === '7天' ? 7 : range.period === '30天' ? 30 : range.period === '1天' ? 1 : 365
  const start = calendar ? midnight(today.slice(0, calendar === 'month' ? 7 : 4) + (calendar === 'month' ? '-01' : '-01-01')) : range.period === '自定义' ? midnight(range.start) : midnight(calendarToday(new Date(now - (days - 1) * DAY)))
  const end = calendar || range.period !== '自定义' ? now : Math.min(now, midnight(range.end) + DAY - 1)
  if (calendar) {
    const previousEnd = previousCalendarEnd(end, calendar), date = calendarToday(new Date(previousEnd))
    return { current: { start, end }, previous: { start: midnight(date.slice(0, calendar === 'month' ? 7 : 4) + (calendar === 'month' ? '-01' : '-01-01')), end: previousEnd }, label: calendar === 'month' ? '较上月同期' : '较去年同期' }
  }
  const span = midnight(calendarToday(new Date(end))) - start + DAY
  return { current: { start, end }, previous: { start: start - span, end: end - span }, label: '较上一期' }
}

export function comparisonDifference(current: string | null, previous: string | null) {
  return current === null || previous === null ? null : new Money(current).minus(previous).toFixed()
}

export function compareReturnAmounts(current: string | null, previous: string | null, kind: 'profit' | 'cashflow' = 'profit') {
  const difference = comparisonDifference(current, previous)
  if (difference === null) return { difference, percent: null, label: '暂无可比资料', percentLabel: '', tone: '' }
  const now = new Money(current!), before = new Money(previous!), change = new Money(difference)
  const tone = change.isZero() ? '' : change.gt(0) ? 'positive' : 'negative'
  let label = '与上期持平', percentLabel = '收益金额持平', percent: string | null = null
  if (kind === 'cashflow') {
    if (now.lt(0) && before.lt(0)) {
      label = change.lt(0) ? '净支出增加' : change.gt(0) ? '净支出减少' : '净支出持平'
      percent = now.abs().minus(before.abs()).div(before.abs()).mul(100).toFixed()
    } else if (now.gte(0) && before.gt(0)) {
      label = change.gt(0) ? '净收入增加' : change.lt(0) ? '净收入减少' : '净收入持平'
      percent = change.div(before).mul(100).toFixed()
    } else if (now.gt(0) && before.lt(0)) label = '由支出转收入 · 增加'
    else if (now.lt(0) && before.gt(0)) label = '由收入转支出 · 减少'
    else if (before.isZero() && !now.isZero()) label = now.gt(0) ? '本期新增净收入' : '本期新增净支出'
    else if (now.isZero() && before.lt(0)) label = '净支出归零 · 减少'
    percentLabel = label
  } else {
    if (now.lt(0) && before.lt(0)) label = change.gt(0) ? '比上期少亏' : change.lt(0) ? '比上期多亏' : '亏损与上期持平'
    else if (now.gt(0) && before.lt(0)) label = '扭亏为盈 · 增加'
    else if (now.lt(0) && before.gt(0)) label = '由盈转亏 · 减少'
    else if (now.isZero() && before.lt(0)) label = '亏损归零 · 少亏'
    else if (before.isZero() && !now.isZero()) label = now.gt(0) ? '本期新增盈利' : '本期新增亏损'
    else if (!change.isZero()) label = change.gt(0) ? '比上期多赚' : '比上期少赚'
    if (before.gt(0)) {
      percent = change.div(before).mul(100).toFixed()
      percentLabel = change.gt(0) ? '收益金额增长' : change.lt(0) ? '收益金额减少' : '收益金额持平'
    }
  }
  return { difference, percent, label, percentLabel, tone }
}

// 沿用整期完整性校验；资料缺失时不拿已记录部分或原币费用计算涨跌幅。
export function comparisonCategoryAmounts(overview: ReturnType<typeof periodOverview> | null) {
  if (!overview || overview.comparable === null) return { spot: null, contracts: null, fees: null, funding: null, rewards: null }
  const total = (category: ReturnEntry['category']) => overview.valued.entries.filter(entry => entry.category === category).reduce((value, entry) => value.plus(entry.amount), new Money(0)).toFixed()
  return {
    spot: sum(overview.spot.filter(row => ['crypto', 'us', 'cn'].includes(row.market)).map(row => row.amount)) ?? '0',
    contracts: total('合约交易盈亏'),
    fees: total('交易手续费'), funding: total('资金费'), rewards: total('奖励收入'),
  }
}

export function periodOverview(state: TransactionState, points: readonly EquityPoint[], filter: PeriodFilter, current: Position[], accountList: Account[], entries: ReturnEntry[] = buildReturnEntries(state.records)) {
  const native = filterReturnEntries(entries, { ...filter, asset: '', market: 'all' }).filter(entry => !entry.row.scope.startsWith('wallet:') && entry.category !== '转账费用')
  const valued = valueRecordedEntries(native, filter.unit), window = spotWindow(points, filter), spot = spotPeriodRows(state, points, window, current, accountList)
  const net = sum([...spot.map(row => row.amount), ...valued.entries.map(entry => entry.amount)])
  const { opening, closing } = periodAnchors(points, filter)
  const selected = (row: Account) => row[3] !== '链上' && (!filter.source || row[1] === filter.source)
  const selectedAccounts = [...new Map([...accountList, ...(opening?.investmentAccounts ?? []), ...(closing?.investmentAccounts ?? [])].filter(selected).map(row => [row[0], row])).values()]
  const reasons: string[] = []
  if (!opening?.investmentAccounts || !closing?.investmentAccounts) reasons.push('缺少完整的期初或期末记录')
  // 快照只精确到秒；超过这一精度的边界差不能套用完整区间的收支。
  if (opening && closing && (opening.t !== Math.floor(filter.start / 1000) || closing.t !== Math.floor(filter.end / 1000))) reasons.push('估值时刻未覆盖完整的所选起止时间')
  if (!selectedAccounts.length) reasons.push('没有可核对的投资账户')
  if (selectedAccounts.some(account => !['现货', '股票', '手动', '合约'].includes(account[3]))) reasons.push('部分账户的完整收益记录尚未接入')
  const selectedIds = new Set(selectedAccounts.map(account => account[0]))
  if (selectedAccounts.some(account => account[3] === '手动') || [...current, ...(opening?.investmentPositions ?? []), ...(closing?.investmentPositions ?? [])].some(position => selectedIds.has(position[3]) && position[0].startsWith('manual-'))) reasons.push('手动资料缺少完整期间变动记录')
  if (spot.some(row => row.amount === null || row.partial)) reasons.push('部分资产的期间盈亏尚不能核对')
  if (valued.missing.length) reasons.push('部分费用或奖励缺少历史换算价')
  const identities = new Set<string>()
  for (const account of selectedAccounts) {
    const before = opening?.investmentAccounts?.find(row => row[0] === account[0]), after = closing?.investmentAccounts?.find(row => row[0] === account[0])
    if (!before || !after || before[1] !== after[1] || before[4] !== 'ok' || after[4] !== 'ok') reasons.push('期初或期末账户范围未核对完整')
    if (!account[1].startsWith('live-')) continue
    const connectionId = account[1].slice(5)
    if (identities.has(connectionId)) continue
    identities.add(connectionId)
    const scopes = state.syncs.filter(scope => scope.connectionId === connectionId)
    const required = ['deposits', 'withdrawals', 'income', 'income:other', 'rewards:spot', 'coverage:spot', 'coverage:usdm']
    if (required.some(key => !scopes.some(scope => scope.key === key && scope.status === 'ok' && (scope.coverage?.from ?? scope.from) <= filter.start && (scope.coverage?.to ?? scope.to) >= filter.end))) reasons.push('已保存流水尚未覆盖整个对比期间')
    const relevant = scopes.filter(scope => /^(?:spot|usdm):/.test(scope.key))
    if (relevant.some(scope => scope.status !== 'ok' || (scope.coverage?.from ?? scope.from) > filter.start || (scope.coverage?.to ?? scope.to) < filter.end)) reasons.push('部分成交记录尚未覆盖整个期间')
    if (scopes.some(scope => scope.key.startsWith('usdm:') && scope.identity !== scopes.find(item => item.key === 'income:other')?.identity)) reasons.push('期间账户身份不一致')
  }
  const rows = state.records.filter(row => (!filter.source || 'live-' + row.connectionId === filter.source) && !row.scope.startsWith('wallet:') && row.time >= filter.start && row.time <= filter.end && ['已完成', '已记录'].includes(row.status))
  if (rows.some(row => ['买入', '卖出'].includes(row.type) && ['spot', 'usdm'].includes(row.scope) && !state.syncs.some(scope => scope.connectionId === row.connectionId && scope.identity === row.identity && scope.key === row.scope + ':' + row.symbol && scope.status === 'ok' && (scope.coverage?.from ?? scope.from) <= filter.start && (scope.coverage?.to ?? scope.to) >= filter.end))) reasons.push('部分品种缺少完整成交范围')
  if (rows.some(row => row.type === '其他收支' || row.scope === 'usdm' && ['买入', '卖出'].includes(row.type) && row.realizedPnl === null)) reasons.push('存在尚未纳入收益计算的收支')
  const complete = reasons.length === 0
  const comparable = complete ? net ?? '0' : null
  let rate: string | null = null, rateReason = '缺少可核对的净收益或期初本金'
  if (complete && opening) {
    const price = periodQuote(opening, filter.unit)
    const balances = selectedAccounts.map(account => opening.accounts.find(row => row[0] === account[0])?.[1])
    const principal = price && balances.every(value => value !== undefined) ? balances.reduce<Decimal>((total, value) => total.plus(value!), new Money(0)).div(100).div(price) : null
    // shortcut: 有资金进出的收益率需按投入时长加权；完整现金流计价接入前只算无外部进出的期间。
    if (rows.some(row => ['充值', '提现', '收到', '转出'].includes(row.type))) rateReason = '期间有资金进出，收益率暂不计算'
    else if (principal?.gt(0)) { rate = new Money(comparable!).div(principal).mul(100).toFixed(); rateReason = '' }
  }
  return { net: comparable ?? net, comparable, rate, rateReason, reasons: [...new Set(reasons)], native, valued, spot, spotStart: window.start === filter.start ? null : window.start }
}

export function periodDateLabel(bounds: Bounds) {
  const format = (time: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time))
  return format(bounds.start) + ' — ' + format(bounds.end)
}

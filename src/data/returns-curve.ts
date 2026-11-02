import type { EquityPoint } from './equity-history.ts'
import type { ReturnEntry } from './returns-analysis.ts'
import type { PeriodFilter } from './returns-period.ts'
import type { TransactionState } from './transactions.ts'
import { periodOverview } from './returns-comparison.ts'

const DAY = 86400000
type Account = NonNullable<EquityPoint['investmentAccounts']>[number]
export type ReturnCurvePoint = { day: number; time: number; amount: string | null }
export type ReturnCurve = { days: number; points: ReturnCurvePoint[] }
export type ReturnCurves = { current: ReturnCurve; previous: ReturnCurve | null }

export function returnCurveDays(start: number, end: number) {
  return Math.max(1, Math.floor((end + 8 * 3600000) / DAY) - Math.floor((start + 8 * 3600000) / DAY) + 1)
}

export function periodReturnCurve(state: TransactionState, points: readonly EquityPoint[], filter: PeriodFilter, accounts: Account[], entries: ReturnEntry[]): ReturnCurve {
  const days = returnCurveDays(filter.start, filter.end), daily = new Map<number, EquityPoint>()
  // 与现货、股票统一：范围内最早的一份快照就是起算点，起点之前没有记录时不倒推。
  const opening = points.find(point => point.investmentPositions && point.investmentAccounts && point.t * 1000 >= filter.start && point.t * 1000 <= filter.end)
  if (!opening?.investmentPositions || !opening.investmentAccounts) return { days, points: [...new Set([1, days])].map(day => ({ day, time: Math.min(filter.start + day * DAY - 1, filter.end), amount: null })) }
  for (const point of points) {
    const time = point.t * 1000
    if (time <= filter.start || time > filter.end) continue
    const day = returnCurveDays(filter.start, time)
    const previous = daily.get(day)
    if (!previous || previous.t < point.t) daily.set(day, point)
  }
  const curve: ReturnCurvePoint[] = []
  // 用空点分隔缺日，避免把没有记录的时段连接成一条收益曲线。
  for (const day of [...new Set([1, ...daily.keys(), days])].sort((a, b) => a - b)) {
    const before = curve.at(-1)
    if (before && day > before.day + 1) curve.push({ day: before.day + 1, time: filter.start + (before.day + 1) * DAY - 1, amount: null })
    const point = daily.get(day), time = day === days ? filter.end : point ? point.t * 1000 : filter.start + day * DAY - 1
    const amount = point?.investmentPositions && point.investmentAccounts ? periodOverview(state, points, { ...filter, end: time }, point.investmentPositions, accounts, entries).net : null
    curve.push({ day, time, amount })
  }
  return { days, points: curve }
}

export function returnCurveEnd(curve: ReturnCurve, time: number, amount: string | null): ReturnCurve {
  return { ...curve, points: curve.points.map(point => point.day === curve.days ? { ...point, time, amount } : point) }
}

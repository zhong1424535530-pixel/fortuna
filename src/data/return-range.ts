import type { Period } from './portfolio.ts'

export type ReturnRange = { period: Period | '全部时间' } | { period: '自定义'; start: string; end: string }

export function calendarToday(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now)
}

export function returnRangeLabel(range: ReturnRange): string {
  return range.period === '自定义' ? `${range.start} 至 ${range.end}` : range.period === '全部时间' ? '全部' : `近${range.period}`
}

export function returnRangeDates(range: ReturnRange, now = new Date()): { start: string; end: string } {
  if (range.period === '自定义') return { start: range.start, end: range.end }
  if (range.period === '全部时间') return { start: '', end: '' }
  const days = range.period === '1天' ? 1 : range.period === '7天' ? 7 : range.period === '30天' ? 30 : 365
  return { start: calendarToday(new Date(now.getTime() - (days - 1) * 86400000)), end: calendarToday(now) }
}

export function validateReturnDates(start: string, end: string, today = calendarToday()): string {
  if (!start || !end) return '请选择开始日期和结束日期。'
  for (const value of [start, end]) {
    const date = new Date(value + 'T00:00:00Z')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return '日期无效，请重新选择。'
  }
  if (start > end) return '开始日期不能晚于结束日期。'
  if (end > today) return '不能选择未来日期。'
  return ''
}

export function shiftCalendarMonth(month: string, step: number): string {
  const date = new Date(month + '-01T00:00:00Z')
  date.setUTCMonth(date.getUTCMonth() + step)
  return date.toISOString().slice(0, 7)
}

export function calendarMonthGrid(month: string): string[] {
  const first = new Date(month + '-01T00:00:00Z')
  const offset = (first.getUTCDay() + 6) % 7
  const next = new Date(first)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const length = Math.round((next.getTime() - first.getTime()) / 86400000)
  return Array.from({ length: Math.ceil((offset + length) / 7) * 7 }, (_, index) => new Date(first.getTime() + (index - offset) * 86400000).toISOString().slice(0, 10))
}

export function selectRangeDate(start: string, end: string, date: string): { start: string; end: string } {
  if (!start || end) return { start: date, end: '' }
  return date < start ? { start: date, end: start } : { start, end: date }
}

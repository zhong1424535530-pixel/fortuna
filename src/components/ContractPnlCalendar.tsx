import { t } from '../i18n'
import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Decimal } from 'decimal.js'
import type { ContractRound } from '../data/contract-history'
import { calendarMonthGrid, calendarToday, shiftCalendarMonth } from '../data/return-range'
import { closedReturnCalendarDays } from '../data/returns-analysis'
import { Panel, Unavailable } from './ui'

const Money = Decimal.clone({ precision: 80 })
// compact：格子里 1000 以上不显示小数，手机宽度才放得下；完整金额仍在悬停提示和读屏标签里。
function dayAmount(amount: string, compact = false) {
  const value = new Money(amount)
  if (!value.isZero() && value.abs().lt('0.005')) return (value.isNegative() ? '−' : '+') + '<0.01'
  const rounded = value.toDecimalPlaces(compact && value.abs().gte(1000) ? 0 : 2)
  return (rounded.gt(0) ? '+' : '') + rounded.toFixed(compact && rounded.abs().gte(1000) ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default function ContractPnlCalendar({ rounds, start, end, unit, hidden, selected, onSelect }: {
  rounds: ContractRound[]; start: number; end: number; unit: string; hidden: boolean; selected: string; onSelect: (date: string) => void
}) {
  const today = calendarToday(), lastDay = calendarToday(new Date(end))
  const days = closedReturnCalendarDays(rounds)
  const firstDay = start ? calendarToday(new Date(start)) : days[0]?.date ?? lastDay
  const [month, setMonth] = useState(lastDay.slice(0, 7))
  const byDate = new Map(days.map(day => [day.date, day]))
  const dates = calendarMonthGrid(month)
  function changeMonth(step: number) { setMonth(shiftCalendarMonth(month, step)); onSelect('') }
  return <Panel className="returns-pnl-calendar" title={t('每日合约盈亏')} subtitle={unit} action={<div className="returns-calendar-nav">
    <button type="button" aria-label={t('上个月')} disabled={month <= firstDay.slice(0, 7)} onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
    <span aria-live="polite">{Number(month.slice(0, 4))}{t('年')}{Number(month.slice(5))}{t('月')}</span>
    <button type="button" aria-label={t('下个月')} disabled={month >= lastDay.slice(0, 7)} onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
  </div>}>
    <div className="records-panel-body">
      <div className="returns-calendar-weekdays" aria-hidden>{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="returns-calendar-days" role="group" aria-label={t('选择平仓日期，筛选下方逐笔复盘')}>{dates.map(date => {
        const day = byDate.get(date)
        const disabled = !date.startsWith(month) || date < firstDay || date > lastDay || date > today
        const amount = !day ? '—' : hidden ? '••••' : day.amount === null ? <Unavailable reason={`${day.pending}轮交易缺少完整成交、手续费或资金费资料，暂不显示完整当日净收益。`} /> : dayAmount(day.amount, true)
        const tone = hidden || !day || day.amount === null || new Money(day.amount).isZero() ? '' : new Money(day.amount).gt(0) ? 'positive' : 'negative'
        const note = !day ? '无已记录平仓' : `${day.count}轮平仓${day.pending ? `，${day.pending}轮资料待核对` : ''}`
        const label = `${date}，${note}${day && !hidden && day.amount !== null ? `，净收益 ${dayAmount(day.amount)} ${unit}` : ''}`
        return <button type="button" key={date} disabled={disabled} className={`returns-calendar-day ${tone}${selected === date ? ' is-selected' : ''}`} aria-pressed={selected === date} aria-current={date === today ? 'date' : undefined} aria-label={label} title={label} onClick={() => onSelect(selected === date ? '' : date)}>
          <span className={date === today ? 'is-today' : ''}>{Number(date.slice(8))}</span><strong>{disabled ? '' : amount}</strong>
        </button>
      })}</div>
      {selected && <div className="returns-calendar-footer"><span>{t('已选')} {selected}</span><button type="button" className="returns-inline-button" onClick={() => onSelect('')}>{t('清除日期')}</button></div>}
    </div>
  </Panel>
}

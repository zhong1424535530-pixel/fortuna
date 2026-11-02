import { t } from '../i18n'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { calendarMonthGrid, shiftCalendarMonth } from '../data/return-range'

export default function RangeCalendar({ start, end, today, onSelect }: { start: string; end: string; today: string; onSelect: (date: string) => void }) {
  const initial = end || start || today
  const [month, setMonth] = useState(initial.slice(0, 7))
  const [focused, setFocused] = useState(initial)
  const [picker, setPicker] = useState<'days' | 'years' | 'months'>('days')
  const [yearPage, setYearPage] = useState(Math.floor((Number(initial.slice(0, 4)) - 1) / 12) * 12 + 1)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<string | null>(null)
  const dates = useMemo(() => calendarMonthGrid(month), [month])
  const year = Number(month.slice(0, 4)), currentYear = Number(today.slice(0, 4))
  const weekdays = ['一', '二', '三', '四', '五', '六', '日']

  useLayoutEffect(() => {
    if (picker === 'days' && pendingFocus.current) {
      buttons.current.get(pendingFocus.current)?.focus()
      pendingFocus.current = null
    }
  }, [month, focused, picker])

  function changeMonth(next: string, focus = false) {
    const bounded = next < '0001-01' ? '0001-01' : next > today.slice(0, 7) ? today.slice(0, 7) : next
    const date = bounded + '-01'
    setMonth(bounded); setFocused(date)
    if (focus) pendingFocus.current = date
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const current = new Date(date + 'T00:00:00Z')
    const weekday = (current.getUTCDay() + 6) % 7
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }
    let target: string
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      const nextMonth = shiftCalendarMonth(date.slice(0, 7), event.key === 'PageUp' ? -1 : 1)
      if (nextMonth < '0001-01' || nextMonth > today.slice(0, 7)) return
      const days = calendarMonthGrid(nextMonth).filter(day => day.startsWith(nextMonth))
      target = nextMonth + '-' + String(Math.min(Number(date.slice(8)), days.length)).padStart(2, '0')
    } else if (event.key in moves) target = new Date(current.getTime() + moves[event.key] * 86400000).toISOString().slice(0, 10)
    else return
    event.preventDefault()
    if (target < '0001-01-01' || target > today) return
    pendingFocus.current = target
    setMonth(target.slice(0, 7)); setFocused(target)
  }

  const previous = () => picker === 'years' ? setYearPage(Math.max(1, yearPage - 12)) : changeMonth(shiftCalendarMonth(month, -1))
  const next = () => picker === 'years' ? setYearPage(yearPage + 12) : changeMonth(shiftCalendarMonth(month, 1))

  return <div className="range-calendar">
    <div className="calendar-heading">
      <button type="button" className="calendar-nav" aria-label={picker === 'years' ? '更早的年份' : '上个月'} disabled={picker === 'years' ? yearPage <= 1 : month <= '0001-01'} onClick={previous}><ChevronLeft size={15} /></button>
      <div><button type="button" aria-label={t('选择年份')} onClick={() => { setYearPage(Math.floor((year - 1) / 12) * 12 + 1); setPicker(picker === 'years' ? 'days' : 'years') }}>{picker === 'years' ? `${yearPage}—${Math.min(yearPage + 11, currentYear)}` : `${year}年`}</button><button type="button" aria-label={t('选择月份')} onClick={() => setPicker(picker === 'months' ? 'days' : 'months')}>{Number(month.slice(5))}{t('月')}</button></div>
      <button type="button" className="calendar-nav" aria-label={picker === 'years' ? '更晚的年份' : '下个月'} disabled={picker === 'years' ? yearPage + 12 > currentYear : month >= today.slice(0, 7)} onClick={next}><ChevronRight size={15} /></button>
    </div>
    {picker === 'years' ? <div className="calendar-choices" aria-label={t('年份')}>{Array.from({ length: 12 }, (_, index) => yearPage + index).map(item => <button type="button" key={item} disabled={item > currentYear} aria-pressed={item === year} onClick={() => { changeMonth(String(item).padStart(4, '0') + month.slice(4), true); setPicker('days') }}>{item}{t('年')}</button>)}</div>
      : picker === 'months' ? <div className="calendar-choices" aria-label={t('月份')}>{Array.from({ length: 12 }, (_, index) => index + 1).map(item => <button type="button" key={item} disabled={year === currentYear && item > Number(today.slice(5, 7))} aria-pressed={item === Number(month.slice(5))} onClick={() => { changeMonth(month.slice(0, 5) + String(item).padStart(2, '0'), true); setPicker('days') }}>{item}{t('月')}</button>)}</div>
        : <div className="calendar-grid" role="grid" aria-label={`${year}年${Number(month.slice(5))}月`}>
          <div role="row" className="calendar-weekdays">{weekdays.map(day => <span key={day} role="columnheader">{day}</span>)}</div>
          {Array.from({ length: dates.length / 7 }, (_, week) => <div role="row" key={week}>{dates.slice(week * 7, week * 7 + 7).map(date => {
            const edge = date === start || date === end
            const inside = Boolean(start && end && date > start && date < end)
            return <button type="button" role="gridcell" key={date} ref={node => { if (node) buttons.current.set(date, node); else buttons.current.delete(date) }} className={`calendar-day${date.startsWith(month) ? '' : ' adjacent'}${edge ? ' endpoint' : ''}${inside ? ' in-range' : ''}${date === today ? ' today' : ''}`} disabled={date > today || date < '0001-01-01'} tabIndex={date === focused ? 0 : -1} aria-selected={edge || inside} aria-current={date === today ? 'date' : undefined} aria-label={`${date}${date === start ? '，开始日期' : date === end ? '，结束日期' : ''}`} onFocus={() => setFocused(date)} onKeyDown={event => keyDown(event, date)} onClick={() => onSelect(date)}>{Number(date.slice(8))}</button>
          })}</div>)}
        </div>}
  </div>
}

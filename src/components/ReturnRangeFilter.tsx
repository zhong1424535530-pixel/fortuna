import { t } from '../i18n'
import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CalendarDays, ChevronDown } from 'lucide-react'
import { Button } from './ui'
import RangeCalendar from './RangeCalendar'
import { periods } from '../data/portfolio'
import { calendarToday, returnRangeLabel, selectRangeDate, validateReturnDates } from '../data/return-range'
import type { ReturnRange } from '../data/return-range'

export default function ReturnRangeFilter({ value, onChange, title = '资产走势时间范围' }: { value: ReturnRange; onChange: (range: ReturnRange) => void; title?: string }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState('')
  const [anchor, setAnchor] = useState({ left: 16, top: 80, width: 248 })
  const trigger = useRef<HTMLButtonElement>(null)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const label = returnRangeLabel(value)
  // 手机上同一年的自定义范围省掉年份，让日期按钮能和其他筛选并排。
  const shortLabel = value.period === '自定义' && value.start.slice(0, 4) === value.end.slice(0, 4) ? `${value.start.slice(5)} 至 ${value.end.slice(5)}` : ''
  const presets = [...periods, '全部时间'] as const

  function changeOpen(next: boolean) {
    if (next) {
      setCustom(value.period === '自定义')
      setStart(value.period === '自定义' ? value.start : '')
      setEnd(value.period === '自定义' ? value.end : '')
      setError('')
    }
    setOpen(next)
  }

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(custom ? 320 : 248, window.innerWidth - 24)
      const height = Math.min(custom ? 462 : 96, window.innerHeight - 24)
      setAnchor({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.bottom + 7, window.innerHeight - height - 12)), width })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, custom])

  function applyCustom() {
    const problem = validateReturnDates(start, end)
    setError(problem)
    if (problem) return
    onChange({ period: '自定义', start, end })
    setOpen(false)
  }

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button type="button" ref={trigger} className="return-range-trigger" aria-label={`${title}：${label}`}><CalendarDays size={14} /><span className={shortLabel ? 'range-label-full' : undefined}>{label}</span>{shortLabel && <span className="range-label-short">{shortLabel}</span>}<ChevronDown size={13} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="source-picker-overlay return-range-overlay" />
      <Dialog.Content className="source-picker-dialog return-range-picker" aria-describedby={undefined} style={{ '--source-picker-left': `${anchor.left}px`, '--source-picker-top': `${anchor.top}px`, '--return-range-width': `${anchor.width}px` } as CSSProperties} onOpenAutoFocus={event => { event.preventDefault(); selectedButton.current?.focus() }}>
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        <div className="return-range-presets">{presets.map(period => <Dialog.Close asChild key={period}><button type="button" ref={value.period === period ? selectedButton : undefined} className="return-range-option" aria-pressed={!custom && value.period === period} onClick={() => onChange({ period })}>{period === '全部时间' ? '全部' : `近${period}`}</button></Dialog.Close>)}<button type="button" ref={value.period === '自定义' ? selectedButton : undefined} className="return-range-option" aria-pressed={custom} onClick={() => { setCustom(current => !current); setError('') }}>{t('自定义')}</button></div>
        {custom && <div className="return-range-custom">
          <div className="return-range-selection"><span aria-label={`开始日期：${start || '未选择'}`}>{start || '开始日期'}</span><span className="range-separator">—</span><span aria-label={`结束日期：${end || '未选择'}`}>{end || '结束日期'}</span></div>
          <RangeCalendar start={start} end={end} today={calendarToday()} onSelect={date => { const range = selectRangeDate(start, end, date); setStart(range.start); setEnd(range.end); setError('') }} />
          {error && <p className="return-range-error" role="alert">{error}</p>}
          <div className="return-range-actions"><Dialog.Close asChild><Button>{t('取消')}</Button></Dialog.Close><Button variant="primary" onClick={applyCustom}>{t('应用')}</Button></div>
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

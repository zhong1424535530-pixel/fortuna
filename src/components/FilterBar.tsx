import { t } from '../i18n'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RotateCcw, Search, X } from 'lucide-react'
import { Button } from './ui'
import '../filter-bar.css'

// 所有页面的筛选栏统一用这里：标签在上、控件在下、同一高度；电脑端一行排开，手机两列。
export function FilterBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={('filter-bar ' + className).trim()}>{children}</div>
}

export function FilterField({ label, children, wide, fit }: { label: string; children: ReactNode; wide?: boolean; fit?: boolean }) {
  return <div className={'filter-field' + (wide ? ' wide' : '') + (fit ? ' fit' : '')}><span className="filter-label">{label}</span>{children}</div>
}

// 搜索框：筛选栏里和卡片工具栏里共用同一套样式。
export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <label className="search-field"><Search size={15} aria-hidden />
    <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    {value && <button type="button" aria-label={t('清空搜索')} onClick={() => onChange('')}><X size={14} /></button>}
  </label>
}

// 清除筛选：永远占一个固定的圆形位置，没有筛选时变灰不可点，这样筛选栏里别的控件宽度不会跳。
export function ClearFilters({ onClick, active }: { onClick: () => void; active: boolean }) {
  return <Button className="filter-clear" disabled={!active} aria-label={t('清除筛选')} title={t('清除筛选')} onClick={onClick}><RotateCcw size={16} aria-hidden /></Button>
}

// 分段控件：白色滑块在选项之间滑动。滑块位置按选中按钮实测，所以各项宽度不同也对得齐。
export function Segmented<T extends string>({ options, value, onChange, label, format }: { options: readonly T[]; value: T; onChange: (value: T) => void; label: string; format?: (value: T) => string }) {
  const root = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const move = () => { const el = root.current?.querySelector<HTMLElement>('[aria-pressed="true"]'); if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth }) }
    move()
    const watcher = new ResizeObserver(move)
    if (root.current) watcher.observe(root.current)
    return () => watcher.disconnect()
  }, [value, options.length])
  return <div ref={root} className="category-tabs" role="group" aria-label={label}>
    {thumb && <span className="segmented-thumb" aria-hidden style={{ left: thumb.left, width: thumb.width }} />}
    {options.map(item => <button type="button" key={item} className={value === item ? 'active' : ''} aria-pressed={value === item} onClick={() => onChange(item)}>{format ? format(item) : item}</button>)}
  </div>
}

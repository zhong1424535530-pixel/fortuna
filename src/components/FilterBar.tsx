import { t } from '../i18n'
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

export function ClearFilters({ onClick }: { onClick: () => void }) {
  return <Button className="filter-clear" aria-label={t('清除筛选')} onClick={onClick}><RotateCcw size={14} aria-hidden /><span>{t('清除筛选')}</span></Button>
}

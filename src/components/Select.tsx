import { t } from '../i18n'
import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronDown, Layers3, Search, X } from 'lucide-react'
import { Avatar } from './ui'
import '../select.css'

export type SelectOption = { value: string; label: string; icon?: ReactNode; description?: string; group?: string; keywords?: string; trailing?: ReactNode }
export const currencyOptions: SelectOption[] = [
  { value: 'USD', label: '美元 USD', icon: <span className="select-currency-icon">$</span> },
  { value: 'CNY', label: '人民币 CNY', icon: <span className="select-currency-icon">¥</span> },
]

function OptionIcon({ option }: { option?: SelectOption }) {
  return <span className="select-icon" aria-hidden>{typeof option?.icon === 'string' ? <Avatar src={option.icon} name={option.label} size={22} /> : option?.icon || <Layers3 size={18} />}</span>
}

export default function Select({ value, onChange, options, label, disabled = false, searchable = false, compact = false }: { value: string; onChange: (value: string) => void; options: readonly SelectOption[]; label: string; disabled?: boolean; searchable?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [anchor, setAnchor] = useState({ left: 16, top: 80, width: 300, maxHeight: 360 })
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const selected = options.find(option => option.value === value)
  const term = query.trim().toLocaleLowerCase()
  const visible = options.filter(option => !term || `${option.label} ${option.description ?? ''} ${option.group ?? ''} ${option.keywords ?? ''}`.toLocaleLowerCase().includes(term))
  const groups = [...new Set(visible.map(option => option.group ?? ''))]

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 300), 360, window.innerWidth - 32)
      const below = window.innerHeight - rect.bottom - 24, above = rect.top - 24
      const upwards = below < 220 && above > below
      const height = Math.min(400, Math.max(80, upwards ? above : below))
      setAnchor({ left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), top: upwards ? Math.max(16, rect.top - height - 8) : rect.bottom + 8, width, maxHeight: height })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open])

  function navigate(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (event.target === search.current && ['Home', 'End'].includes(event.key)) return
    const buttons = Array.from(content.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    if (!buttons.length) return
    event.preventDefault()
    const index = buttons.findIndex(button => button === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? event.key === 'ArrowUp' ? buttons.length - 1 : 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus()
  }

  return <Dialog.Root open={open} onOpenChange={next => { setOpen(next); if (!next) setQuery('') }}>
    <Dialog.Trigger asChild><button type="button" ref={trigger} disabled={disabled} className={`app-select${compact ? ' app-select-compact' : ''}`} aria-label={`${t(label)}${t('，当前为')}${t(selected?.label ?? '请选择')}`} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}><OptionIcon option={selected} /><span>{selected?.label ?? '请选择'}</span><ChevronDown size={14} aria-hidden /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="select-overlay" />
      <Dialog.Content ref={content} className="select-menu" style={anchor} aria-describedby={undefined} onKeyDown={navigate} onOpenAutoFocus={event => { event.preventDefault(); (search.current ?? content.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? content.current?.querySelector<HTMLButtonElement>('[role="option"]') ?? content.current)?.focus() }}>
        <div className="select-heading"><Dialog.Title>{label}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label={t('关闭选择')}><X size={16} /></button></Dialog.Close></div>
        {searchable && <div className="select-search"><Search size={14} aria-hidden /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} aria-label={`搜索${label}`} placeholder={t('搜索')} /></div>}
        <div className="select-options" role="listbox" aria-label={label}>{groups.map(group => <div key={group} role="group" aria-label={group || label}>{group && <div className="select-group">{group}</div>}{visible.filter(option => (option.group ?? '') === group).map(option => <button type="button" role="option" aria-selected={option.value === value} key={option.value} className="select-option" onClick={() => { if (trigger.current?.matches(':disabled')) return; onChange(option.value); setOpen(false); setQuery('') }}><OptionIcon option={option} /><span className="select-option-label"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>{option.trailing && <span className="select-option-trailing">{option.trailing}</span>}{option.value === value && <Check size={15} className="select-check" aria-hidden />}</button>)}</div>)}{!visible.length && <p className="select-empty">{t('没有匹配的选项')}</p>}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

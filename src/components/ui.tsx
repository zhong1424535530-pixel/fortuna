import { t } from '../i18n'
import { useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { motion } from 'motion/react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUpRight, EyeOff, X } from 'lucide-react'
import { formatSignedMoney } from '../data/portfolio'
import type { Currency } from '../data/portfolio'
import { Unavailable } from './IssueHint'
export { IssueHint, Unavailable } from './IssueHint'

export function Modal({ open, onClose, title, description, children, className = '' }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; className?: string }) {
  const opener = useRef<HTMLElement | null>(null)
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className={`dialog-content ${className}`} onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }} onCloseAutoFocus={event => { event.preventDefault(); (opener.current?.isConnected && opener.current !== document.body ? opener.current : document.getElementById('page-heading'))?.focus({ preventScroll: true }) }}>
      <div className="dialog-heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description className={description ? undefined : 'sr-only'}>{description ?? title}</Dialog.Description></div><Dialog.Close asChild><Button variant="ghost" className="icon-button" aria-label={t('关闭弹窗')}><X size={19} /></Button></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

export function SignedAmount({ value, currency, hidden }: { value: number | null; currency: Currency; hidden: boolean }) {
  if (value === null) return <Unavailable hidden={hidden} reason={t('缺少有效报价或完整盈亏记录，暂时无法计算这一项金额。')} />
  return <span className={`numeric ${hidden || value === 0 ? 'muted' : value < 0 ? 'negative' : 'positive'}`}>{formatSignedMoney(value, currency, hidden)}</span>
}

export function Button({ className = '', variant = 'secondary', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button type="button" className={`button button-${variant} ${className}`} {...props}>{children}</button>
}

export function Panel({ title, subtitle, action, children, className = '', delay = 0 }: { title?: ReactNode; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  return <motion.section className={`panel ${className}`} initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: .05 }} transition={{ duration: .3, delay }}>
    {title && <div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>}
    {children}
  </motion.section>
}

export function Avatar({ src, name, size = 30, company = false }: { src?: string; name: string; size?: number; company?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string>()
  // 自动图标地址可带 fb 参数：图库查不到时改用它指定的占位图。
  const fallback = src?.startsWith('/api/asset-icon?') ? new URLSearchParams(src.slice(src.indexOf('?') + 1)).get('fb') : null
  return <span className={`asset-avatar ${company ? 'company-avatar' : ''}`} style={{ width: size, height: size }}>
    {src && src !== failedSrc ? <img src={src} alt={`${name}图标`} onError={() => setFailedSrc(src)} loading="lazy" /> : fallback ? <img src={fallback} alt={`${name}图标`} /> : <span aria-label={`${name}图标占位`}>{t(name).slice(0, size < 28 ? 1 : 2).toUpperCase()}</span>}
  </span>
}

export function Trend({ value, hidden = false }: { value: number; hidden?: boolean }) {
  return <span className={`trend ${value < 0 ? 'negative' : 'positive'}`}>{hidden ? '—' : <>{value >= 0 ? '+' : ''}{value.toFixed(2)}%<ArrowUpRight size={13} aria-hidden className={value < 0 ? 'rotate-90' : ''} /></>}</span>
}

export function Sparkline({ negative = false, color = '#9fffd2', seed = 0 }: { negative?: boolean; color?: string; seed?: number }) {
  const heights = [24, 20, 23, 15, 17, 11, 15, 8, 12, 6, 7, 3]
  const points = heights.map((y, index) => `${index * 7},${negative ? 30 - y : y + (index % 3 === seed % 3 ? 3 : 0)}`).join(' ')
  return <svg width="82" height="32" viewBox="0 0 82 34" fill="none" aria-hidden className="sparkline"><polyline points={points} stroke={negative ? '#ce8e8e' : color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export function HiddenChart({ className = '' }: { className?: string }) {
  return <div className={`hidden-chart ${className}`}><EyeOff size={20} /><span>{t('金额已隐藏')}</span></div>
}

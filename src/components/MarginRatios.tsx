import { t } from '../i18n'
import { useState } from 'react'
import { Expand } from 'lucide-react'
import { Decimal } from 'decimal.js'
import { Modal, Unavailable } from './ui'
import { marginRatio, marginRows } from '../data/margin-risk'
import type { LiveAccount, LiveContract } from '../data/live-types'

function MarginGauge({ percent, exhausted }: { percent: number | null; exhausted: boolean }) {
  const known = percent !== null || exhausted
  const angle = Math.PI * (1 - Math.min(100, Math.max(0, exhausted ? 100 : percent ?? 0)) / 100)
  return <svg className={`margin-gauge${known ? '' : ' is-unknown'}`} viewBox="0 0 48 32" aria-hidden="true">
    <path className="gauge-green" d="M 6 26 A 18 18 0 0 1 15 10.4" />
    <path className="gauge-yellow" d="M 17 9.4 A 18 18 0 0 1 31 9.4" />
    <path className="gauge-red" d="M 33 10.4 A 18 18 0 0 1 42 26" />
    {known && <line x1="24" y1="26" x2={24 + Math.cos(angle) * 12} y2={26 - Math.sin(angle) * 12} />}
    <circle cx="24" cy="26" r="3" />
  </svg>
}

export default function MarginRatios({ accounts, contracts, selectedIds, hidden }: { accounts: readonly LiveAccount[]; contracts: readonly LiveContract[]; selectedIds?: readonly string[]; hidden: boolean }) {
  const [open, setOpen] = useState(false)
  const rows = marginRows(accounts, contracts, selectedIds)
  const format = (value: string | null, asset: string) => hidden ? '••••••' : value === null ? <Unavailable reason={t('平台尚未提供此账户的完整保证金资料。')} /> : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(new Decimal(value).toNumber())} ${asset}`
  const renderRow = (row: ReturnType<typeof marginRows>[number]) => {
        const stale = row.status === 'error' || row.status === 'pending' || !row.updatedAt || !Number.isFinite(Date.parse(row.updatedAt)) || Date.now() - Date.parse(row.updatedAt) > 180000
        const { percent, exhausted } = hidden || stale ? { percent: null, exhausted: false } : marginRatio(row)
        const label = hidden ? '••••••' : stale ? <Unavailable reason={t('保证金资料尚未成功读取或已过期，暂不展示比率。')} /> : exhausted ? '余额不足' : percent === null ? <Unavailable reason={t('缺少维持保证金或保证金余额，无法计算比率。')} /> : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(percent)}%`
        return <div className="margin-ratio-row" key={row.key}>
          <div className="margin-ratio-header"><span className="margin-ratio-name"><strong title={row.accountName}>{row.accountName}</strong><small>{row.label}</small></span><span className="margin-ratio-reading"><MarginGauge percent={percent} exhausted={exhausted} /><strong className={`numeric${exhausted || percent !== null && percent >= 100 ? ' negative' : ''}`}>{label}</strong></span></div>
          <dl><div><dt>{t('维持保证金')}</dt><dd className="numeric">{format(row.maintenance, row.asset)}</dd></div><div><dt>{t('保证金余额')}</dt><dd className="numeric">{format(row.balance, row.asset)}</dd></div></dl>
        </div>
  }
  return <section className="margin-ratios" aria-label={t('账户保证金比率')}>
    <div className="margin-ratios-heading"><h2>{t('保证金比率')}</h2><span>{hidden ? '—' : `${rows.length} 项`}</span></div>
    <div className="margin-ratios-list">
      {rows.slice(0, 1).map(renderRow)}
      {!rows.length && <div className="margin-ratios-empty">{t('所选账户暂无合约持仓')}</div>}
    </div>
    {rows.length > 1 && <button type="button" className="margin-ratios-more" onClick={() => setOpen(true)} aria-haspopup="dialog">{t('查看全部')}<Expand size={12} /></button>}
    {open && <Modal open onClose={() => setOpen(false)} title={t('全部保证金比率')} className="margin-ratios-dialog"><div className="margin-ratios-dialog-list">{rows.map(renderRow)}{!rows.length && <div className="margin-ratios-empty">{t('所选账户暂无合约持仓')}</div>}</div></Modal>}
  </section>
}

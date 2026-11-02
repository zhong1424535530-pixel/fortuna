import { t } from '../i18n'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ContractRound } from '../data/contract-history'
import type { Connection } from '../data/live-types'
import { feesInUsdt, summarizeTransactions, summaryAmount, summarizeCashflow } from '../data/transaction-summary'
import type { FeePrice, SummaryAmount } from '../data/transaction-summary'
import type { TransactionFilters, TransactionState } from '../data/transactions'

import { IssueHint, Unavailable } from './ui'

type AmountGroup = { label: string; amounts: SummaryAmount[] }

function SummaryCard({ title, groups, extra = [], extraTitle = '', hidden, signed = false, children, issue }: { title: string; groups: AmountGroup[]; extra?: AmountGroup[]; extraTitle?: string; hidden: boolean; signed?: boolean; children?: ReactNode; issue?: string }) {
  const rows = groups.flatMap(group => group.amounts.map(amount => ({ ...amount, label: group.label })))
  const line = (row: SummaryAmount & { label: string }) => {
    const display = summaryAmount(row.quantity, signed)
    const tone = !hidden && (signed || title === '奖励') && display !== '0.00' ? display.startsWith('-') ? 'negative' : 'positive' : ''
    return <div className="transaction-summary-amount" key={row.label + ':' + row.key}>
      {row.label && <span>{row.label}</span>}
      <strong className={`numeric ${tone}`} title={hidden ? undefined : `${display} ${row.asset}${row.detail ? ' · ' + row.detail : ''}`}>
        {hidden ? '••••••' : display} <small>{row.asset}</small>
      </strong>
      {row.detail && <small className="transaction-summary-identity">{row.detail}</small>}
    </div>
  }
  // 每个收付方向先显示一种币，避免一个方向币种多时把另一个方向挤进折叠区。
  const primary = groups.length > 1 ? groups.flatMap(group => group.amounts.slice(0, 1).map(amount => ({ ...amount, label: group.label }))) : rows.slice(0, 2)
  const more = rows.filter(row => !primary.some(item => item.key === row.key && item.label === row.label))
  const extraRows = extra.flatMap(group => group.amounts.map(amount => ({ ...amount, label: group.label })))
  return <section className="transaction-summary-card" aria-label={title}>
    <h3>{title}{!hidden && issue && <IssueHint message={issue} />}</h3>
    <div className="transaction-summary-values">{primary.length ? primary.map(line) : <strong className="transaction-summary-empty">{hidden ? '••••••' : issue ? '—' : <Unavailable reason={t('所选期间没有此类已保存记录，未将缺失资料当作零。')} />}</strong>}</div>
    {children}
    {!!(more.length || extraRows.length) && <details className="transaction-summary-more"><summary>{more.length ? '更多币种' : extraTitle}</summary>
      <div>{more.map(line)}{extraRows.length > 0 && <><p>{extraTitle}</p>{extraRows.map(line)}</>}</div>
    </details>}
  </section>
}

function CashflowCard({ title, totals, hidden }: { title: string; totals: { income: string | null; expense: string | null; net: string | null; missing?: number }; hidden: boolean }) {
  const amounts: SummaryAmount[] = totals.net === null ? [] : [{ key: 'coin:tether', asset: 'USDT', quantity: totals.net, detail: '' }]
  return <SummaryCard title={title} groups={[{ label: '净收支', amounts }]} signed hidden={hidden} issue={totals.missing ? totals.net === null ? `${totals.missing}项收支缺少有效换算价或不支持折算，暂不显示完整合计。` : `${totals.missing}项非USDT/USDC收支未计入合计。` : undefined}>
    <div className="transaction-summary-breakdown">{[['收入', totals.income], ['支出', totals.expense]].map(([label, value]) => <div key={label}>
      <span>{label}</span><strong className="numeric">{hidden ? '••••••' : value === null ? <Unavailable reason={t('未取得可折算的完整收支金额。')} /> : summaryAmount(value)}{value !== null && <small> USDT</small>}</strong>
    </div>)}</div>
  </SummaryCard>
}

export default function TransactionSummary({ state, rounds, filters, connections, hidden, suppliedTotals }: { state: TransactionState; rounds: readonly ContractRound[]; filters: TransactionFilters; connections: readonly Connection[]; hidden: boolean; suppliedTotals?: ReturnType<typeof summarizeTransactions> }) {
  const totals = useMemo(() => suppliedTotals ?? summarizeTransactions(state, rounds, filters, connections), [state, rounds, filters.start, filters.end, filters.source, connections, suppliedTotals])
  const [quotes, setQuotes] = useState<FeePrice[]>([])
  const needsPrice = feesInUsdt([...totals.fees, ...totals.feeRefunds, ...totals.deposits, ...totals.received, ...totals.withdrawals, ...totals.sent], []).missing > 0
  useEffect(() => {
    if (!needsPrice) return
    let active = true, pending = false
    const controller = new AbortController()
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      if (active) setQuotes(current => current.filter(item => item.at >= Date.now() - 300000 && item.at <= Date.now() + 30000))
      if (pending) return
      pending = true
      try {
        const response = await fetch('/api/transactions/fee-prices', { headers: { 'X-Investment-App': '1' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) })
        const data = await response.json()
        if (!response.ok || !Array.isArray(data.prices) || data.prices.length > 4000 || !data.prices.every((item: FeePrice) => item && typeof item.key === 'string' && item.key.length <= 200 && typeof item.price === 'string' && item.price.length <= 100 && Number.isSafeInteger(item.at))) throw new Error()
        if (active) setQuotes(data.prices)
      } catch { if (active) setQuotes(current => [...current]) }
      finally { pending = false }
    }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 60000)
    document.addEventListener('visibilitychange', visible)
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [needsPrice])
  const fees = feesInUsdt(totals.fees, quotes), refunds = feesInUsdt(totals.feeRefunds, quotes)
  const cashflow = summarizeCashflow(totals, quotes)
  return <section className="transaction-summary" aria-label={t('本期资金汇总')}>
    <div className="transaction-summary-grid" tabIndex={0} aria-label={t('五项资金汇总')}>
      <SummaryCard title={t('平仓毛盈亏')} issue={totals.missingPnl ? `${totals.missingPnl}轮交易未提供完整平仓盈亏，合计只包含已有记录。` : undefined} groups={[{ label: '', amounts: totals.pnl }]} signed hidden={hidden} />
      <SummaryCard title={t('手续费支出')} issue={totals.missingFees || fees.missing || refunds.missing ? `${totals.missingFees}笔记录未提供完整手续费；${fees.missing + refunds.missing}项费用缺少有效换算价。` : undefined} groups={[{ label: '', amounts: fees.amounts }]} extra={[{ label: '返还', amounts: refunds.amounts }]} extraTitle="手续费返还（另列）" hidden={hidden} />
      <CashflowCard title={t('资金费')} totals={totals.funding} hidden={hidden} />
      <CashflowCard title={t('资金收付（按现价）')} totals={cashflow} hidden={hidden} />
      <SummaryCard title={t('奖励')} groups={[{ label: '', amounts: totals.rewards }]} hidden={hidden} />
    </div>
  </section>
}

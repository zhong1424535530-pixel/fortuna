import { t } from '../i18n'
import { contractAmount, roundFees } from '../data/contract-history'
import { formatPriceNumber } from '../data/portfolio'
import { feesAsUsdt } from '../data/fee-valuation'
import type { ContractRound } from '../data/contract-history'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Modal, IssueHint, Unavailable } from './ui'

const stamp = (at: number | null) => at === null ? '—' : new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const duration = (round: ContractRound) => {
  if (round.openedAt === null || round.closedAt === null) return '—'
  const minutes = Math.floor((round.closedAt - round.openedAt) / 60000)
  return minutes < 1 ? '不足1分钟' : `${minutes >= 1440 ? Math.floor(minutes / 1440) + '天 ' : ''}${minutes >= 60 ? Math.floor(minutes % 1440 / 60) + '小时 ' : ''}${minutes % 60}分钟`
}

function display(hidden: boolean) {
  const amount = (value: string | null, asset = '', places = 2) => hidden ? '••••••' : value === null ? <Unavailable reason={t('平台尚未提供此项完整成交资料。')} /> : `${contractAmount(value, places)}${asset ? ' ' + asset : ''}`
  const price = (value: string | null, asset: string) => hidden ? '••••••' : value === null ? <Unavailable reason={t('平台尚未提供此项完整成交资料。')} /> : `${formatPriceNumber(value)} ${asset}`
  const fees = (round: ContractRound) => hidden ? '••••••' : roundFees(round).length ? roundFees(round).map(fee => amount(fee.quantity, fee.asset, 8)).map((value, index) => <span key={index}>{index > 0 && ' / '}{value}</span>) : <Unavailable reason={t('本轮成交尚未提供手续费记录。')} />
  const tone = (value: string | null) => hidden || value === null || Number(value) === 0 ? '' : value.startsWith('-') ? 'negative' : 'positive'
  const metric = (label: string, value: ReactNode, className = '') => <div><dt>{label}</dt><dd className={`numeric ${className}`}>{value}</dd></div>
  return { amount, price, fees, tone, metric }
}

export const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23' })

// 交易记录卡片：第一行类型、资产、账户和主金额，第二行次要信息、异常状态和详情入口。
export function RecordCard({ tag, title, source, amount, tone = '', meta, status, label, onSelect }: { tag: ReactNode; title: ReactNode; source: string; amount: ReactNode; tone?: string; meta: ReactNode[]; status?: ReactNode; label: string; onSelect: () => void }) {
  return <article className="contract-round" onClick={onSelect}>
    <div className="record-card-top">
      <div className="record-card-title">{tag}<strong>{title}</strong><span className="record-card-source">{source}</span></div>
      <span className={`record-card-amount numeric ${tone}`}>{amount}</span>
    </div>
    <div className="record-card-bottom">
      <span className="record-card-meta"><span>{meta.map((item, index) => <span key={index}>{item}</span>)}</span></span>
      {status && <span className="record-card-status" onClick={event => event.stopPropagation()}>{status}</span>}
      <button type="button" className="record-card-link" aria-label={`查看${label}详情`} onClick={event => { event.stopPropagation(); onSelect() }}>{t('详情')}<ChevronRight size={14} aria-hidden /></button>
    </div>
  </article>
}

export function ContractRoundCard({ round, hidden, onSelect }: { round: ContractRound; hidden: boolean; onSelect: () => void }) {
  const { amount, fees, tone } = display(hidden), pnlTone = tone(round.realizedPnl)
  return <RecordCard onSelect={onSelect} label={round.symbol + '这一轮合约'}
    tag={<span className={`contract-direction ${round.direction === '做多' ? 'positive' : 'negative'}`}>{round.direction}</span>}
    title={<>{round.symbol}<span className="contract-market">{t('U本位')}</span></>} source={round.connectionName}
    amount={<>{pnlTone === 'positive' && '+'}{amount(round.realizedPnl, round.pnlAsset)}</>} tone={pnlTone}
    meta={[<>{t('已平仓量')} {amount(round.closedQuantity, round.asset, 8)}</>, <>{t('手续费')} {fees(round)}</>, round.closedAt ? `平仓 ${clock(round.closedAt)}` : `最近成交 ${clock(round.lastAt)}`]}
    status={round.status === '资料不全' ? <>{t('资料不全')}<IssueHint message={round.warnings.join('；') || '成交记录不完整，无法核对整轮盈亏。'} /></> : round.status === '已平仓' ? undefined : round.status} />
}

export function ContractRoundModal({ selected, hidden, onClose }: { selected: ContractRound | null; hidden: boolean; onClose: () => void }) {
  const { amount, price, fees, tone, metric } = display(hidden)
  return <Modal open={!!selected} onClose={onClose} title={selected ? selected.symbol + ' · 这一轮合约' : '合约详情'} className="transactions-modal contract-history-modal">
      {selected && <div className="contract-history-detail">
        <dl className="contract-round-metrics">
          {metric('平仓盈亏', amount(selected.realizedPnl, selected.pnlAsset), tone(selected.realizedPnl))}
          {metric('手续费', fees(selected))}
          {metric('整轮净收益', selected.netPnl === null ? <Unavailable hidden={hidden} reason={selected.warnings.join('；') || '缺少完整成交、手续费或资金费，无法核对整轮净收益。'} /> : amount(selected.netPnl, selected.pnlAsset), tone(selected.netPnl))}
          {selected.fundingPnl !== null && metric('资金费收支', amount(selected.fundingPnl, selected.pnlAsset))}
          {metric('已平仓量', amount(selected.closedQuantity, selected.asset, 8))}
          {metric('开仓均价', price(selected.openPrice, selected.pnlAsset))}
          {metric('平仓均价', price(selected.closePrice, selected.pnlAsset))}
          {metric('最高持仓量', amount(selected.maxQuantity, selected.asset, 8))}
          {metric('开仓时间', stamp(selected.openedAt))}
          {metric('平仓时间', selected.closedAt === null ? '尚未完全平仓' : stamp(selected.closedAt))}
          {metric('持仓时间', duration(selected))}
        </dl>
        <details className="contract-fill-details"><summary>{t('展开本轮')} {selected.fills.length} {t('笔成交')}</summary><div className="records-table-scroll"><table className="records-table contract-fill-table"><thead><tr><th>{t('时间 / 操作')}</th><th>{t('数量 / 成交价')}</th><th>{t('平仓盈亏 / 手续费')}</th></tr></thead><tbody>{selected.fills.map((fill, index) => <tr key={fill.row.id + ':' + index}><td>{fill.action}<small>{stamp(fill.row.time)}</small><small>{t('成交编号')} {fill.row.id.split(':').at(-1)}</small></td><td data-label={t('数量 / 成交价')}>{amount(fill.quantity, selected.asset, 8)}<small>{price(fill.row.price, selected.pnlAsset)}</small></td><td data-label={t('平仓盈亏 / 手续费')}>{amount(fill.realizedPnl, selected.pnlAsset)}<small>{fill.fees.length ? feesAsUsdt(fill.row, fill.fees).map((fee, index) => <span key={index}>{index > 0 && ' / '}{amount(fee.quantity, fee.asset, 8)}</span>) : <Unavailable hidden={hidden} reason={t('平台未提供这笔成交的手续费。')} />}</small></td></tr>)}</tbody></table></div></details>
      </div>}
  </Modal>
}

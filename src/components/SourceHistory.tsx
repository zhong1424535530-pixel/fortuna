import { t } from '../i18n'
import { useMemo, useState } from 'react'
import Select from './Select'
import { Panel, SignedAmount, IssueHint, Unavailable } from './ui'
import { HistoryChart } from './Charts'
import ReturnRangeFilter from './ReturnRangeFilter'
import { accounts, assetSources, countOriginalAccounts, formatMoney, sourceGroups } from '../data/portfolio'
import { equityPoints } from '../data/equity-history'
import { returnRangeLabel } from '../data/return-range'
import type { ReturnRange } from '../data/return-range'
import type { AssetSource, Currency } from '../data/portfolio'

function SourcePicker({ selected, onSelect, currency, hidden }: { selected: AssetSource; onSelect: (id: string) => void; currency: Currency; hidden: boolean }) {
  return <Select label={t('选择平台或钱包')} value={selected.id} onChange={onSelect} compact searchable options={sourceGroups.flatMap(group => assetSources.filter(source => source.group === group).map(source => {
    const sourceAccounts = accounts.filter(account => source.accountIds.includes(account.id))
    const count = countOriginalAccounts(sourceAccounts)
    return { value: source.id, label: source.name, icon: source.icon, group, description: count > 1 ? `汇总 ${count} 个账户` : group === '链上钱包' ? '独立钱包' : '1 个账户', keywords: sourceAccounts.map(account => account.name).join(' '), trailing: formatMoney(source.valueCents, currency, hidden) }
  }))} />
}

export default function SourceHistoryPanel({ currency, hidden }: { currency: Currency; hidden: boolean }) {
  const [sourceId, setSourceId] = useState(assetSources[0]?.id ?? '')
  const [range, setRange] = useState<ReturnRange>({ period: '30天' })
  const source = assetSources.find(item => item.id === sourceId) ?? assetSources[0]
  const points = useMemo(() => source ? equityPoints({ mode: 'accounts', accountIds: source.accountIds, period: range }) : [], [source, range])
  const first = points[0]?.valueCents
  const last = points.at(-1)?.valueCents
  const change = first === undefined || last === undefined ? null : last - first
  const percentage = first !== undefined && first > 0 && change !== null ? change / first * 100 : null
  if (!source) return <Panel title={t('平台与钱包资产变化')}><div className="empty-state"><p>{t('暂无数据')}</p></div></Panel>
  return <Panel title={t('平台与钱包资产变化')} className="source-history-panel xl:col-span-8" action={<SourcePicker selected={source} onSelect={setSourceId} currency={currency} hidden={hidden} />}>
    <div className="source-history-stats"><div><span>{source.name} {t('· 账户资产净值')}{source.incomplete && !hidden && <IssueHint message={t('该来源的账户资料尚未完整，金额仅包含已知部分。')} />}</span><strong className="numeric">{formatMoney(source.valueCents, currency, hidden)}</strong><small>{countOriginalAccounts(accounts.filter(account => source.accountIds.includes(account.id)))} {t('个账户 ·')} {source.group}</small></div><div className="source-history-change"><span>{returnRangeLabel(range)}{t('资产变化')}</span>{change === null ? <strong><Unavailable hidden={hidden} reason={t('缺少可对比的期初或期末估值记录。')} /></strong> : <strong><SignedAmount value={change} currency={currency} hidden={hidden} /></strong>}<small className={hidden || change === null ? '' : change < 0 ? 'negative' : 'positive'}>{hidden || percentage === null ? '—' : `${percentage > 0 ? '+' : ''}${percentage.toFixed(2)}%`}</small></div></div>
    <div className="source-history-range"><span>{t('资产净值 ·')} {currency}</span><ReturnRangeFilter value={range} onChange={setRange} title={t('所选平台或钱包的曲线时间范围')} /></div>
    <HistoryChart period={range.period} currency={currency} hidden={hidden} historyPoints={points} />
    <div className="chart-bottom"><span><i />{source.name}</span></div>

  </Panel>
}

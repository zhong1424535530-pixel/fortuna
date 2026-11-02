import { t } from '../i18n'
import { themeColor } from '../theme'
import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { ArrowDownRight, ArrowDownUp, ArrowRight, ArrowUpRight, ChartNoAxesCombined, ChevronRight, Layers3 } from 'lucide-react'
import { Decimal } from 'decimal.js'
import { accounts, contracts, holdings, positionValueCents } from '../data/portfolio'
import { workspace } from '../data/workspace'
import { automaticAssetIcon } from '../data/asset-icons'
import type { Currency } from '../data/portfolio'
import { liveState } from '../data/live'
import { loadTransactions, transactionState, valueSavedTransactionFees } from '../data/transaction-client'
import type { TransactionState } from '../data/transactions'
import { buildContractHistory, roundFees } from '../data/contract-history'
import type { ContractRound } from '../data/contract-history'
import { calendarToday, returnRangeLabel } from '../data/return-range'
import type { ReturnRange } from '../data/return-range'
import { buildReturnEntries, closedFundingBreakdown, closedReturnDays, closedReturnStats, rankShares, returnDays, returnTotal } from '../data/returns-analysis'
import type { ReturnEntry } from '../data/returns-analysis'
import { spotGroupDays, tradingRanking, valueRecordedEntries } from '../data/returns-period'
import type { PeriodTrade, SpotGroup } from '../data/returns-period'
import { compareReturnAmounts, comparisonCategoryAmounts, comparisonPeriods, periodOverview } from '../data/returns-comparison'
import { periodReturnCurve, returnCurveEnd } from '../data/returns-curve'
import type { ReturnCurves } from '../data/returns-curve'
import { savedEquityPoints, syncEquityHistory } from '../data/equity-history'
import type { EquityPoint } from '../data/equity-history'
import { createReturnsPreview, previewContracts, previewSource } from '../data/returns-preview'
import Select from './Select'
import ReturnRangeFilter from './ReturnRangeFilter'
import { ClearFilters, FilterBar, FilterField } from './FilterBar'
import ContractPnlCalendar from './ContractPnlCalendar'
import { ContractRatioChart, IncomeChart, ReturnsComparisonChart } from './Charts'
import { ContractRoundModal } from './ContractHistory'
import { Avatar, Button, HiddenChart, IssueHint, Modal, Panel, SignedAmount, Unavailable } from './ui'
import '../records-pages.css'
import '../returns-page.css'

type Display = { hidden: boolean }
type RankRow = { id: string; label: string; amount: string | null; count: number; account?: string; reason?: string; kind?: string; partial?: boolean; icon?: string; symbol?: string }
const Money = Decimal.clone({ precision: 80 })
const stamp = (time: number) => new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const sourceOf = (accountId: string) => accounts.find(account => account.id === accountId)?.sourceId ?? accountId

function NativeAmount({ value, unit, hidden, signed = true, reason }: Display & { value: string | null; unit?: string; signed?: boolean; reason?: string }) {
  if (value === null) return <Unavailable hidden={hidden} reason={reason ?? '所选范围暂无这一项的可用记录，未将缺失金额当作零。'} />
  const exact = value === null ? null : new Money(value)
  const rounded = exact === null ? null : exact.toDecimalPlaces(2)
  const tiny = exact !== null && !exact.isZero() && rounded!.isZero()
  const tone = hidden || exact === null || exact.isZero() ? '' : exact.lt(0) ? 'negative' : signed ? 'positive' : ''
  const [integer, fraction] = rounded === null ? ['—'] : (rounded.isZero() ? '0.00' : rounded.toFixed(2)).split('.')
  const text = `${signed && rounded !== null && rounded.gt(0) ? '+' : ''}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? '.' + fraction : ''}`
  return <span className={`numeric ${tone}`}>{hidden ? '••••••' : tiny ? (exact!.lt(0) ? '支出 <0.01' : signed ? '收入 <0.01' : '<0.01') : text}{unit && !hidden && value !== null && <small className="returns-unit">{unit}</small>}</span>
}

function AmountChange({ comparison, unit, hidden, compact = false }: Display & { comparison: ReturnType<typeof compareReturnAmounts>; unit: string; compact?: boolean }) {
  if (hidden) return <span className="returns-amount-change">••••</span>
  const { difference, percent, label, percentLabel, tone } = comparison
  if (percent !== null) {
    // 支出增加时百分比为正，但净收益变差；箭头方向与赚亏颜色保持一致。
    const TrendArrow = tone === 'positive' ? ArrowUpRight : tone === 'negative' ? ArrowDownRight : ArrowRight
    return <span className={'returns-amount-change returns-change-indicator ' + tone} title={percentLabel + '（与上期金额比较；箭头表示净收益改善或变差）'}><span className="sr-only">{percentLabel}</span><TrendArrow className="returns-change-icon" size={18} strokeWidth={3.2} aria-hidden /><NativeAmount value={new Money(percent).abs().toFixed()} unit="%" hidden={false} signed={false} /></span>
  }
  if (compact) return <Unavailable reason={label + '；上期为零、亏损或资料不齐时，不计算收益金额涨跌幅。'} />
  return <span className={'returns-amount-change ' + tone}>
    {label}{difference !== null && !new Money(difference).isZero() && <> <NativeAmount value={new Money(difference).abs().toFixed()} unit={unit} hidden={false} signed={false} /></>}
  </span>
}

function Metric({ title, value, note, primary = false }: { title: ReactNode; value: ReactNode; note: ReactNode; primary?: boolean }) {
  return <div className={`returns-stat${primary ? ' returns-stat-primary' : ''}`}><span>{title}</span><strong>{value}</strong><small>{note}</small></div>
}

function ContractStat({ title, help, children, graphic, note, issue }: { title: string; help: string; children: ReactNode; graphic?: ReactNode; note?: ReactNode; issue?: string }) {
  return <div className="returns-summary-card">
    <h3 title={help}>{title}{issue && <IssueHint message={issue} />}</h3>
    <div className="returns-summary-main">{children}</div>
    {graphic && <div className="returns-summary-graphic">{graphic}</div>}
    {note && <div className="returns-summary-footer">{note}</div>}
  </div>
}

function ContractSummary({ stats, unit, hidden }: Display & { stats: ReturnType<typeof closedReturnStats>; unit: string }) {
  const total = stats.confirmed.length
  const directionTotal = stats.closed.length
  const longPercent = directionTotal ? new Money(stats.longCount).div(directionTotal).mul(100).toDecimalPlaces(1) : null
  const shortPercent = longPercent === null ? null : new Money(100).minus(longPercent)
  const averages = [{ label: '均盈', value: stats.averageWin, tone: 'positive' }, { label: '均亏', value: stats.averageLoss === null ? null : new Money(stats.averageLoss).negated().toFixed(), tone: 'negative' }]
  const maximum = Money.max(...averages.map(item => new Money(item.value ?? 0).abs()))
  const wins = [{ name: '盈利', value: stats.wins, color: themeColor('mint') }, { name: '亏损', value: stats.losses, color: themeColor('down') }, { name: '持平', value: stats.flat, color: themeColor('text-4') }]
  return <div className="returns-overview-stats">
    <ContractStat title={total < stats.closed.length ? '已记录平仓净收益' : '平仓净收益'} help="仅合计已核对的整轮平仓净收益，包含手续费与资金费" issue={!hidden && total < stats.closed.length ? `${stats.closed.length - total}轮交易缺少完整成交、手续费或资金费资料，只合计已核对部分。${stats.closed.flatMap(round => round.warnings).join('；')}` : undefined}>
      <strong className="returns-summary-value"><NativeAmount value={stats.net} unit={unit} hidden={hidden} /></strong>
    </ContractStat>
    <ContractStat title={t('已平仓交易')} help="所选范围内已完整平仓的交易轮数，一轮开仓到平仓计一笔，按平仓日期统计">
      <strong className="returns-summary-value">{hidden ? '••••' : <>{stats.closed.length}<small>{t('笔')}</small></>}</strong>
    </ContractStat>
    <ContractStat title={t('交易胜率')} help="盈利笔数 ÷ 已核对平仓笔数；持平交易也计入总笔数" issue={!hidden && !total ? '暂无净收益已核对完整的平仓交易，暂时无法计算胜率。' : undefined} note={hidden ? '••••' : total ? wins.map(item => <span className="returns-summary-key" key={item.name}><i style={{ backgroundColor: item.color }} aria-hidden />{item.name}{item.value}</span>) : null}>
      <ContractRatioChart parts={wins} hidden={hidden} label={`已核对交易：盈利${stats.wins}笔，亏损${stats.losses}笔，持平${stats.flat}笔；胜率${stats.winRate === null ? '暂无资料' : stats.winRate.toFixed(2) + '%'}`}>
        <strong className="returns-summary-rate">{stats.winRate === null ? '—' : <>{stats.winRate.toFixed(2)}<small>%</small></>}</strong>
      </ContractRatioChart>
    </ContractStat>
    <ContractStat title={t('多空比例')} help="按已平仓交易的笔数比较做多与做空" issue={!hidden && !directionTotal ? '暂无净收益已核对完整的平仓交易，暂时无法比较多空比例。' : undefined} note={hidden ? '••••' : directionTotal ? <><span className="returns-summary-key"><i className="is-long" aria-hidden />{t('做多')} {stats.longCount} {t('笔')}</span><span className="returns-summary-key"><i className="is-short" aria-hidden />{t('做空')} {stats.shortCount} {t('笔')}</span></> : null}>
      <ContractRatioChart parts={[{ name: '做多', value: stats.longCount, color: themeColor('mint') }, { name: '做空', value: stats.shortCount, color: themeColor('down') }]} hidden={hidden} label={directionTotal ? `做多${longPercent!.toFixed(1)}%，做空${shortPercent!.toFixed(1)}%；按已平仓笔数统计` : '暂无已核对平仓交易'}>
        {directionTotal ? <><span>{t('做多')}</span><strong className="returns-summary-rate is-long">{longPercent!.toFixed(1)}<small>%</small></strong></> : <strong className="returns-summary-rate">—</strong>}
      </ContractRatioChart>
    </ContractStat>
    <ContractStat title={t('平均盈亏比')} help={`平均每笔盈利 ÷ 平均每笔亏损的绝对值；下方金额单位为 ${unit}，横条按同一尺度比较`} issue={!hidden && stats.payoff === null ? '缺少可核对的盈利或亏损交易，暂时无法计算平均盈亏比。' : undefined} note={hidden ? '••••' : averages.map(item => <span key={item.label} title={item.label + '（' + unit + '）'}>{item.label} <NativeAmount value={item.value} hidden={false} /></span>)} graphic={!hidden && <div className="returns-summary-averages" role="img" aria-label={`平均盈利${stats.averageWin ?? '暂无资料'} ${unit}，平均亏损${stats.averageLoss ?? '暂无资料'} ${unit}`}>{averages.map(item => <span key={item.label}><i className={item.tone} style={{ width: `${maximum.isZero() ? 0 : new Money(item.value ?? 0).abs().div(maximum).mul(100).toNumber()}%` }} /></span>)}</div>}>
      <strong className="returns-summary-value">{hidden ? '••••' : stats.payoff === null ? '—' : <>{new Money(stats.payoff).toFixed(2)}<small>{t('倍')}</small></>}</strong>
    </ContractStat>
  </div>
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="returns-empty"><ArrowDownUp size={22} aria-hidden /><p>{children}</p></div>
}

function Ranking({ rows, unit, hidden, onSelect, wide = false, composition = false, expandable = false, share = false }: Display & { rows: RankRow[]; unit: string; onSelect?: (id: string) => void; wide?: boolean; composition?: boolean; expandable?: boolean; share?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (hidden) return <HiddenChart className="returns-ranking-hidden" />
  if (!rows.length) return <Empty>— <IssueHint message={t('所选范围暂无可比较的记录，可调整日期或账户。')} /></Empty>
  const maximum = rows.reduce((max, row) => Money.max(max, new Money(row.amount ?? 0).abs()), new Money(0))
  // 占比模式：盈利品种占盈利合计，亏损品种占亏损合计，各算各的；盈亏并存时以零轴分两侧，每侧最长占半宽。
  const shares = share ? rankShares(rows.map(row => row.amount)) : null
  const diverging = shares?.diverging ?? false
  const shareText = (row: RankRow, index: number) => {
    if (!shares || row.amount === null) return ''
    const percent = shares.bars[index].percent
    return (new Money(row.amount).lt(0) ? composition ? '占支出 ' : '占亏损 ' : composition ? '占收入 ' : '占盈利 ') + (percent > 0 && percent < 1 ? '<1' : percent.toFixed(0)) + '%'
  }
  return <div className={"returns-rank-list" + (wide ? " returns-rank-wide" : "") + (composition ? " returns-composition-list" : "") + (share ? " returns-share-list" : "") + (onSelect ? " returns-rank-action" : "")}>{(composition || expanded && expandable ? rows : rows.slice(0, 8)).map((row, index) => <div className="returns-rank-item" key={row.id} {...(onSelect ? { role: 'button', tabIndex: 0, onClick: () => onSelect(row.id), onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.id) } } } : {})}>
    <span className="returns-rank-number">{row.amount === null ? '—' : String(index + 1).padStart(2, '0')}</span>
    <div><div className="returns-rank-label"><span className={row.icon !== undefined ? 'returns-rank-asset' : undefined}>{row.icon !== undefined && <Avatar src={row.icon} name={row.symbol ?? row.label} size={26} company={row.kind === '股票'} />}<span>{row.label}{row.kind && <em className="returns-rank-kind">{row.kind}</em>}{(row.amount === null || row.partial) && <IssueHint message={row.reason || '所选范围没有完整的可用记录，未将缺失部分当作零。'} />}{!composition && <small>{row.account ? row.account + ' · ' : ''}{row.count} {t('条记录')}</small>}</span></span><span className="returns-rank-value">{row.amount === null ? <span className="returns-pending">—</span> : <NativeAmount value={row.amount} unit={unit} hidden={false} />}{share && row.amount !== null && <small>{shareText(row, index)}</small>}</span></div><div className={"returns-rank-track" + (diverging ? " is-diverging" : "")} aria-hidden style={{ visibility: row.amount === null ? 'hidden' : undefined }}><span className={new Money(row.amount ?? 0).lt(0) ? 'is-negative' : ''} style={{ width: `${shares ? shares.bars[index].width : maximum.isZero() ? 0 : new Money(row.amount ?? 0).abs().div(maximum).mul(100).toNumber()}%` }} /></div>{onSelect && <ChevronRight className="returns-rank-chevron" size={16} aria-hidden />}</div>
  </div>)}{expandable && rows.length > 8 && <Button aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `展开全部 ${rows.length} 项`}</Button>}</div>
}

function Breakdown({ rows, unit, hidden, totalLabel, totalValue }: Display & { rows: { label: string; value: string | null; note?: string; unit?: string }[]; unit: string; totalLabel?: string; totalValue?: string | null }) {
  const total = totalValue === undefined ? returnTotal(rows.flatMap(row => row.value === null ? [] : [{ asset: row.unit ?? unit, amount: row.value }])) : totalValue
  return <div className="returns-breakdown">{rows.map(row => <div key={row.label}><span title={row.note}>{row.label}</span><NativeAmount value={row.value} unit={row.unit ?? unit} hidden={hidden} /></div>)}{totalLabel && <div className="returns-breakdown-total"><span>{totalLabel}</span><NativeAmount value={total} unit={unit} hidden={hidden} /></div>}</div>
}

function duration(round: ContractRound) {
  if (round.openedAt === null || round.closedAt === null) return '时间不全'
  const minutes = Math.floor((round.closedAt - round.openedAt) / 60000)
  return minutes < 1 ? '不足1分钟' : minutes >= 1440 ? `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时` : minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分钟` : `${minutes}分钟`
}

// 图标识别修正后换地址，让浏览器不再使用之前缓存的占位图。
const closedContractIcon = (asset: string) => automaticAssetIcon({ id: 'binance:' + asset, market: 'crypto', icon: '' }) + '&v=contracts-3'

function contractIcon(round: ContractRound) {
  const position = contracts.find(item => item.symbol === round.symbol)
  return position?.icon ?? closedContractIcon(round.asset)
}

function performance(rounds: ContractRound[], by: 'symbol' | 'direction'): RankRow[] {
  const groups = new Map<string, ContractRound[]>()
  for (const round of rounds) {
    const group = groups.get(round[by]) ?? []
    group.push(round)
    groups.set(round[by], group)
  }
  return [...groups].map(([label, group]) => ({ id: label, label, count: group.length, amount: closedReturnStats(group).net, ...(by === 'symbol' ? { symbol: group[0].asset, icon: contractIcon(group[0]) } : {}) }))
    .sort((a, b) => new Money(b.amount ?? 0).abs().comparedTo(new Money(a.amount ?? 0).abs()))
}

type Detail = { title: string; entries?: ReturnEntry[]; spot?: PeriodTrade }
function PeriodComparison({ current, previous, periods, unit, hidden, days, curves }: Display & { current: ReturnType<typeof periodOverview>; previous: ReturnType<typeof periodOverview> | null; periods: ReturnType<typeof comparisonPeriods>; unit: string; days: ReturnType<typeof returnDays>; curves: ReturnCurves | null }) {
  if (!periods.previous) return <div className="returns-comparison returns-comparison-all"><strong>{t('累计交易收支走势')}</strong><IncomeChart days={days} unit={unit} hidden={hidden} daily={false} label={t('已记录交易收支累计')} /><small>{days.length ? `${days[0].label} 至 ${days.at(-1)!.label}` : '暂无可展示的记录'}</small></div>
  const comparison = compareReturnAmounts(current.comparable, previous?.comparable ?? null), difference = comparison.difference

  return <div className="returns-comparison">
    <div className="returns-comparison-summary">
      <div className="returns-comparison-heading"><strong>{periods.label}{!hidden && (current.comparable === null || previous?.comparable === null) && <IssueHint message={[...current.reasons.map(reason => '本期：' + reason), ...(previous?.reasons ?? []).map(reason => '上期：' + reason)].join('；') || '两期记录尚未完整，暂不比较金额差。'} />}</strong><span>{hidden ? '收益变化' : comparison.label}</span></div>
      <div className="returns-comparison-difference">
        <div className="returns-comparison-values"><span className={'returns-comparison-change-value ' + (hidden ? '' : comparison.tone)}><NativeAmount value={difference === null ? null : new Money(difference).abs().toFixed()} unit={unit} hidden={hidden} signed={false} /></span><AmountChange comparison={comparison} unit={unit} hidden={hidden} compact /></div>
        <small>{t('上期')} <NativeAmount value={previous?.comparable ?? null} unit={unit} hidden={hidden} /></small>
      </div>
    </div>
    {curves && <ReturnsComparisonChart curves={curves} unit={unit} hidden={hidden} />}
  </div>
}
const sumAmounts = (values: (string | null)[], unit: string) => returnTotal(values.flatMap(amount => amount === null ? [] : [{ asset: unit, amount }]))
const categoryLabel = (entry: ReturnEntry) => entry.category === '奖励收入' ? ['REFERRAL_KICKBACK', 'COMMISSION_REBATE', 'API_REBATE', 'SPOT_COMMISSION_REBATE', 'SPOT_REFERRAL_KICKBACK'].includes(entry.row.note) ? '返佣 / 返现' : '平台奖励' : entry.category
type ChartCategory = ReturnEntry['category'] | SpotGroup
const categoryTabs: { value: ChartCategory; label: string }[] = [
  { value: '合约交易盈亏', label: '合约已实现' }, { value: 'crypto', label: '现货' }, { value: 'stocks', label: '股票' }, { value: 'other', label: '其他资产' },
  { value: '交易手续费', label: '手续费' }, { value: '资金费', label: '资金费' }, { value: '奖励收入', label: '奖励' },
]

export default function ReturnsPage({ currency, hidden, currencyControls }: { currency: Currency; hidden: boolean; currencyControls: ReactNode }) {
  const [preview] = useState(false)
  const [view, setView] = useState<'overall' | 'contracts'>('overall')
  const [range, setRange] = useState<ReturnRange>({ period: '30天' })
  const [source, setSource] = useState(''), [asset, setAsset] = useState('USDT')
  const [symbol, setSymbol] = useState(''), [direction, setDirection] = useState('')
  const [chart, setChart] = useState<'cumulative' | 'daily'>('cumulative')
  const [chartCategory, setChartCategory] = useState<ChartCategory>('合约交易盈亏')
  const [rankMarket, setRankMarket] = useState('all')
  const [savedState, setState] = useState<TransactionState>(() => ({ records: [], syncs: transactionState.syncs }))
  const [points, setPoints] = useState<readonly EquityPoint[]>(savedEquityPoints)
  const [loading, setLoading] = useState(true)
  const [roundId, setRoundId] = useState(''), [page, setPage] = useState(1)
  const [reviewDay, setReviewDay] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)

  useEffect(() => {
    let active = true
    const update = () => { if (active) { setState(transactionState); setLoading(false) } }
    const updateHistory = () => { if (active) setPoints(savedEquityPoints()) }
    const refreshFees = () => { if (active) void valueSavedTransactionFees().then(update).catch(() => {}) }
    const reload = () => { void loadTransactions().then(() => { update(); refreshFees() }).catch(() => {}) }
    const feeTimer = window.setInterval(() => { if (document.visibilityState === 'visible') refreshFees() }, 60000)
    window.addEventListener('transaction-data-change', reload)
    window.addEventListener('equity-history-change', updateHistory)
    void loadTransactions().then(() => { update(); refreshFees() }).catch(() => {}).finally(() => { if (active) setLoading(false) })
    void syncEquityHistory().then(updateHistory)
    return () => { active = false; window.clearInterval(feeTimer); window.removeEventListener('transaction-data-change', reload); window.removeEventListener('equity-history-change', updateHistory) }
  }, [])
  useEffect(() => { setPage(1); setDetail(null); setReviewDay('') }, [range, source, asset, symbol, direction, view])
  const now = Date.now()
  const activeRange: ReturnRange = range
  const periods = comparisonPeriods(activeRange, null, now), { start, end } = periods.current
  const demo = useMemo(() => preview ? createReturnsPreview(periods) : null, [preview, start, end, periods.previous?.start, periods.previous?.end])
  const state = demo?.state ?? savedState
  const positions = preview ? previewContracts : contracts
  const entries = useMemo(() => buildReturnEntries(state.records), [state.records])
  const history = useMemo(() => buildContractHistory(state, workspace.contractFunding, workspace.contractNet), [state, workspace.contractFunding, workspace.contractNet])
  const units = preview ? ['USDT'] : [...new Set(['USDT', 'USDC', 'USD', ...entries.filter(entry => !entry.row.scope.startsWith('wallet:')).map(entry => entry.asset), ...history.rounds.map(round => round.pnlAsset)])]
  const unit = units.includes(asset) ? asset : 'USDT'
  const sources = new Map<string, string>()
  if (preview) sources.set(previewSource, '演示投资账户')
  else {
    for (const account of accounts.filter(account => account.kind !== '钱包')) sources.set(account.sourceId, account.name)
    for (const row of state.records.filter(row => !row.scope.startsWith('wallet:'))) sources.set('live-' + row.connectionId, row.connectionName)
    for (const connection of liveState.connections.filter(connection => connection.type !== 'wallet')) sources.set('live-' + connection.id, connection.name)
  }

  const currentPositions: NonNullable<EquityPoint['investmentPositions']> = holdings.flatMap(holding => holding.members ?? [holding]).flatMap(holding => holding.positions.map(position => [holding.id, holding.symbol, holding.category === '现金与稳定币' ? 'cash' : holding.market, position.accountId, new Money(position.quantityText ?? position.quantity).toFixed(), holding.usdPrice === null ? null : positionValueCents(holding, position)]))
  const accountRows: NonNullable<EquityPoint['investmentAccounts']> = accounts.map(account => [account.id, account.sourceId, account.name, account.kind === '钱包' ? '链上' : account.accountGroup ?? (account.kind === '手动账户' ? '手动' : '现货'), account.status ?? 'pending'])
  const periodFilter = { start, end, source, unit }
  const overview = demo?.overview ?? periodOverview(state, points, periodFilter, currentPositions, accountRows, entries)
  const previous = demo ? demo.previous : periods.previous ? periodOverview(state, points, { ...periods.previous, source, unit }, [], accountRows, entries) : null
  // 已结束的日线按日期缓存，期末点使用最新总览，保持同一期间两处金额一致。
  const currentEndDay = calendarToday(new Date(end)), previousEndDay = periods.previous ? calendarToday(new Date(periods.previous.end)) : ''
  const accountKey = JSON.stringify(accountRows)
  const historyCurves = useMemo(() => {
    if (preview || !periods.previous) return null
    return {
      current: periodReturnCurve(state, points, periodFilter, accountRows, entries),
      previous: periodReturnCurve(state, points, { ...periodFilter, ...periods.previous }, accountRows, entries),
    }
  }, [preview, state, points, entries, source, unit, start, currentEndDay, periods.previous?.start, previousEndDay, accountKey])
  const curves = demo?.curves ?? (historyCurves && periods.previous ? {
    current: returnCurveEnd(historyCurves.current, end, overview.comparable),
    previous: returnCurveEnd(historyCurves.previous, periods.previous.end, previous?.comparable ?? null),
  } : null)
  const currentAmounts = comparisonCategoryAmounts(overview), previousAmounts = comparisonCategoryAmounts(previous)
  const { native, valued, spot } = overview, filtered = valued.entries
  const ofCategory = (category: ReturnEntry['category']) => filtered.filter(entry => entry.category === category)
  const originalCategory = (category: ReturnEntry['category']) => native.filter(entry => entry.category === category)
  const totalCategory = (category: ReturnEntry['category']) => returnTotal(ofCategory(category))
  const missingCategory = (category: ReturnEntry['category']) => valued.missing.filter(entry => entry.category === category).length
  const cryptoRows = spot.filter(row => row.market === 'crypto'), stockRows = spot.filter(row => ['us', 'cn'].includes(row.market))
  const crypto = sumAmounts(cryptoRows.map(row => row.amount), unit), stocks = sumAmounts(stockRows.map(row => row.amount), unit)
  const spotNet = sumAmounts([crypto, stocks], unit)
  const gross = totalCategory('合约交易盈亏'), reward = totalCategory('奖励收入'), fees = totalCategory('交易手续费'), fundingNet = totalCategory('资金费')
  const contractNet = gross
  // 明细里的原币已经是统计币种时，不再重复显示一列折合金额。
  const detailConverted = !!detail?.entries?.some(entry => entry.asset !== unit)
  const knownNet = overview.net
  const fundingIncome = returnTotal(ofCategory('资金费').filter(entry => new Money(entry.amount).gte(0)))
  const fundingExpense = returnTotal(ofCategory('资金费').filter(entry => new Money(entry.amount).lt(0)))
  const feeCoins = [...new Set(originalCategory('交易手续费').map(entry => entry.asset))]
  const nativeFees = feeCoins.map(asset => ({ asset, value: returnTotal(originalCategory('交易手续费').filter(entry => entry.asset === asset)) })).filter(item => item.value !== null && !new Money(item.value).isZero())
  const feeNativeDisplay = missingCategory('交易手续费') > 0 ? nativeFees : []
  const contractRank = tradingRanking(ofCategory('合约交易盈亏'))
  const marketKind = (market: string) => market === 'crypto' ? '加密现货' : ['us', 'cn'].includes(market) ? '股票' : '其他'
  const rankedSpot: RankRow[] = spot.map(row => {
    const asset = holdings.find(asset => row.id.startsWith(asset.id + ':'))
    return { ...row, id: 'spot:' + row.id, label: preview ? row.label : asset?.name ?? row.label, kind: marketKind(row.market), icon: asset?.icon ?? (row.market === 'crypto' && row.id.startsWith('binance:') ? automaticAssetIcon({ id: 'binance:' + row.label, market: 'crypto', icon: '' }) : ''), symbol: asset?.symbol ?? row.label, ...(row.partial ? { amount: null } : {}) }
  })
  const rankedContracts: RankRow[] = contractRank.map(row => {
    const symbol = row.entries[0].row.asset
    const asset = holdings.find(asset => asset.id === 'binance:' + symbol)
    const position = contracts.find(position => position.symbol === row.label)
    return { ...row, id: 'contract:' + row.id, kind: '合约', symbol, icon: asset?.icon ?? position?.icon ?? closedContractIcon(symbol) }
  })
  const rankRows = [...rankedSpot, ...rankedContracts].filter(row => rankMarket === 'all' || row.kind === ({ crypto: '加密现货', stocks: '股票', contracts: '合约', other: '其他' } as Record<string, string>)[rankMarket])
  const filteredRounds = history.rounds.filter(round => (!source || 'live-' + round.connectionId === source) && (!symbol || round.symbol === symbol) && (!direction || round.direction === direction) && round.pnlAsset === unit && (round.closedAt ?? round.lastAt) >= start && (round.closedAt ?? round.lastAt) <= end)
  const stats = closedReturnStats(filteredRounds), closedFunding = closedFundingBreakdown(filteredRounds, entries)
  const chartDays = view === 'overall' ? (chartCategory === 'crypto' || chartCategory === 'stocks' || chartCategory === 'other' ? spotGroupDays(state, points, periodFilter, currentPositions, accountRows, chartCategory) : returnDays(ofCategory(chartCategory))) : closedReturnDays(filteredRounds)
  const chartTitle = view === 'overall' ? (categoryTabs.find(item => item.value === chartCategory)?.label ?? '') + (chart === 'daily' ? '每日记录' : '累计记录') : chart === 'daily' ? '每日已平仓净收益' : '累计已平仓净收益'
  const selectedRound = history.rounds.find(round => round.id === roundId) ?? null
  const reviewRounds = reviewDay ? filteredRounds.filter(round => round.closedAt !== null && round.status !== '持仓中' && calendarToday(new Date(round.closedAt)) === reviewDay) : filteredRounds
  const pages = Math.max(1, Math.ceil(reviewRounds.length / 15)), currentPage = Math.min(page, pages)
  const symbols = [...new Set([...history.rounds.map(round => round.symbol), ...positions.map(position => position.symbol)])].sort()
  const relevantSyncs = state.syncs.filter(sync => !sync.key.startsWith('wallet:') && (!source || 'live-' + sync.connectionId === source))
  const issues = relevantSyncs.filter(sync => sync.status !== 'ok' || sync.from > start && start !== 0 || sync.to < end - 300000)
  const readIssues = preview ? '' : issues.map(item => `${item.connectionName} · ${item.label}：${item.warning || '记录未覆盖所选日期，或本次未完整读取。'}`).join('\n')
  const overviewIssue = [...overview.reasons, readIssues].filter(Boolean).join('；')
  const currentContracts = positions.filter(position => (!source || (preview ? previewSource : sourceOf(position.accountId)) === source) && (!symbol || position.symbol === symbol) && (!direction || position.direction === direction))
  function selectRank(id: string) {
    const item = contractRank.find(row => 'contract:' + row.id === id)
    if (item) setDetail({ title: item.label + ' · 本期已实现盈亏', entries: item.entries })
    else { const row = spot.find(row => 'spot:' + row.id === id); if (row) setDetail({ title: row.label + ' · 本期资产盈亏', spot: row }) }
  }
  // 现货类盈亏从范围内最早的快照起算时，在名称后注明起点，避免被当成整个范围的盈亏。
  const compositionRows = [
          { label: '加密现货盈亏', value: crypto, partial: cryptoRows.some(row => row.amount === null || row.partial), note: cryptoRows.filter(row => row.amount === null || row.partial).map(row => `${row.label}：${row.reason}`).join('；') || '所选范围没有加密现货的完整期初、期末估值及买卖记录' },
          { label: '股票盈亏', value: stocks, note: preview ? '模拟股票买卖与持仓涨跌，以 USDT 等值展示' : '股票成交、分红资料未接入时不估算' },
          ...(spot.some(row => !['crypto', 'us', 'cn'].includes(row.market)) ? [{ label: '其他资产盈亏', value: sumAmounts(spot.filter(row => !['crypto', 'us', 'cn'].includes(row.market)).map(row => row.amount), unit), note: preview ? '模拟黄金的本期持仓涨跌' : '手动资产的期间增减资料不足时不估算' }] : []),
          { label: '合约已实现盈亏', value: gross },
          { label: '交易手续费净收支', value: fees, partial: missingCategory('交易手续费') > 0, note: missingCategory('交易手续费') ? '部分手续费缺少历史换算价，顶部交易手续费卡片可查看原币明细' : undefined },
          { label: '收到的资金费', value: fundingIncome }, { label: '支付的资金费', value: fundingExpense },
          { label: '交易所奖励', value: reward, note: '返佣与返现不归到 ETH 等品种的交易利润' },
        ]
  const categoryCards = [
    { title: '现货盈亏', incomplete: currentAmounts.spot === null, value: currentAmounts.spot ?? spotNet, comparison: compareReturnAmounts(currentAmounts.spot, previousAmounts.spot), action: () => { setRankMarket('all'); document.getElementById('returns-ranking')?.scrollIntoView({ behavior: 'smooth' }) } },
    { title: '合约盈亏', incomplete: currentAmounts.contracts === null, value: currentAmounts.contracts ?? contractNet, comparison: compareReturnAmounts(currentAmounts.contracts, previousAmounts.contracts), action: () => setDetail({ title: '合约已实现盈亏', entries: originalCategory('合约交易盈亏') }) },
    { title: '交易手续费', incomplete: currentAmounts.fees === null, comparison: compareReturnAmounts(currentAmounts.fees, previousAmounts.fees, 'cashflow'), value: feeNativeDisplay.length ? null : currentAmounts.fees ?? fees, nativeAmounts: feeNativeDisplay, unit, action: () => setDetail({ title: '交易手续费 · 原币明细', entries: originalCategory('交易手续费') }) },
    { title: '资金费净收支', incomplete: currentAmounts.funding === null, value: currentAmounts.funding ?? fundingNet, comparison: compareReturnAmounts(currentAmounts.funding, previousAmounts.funding, 'cashflow'), action: () => setDetail({ title: '资金费收支明细', entries: originalCategory('资金费') }) },
    { title: '交易所奖励', incomplete: currentAmounts.rewards === null, value: currentAmounts.rewards ?? reward, comparison: compareReturnAmounts(currentAmounts.rewards, previousAmounts.rewards, 'cashflow'), action: () => setDetail({ title: '交易所奖励明细', entries: originalCategory('奖励收入') }) },
  ]

  return <div className="records-page returns-page returns-redesign">
    <div className="returns-topline"><div className="segmented returns-view-switch" role="group" aria-label={t('收益分析内容')}><button type="button" aria-pressed={view === 'overall'} className={view === 'overall' ? 'active' : ''} onClick={() => setView('overall')}><ChartNoAxesCombined size={15} />{t('整体收益')}</button><button type="button" aria-pressed={view === 'contracts'} className={view === 'contracts' ? 'active' : ''} onClick={() => setView('contracts')}><Layers3 size={15} />{t('合约复盘')}</button></div><div className="returns-preview-actions">{preview && <span className="returns-local-label">{t('模拟资料')}</span>}</div></div>
    <div className="returns-filter-panel">
      <FilterBar><FilterField label={t('来源账户')}><Select value={source} onChange={setSource} label={t('收益来源账户')} searchable options={[{ value: '', label: '全部账户' }, ...[...sources].map(([value, label]) => ({ value, label }))]} /></FilterField>
        {view === 'contracts' && <><FilterField label={t('交易品种')}><Select value={symbol} onChange={setSymbol} label={t('合约复盘品种')} searchable options={[{ value: '', label: '全部品种' }, ...symbols.map(value => ({ value, label: value }))]} /></FilterField><FilterField label={t('交易方向')}><Select value={direction} onChange={setDirection} label={t('合约复盘方向')} options={[{ value: '', label: '全部方向' }, { value: '做多', label: '做多' }, { value: '做空', label: '做空' }]} /></FilterField></>}
        <FilterField label={t('统计币种')}><Select value={unit} onChange={setAsset} label={t('收益统计币种')} searchable options={units.map(value => ({ value, label: value }))} /></FilterField>
        <FilterField label={t('时间范围')}><ReturnRangeFilter value={activeRange} onChange={setRange} title={t('收益统计时间范围')} /></FilterField>
        {(source || symbol || direction || range.period !== '30天') && <ClearFilters onClick={() => { setSource(''); setSymbol(''); setDirection(''); setRange({ period: '30天' }) }} />}
      </FilterBar><p className="returns-filter-note">{returnRangeLabel(activeRange)} {t('· 北京时间 ·')} {unit}{!hidden && readIssues && <IssueHint message={readIssues} />}</p>
    </div>
    {!preview && loading && <p className="returns-loading" role="status">{t('正在读取已保存记录…')}</p>}
    {view === 'overall' ? <>
      <div className="returns-hero">
        <div className="returns-hero-main"><h2>{overview.reasons.length ? '已记录净收益' : '本期净收益'}</h2><div className="returns-hero-amount"><NativeAmount value={knownNet} unit={unit} hidden={hidden} /></div></div>
        <PeriodComparison current={overview} previous={previous} periods={periods} unit={unit} hidden={hidden} days={returnDays(filtered)} curves={curves} />
      </div>
      <div className="returns-category-stats">{categoryCards.map(card => <div className="returns-category-card" key={card.title}><Metric title={card.title} value={<>{card.nativeAmounts?.length ? card.nativeAmounts.map(item => <span className="returns-native-fee" key={item.asset}><NativeAmount value={item.value} unit={item.asset} hidden={hidden} /></span>) : <NativeAmount value={card.value} unit={card.unit ?? unit} hidden={hidden} reason={overviewIssue || undefined} />}{!hidden && card.value !== null && card.incomplete && <IssueHint message={overviewIssue || '当前仅展示已记录部分，资料未完整核对。'} />}</>} note={previous ? <AmountChange comparison={card.comparison} unit={card.unit ?? unit} hidden={hidden} compact /> : <span title={t('全部时间没有上期可比')}>—</span>} /><button type="button" className="returns-card-action" onClick={card.action}>{t('查看明细')} <ArrowUpRight size={12} /></button></div>)}</div>
      <div className="returns-analysis-grid returns-analysis-stack">
        <Panel title={t('本期收益组成')} subtitle={unit}>
          <div className="records-panel-body">
            <div className="returns-composition-heading"><div className="returns-chart-legend"><span>{t('收入 / 盈利')}</span><span>{t('支出 / 亏损')}</span></div><div className="returns-composition-total"><span>{preview ? '模拟净收益' : '已记录部分净收益'}</span><NativeAmount value={knownNet} unit={unit} hidden={hidden} /></div></div>
            <Ranking rows={compositionRows.map(row => ({ id: row.label, label: row.label, amount: row.value, reason: row.note, partial: row.partial, count: 0 }))} unit={unit} hidden={hidden} wide composition share />
          </div>
        </Panel>
        <div id="returns-ranking" className="returns-ranking-anchor"><Panel title={t('交易盈亏排行')} action={<div className="segmented returns-rank-tabs" role="group" aria-label={t('交易排行类别')}>{[{ value: 'all', label: '全部' }, { value: 'crypto', label: '加密现货' }, { value: 'stocks', label: '股票' }, { value: 'contracts', label: '合约' }, { value: 'other', label: '其他' }].map(item => <button type="button" key={item.value} aria-pressed={rankMarket === item.value} className={rankMarket === item.value ? 'active' : ''} onClick={() => setRankMarket(item.value)}>{item.label}</button>)}</div>}>
          <div className="records-panel-body"><Ranking key={rankMarket} rows={[...rankRows].sort((a, b) => a.amount === null ? b.amount === null ? 0 : 1 : b.amount === null ? -1 : new Money(b.amount).abs().comparedTo(new Money(a.amount).abs()))} unit={unit} hidden={hidden} onSelect={selectRank} wide expandable share /></div>
        </Panel></div>
      </div>
    </> : <>
      <ContractSummary stats={stats} unit={unit} hidden={hidden} />
    </>}

    <div className={view === 'contracts' ? 'returns-review-visuals' : undefined}>
    {view === 'contracts' && <ContractPnlCalendar key={`${start}:${calendarToday(new Date(end))}:${source}:${unit}:${symbol}:${direction}:${preview}`} rounds={filteredRounds} start={start} end={end} unit={unit} hidden={hidden} selected={reviewDay} onSelect={date => { setReviewDay(date); setPage(1) }} />}
    <Panel title={<>{chartTitle}{!hidden && readIssues && <IssueHint message={readIssues} />}</>} subtitle={unit + ' · ' + returnRangeLabel(activeRange)} action={<div className="segmented"><button type="button" className={chart === 'cumulative' ? 'active' : ''} aria-pressed={chart === 'cumulative'} onClick={() => setChart('cumulative')}>{t('累计')}</button><button type="button" className={chart === 'daily' ? 'active' : ''} aria-pressed={chart === 'daily'} onClick={() => setChart('daily')}>{t('每日')}</button></div>}>
      <div className="records-panel-body">{view === 'overall' && <div className="segmented returns-chart-tabs" role="group" aria-label={t('趋势项目')}>{categoryTabs.map(item => <button type="button" key={item.value} aria-pressed={chartCategory === item.value} className={chartCategory === item.value ? 'active' : ''} onClick={() => setChartCategory(item.value)}>{item.label}</button>)}</div>}<IncomeChart days={chartDays} unit={unit} hidden={hidden} daily={chart === 'daily'} label={chartTitle} dateRange={view === 'contracts' ? { start, end } : undefined} /></div>
    </Panel>
    </div>
    {view === 'contracts' && <>
      <div className="returns-analysis-grid">
        <Panel title={t('整轮交易收支')} subtitle={stats.closed.length + ' 笔已平仓交易 · ' + unit}><div className="records-panel-body"><Breakdown rows={[...(stats.gross !== null ? [{ label: '平仓盈利', value: stats.grossWin }, { label: '平仓亏损', value: stats.grossLoss }] : [{ label: '交易平仓盈亏', value: stats.gross }]), ...(stats.fees !== null ? [{ label: '交易手续费净收支', value: stats.fees }] : stats.nativeFees.length ? stats.nativeFees.map(fee => ({ label: '交易手续费 · ' + fee.asset, value: fee.amount, unit: fee.asset })) : [{ label: '交易手续费净收支', value: null }]), ...(closedFunding.income !== null ? [{ label: '收到的资金费', value: closedFunding.income }, { label: '支付的资金费', value: closedFunding.expense }] : [{ label: '资金费净收支', value: stats.funding }]), ...(stats.netGap ? [{ label: '补录差额 · 读取范围外的费用', value: stats.netGap }] : [])]} totalLabel={stats.confirmed.length < stats.closed.length ? '已记录净收益' : '整轮净收益'} totalValue={stats.net} unit={unit} hidden={hidden} /></div></Panel>
        <Panel title={t('做多与做空表现')}><div className="records-panel-body"><Ranking rows={performance(stats.confirmed, 'direction')} unit={unit} hidden={hidden} share /></div></Panel>
      </div>
      <Panel title={t('交易品种表现')}><div className="records-panel-body"><Ranking rows={performance(stats.confirmed, 'symbol')} unit={unit} hidden={hidden} share /></div></Panel>
      <Panel title={t('当前合约浮动盈亏参考')} subtitle={currency} action={currencyControls}><div className="records-panel-body">{!currentContracts.length ? <Empty>{t('当前没有符合筛选的合约持仓')}</Empty> : currentContracts.map(position => <div className="returns-current-row" key={position.id}><Avatar src={position.icon} name={position.symbol} size={25} /><span>{position.symbol}<small>{position.direction} {t('· 当前未平仓')}</small></span><SignedAmount value={accounts.find(account => account.id === position.accountId)?.status === 'error' ? null : position.unrealizedPnlCents} currency={currency} hidden={hidden} /></div>)}</div></Panel>
      <Panel title={t('逐笔合约复盘')} subtitle={reviewDay || undefined} action={<div className="returns-review-filter"><span className="returns-panel-count">{reviewRounds.length} {t('轮交易')}</span>{reviewDay && <Button onClick={() => { setReviewDay(''); setPage(1) }}>{t('清除日期筛选')}</Button>}</div>}>
        <div className="records-panel-body"><div className="records-table-scroll"><table className="records-table returns-review-table"><thead><tr><th>{t('合约 / 账户')}</th><th>{t('方向 / 状态')}</th><th>{t('平仓时间 / 持有时长')}</th><th>{t('平仓盈亏')}</th><th>{t('手续费 / 资金费')}</th><th>{t('整轮净收益')}</th><th>{t('明细')}</th></tr></thead><tbody>{[...reviewRounds].sort((a, b) => (b.closedAt ?? b.lastAt) - (a.closedAt ?? a.lastAt)).slice((currentPage - 1) * 15, currentPage * 15).map(round => <tr key={round.id}>
          <td><strong>{round.symbol}</strong><small>{round.connectionName}</small></td><td><span className={'returns-direction ' + (round.direction === '做多' ? 'long' : 'short')}>{round.direction}</span><small>{round.status === '资料不全' ? <IssueHint message={round.warnings.join('；') || '成交资料不完整，无法确认这一轮完整盈亏。'} /> : round.status}</small></td><td>{round.closedAt === null ? '尚未确认平仓' : stamp(round.closedAt)}<small>{duration(round)}</small></td><td data-label={t('平仓盈亏')}><NativeAmount value={round.realizedPnl} unit={round.pnlAsset} hidden={hidden} /></td><td><div className="returns-fee-main" data-label={t('手续费')}>{hidden ? '••••••' : roundFees(round).length ? roundFees(round).map((fee, index) => <div key={index}><NativeAmount value={fee.quantity} unit={fee.asset} hidden={false} signed={false} /></div>) : '—'}</div><small data-label={t('资金费')}><span className="returns-fee-name">{t('资金费')} </span>{round.fundingManual && <IssueHint message={t('资金费为手动补录。')} />}<NativeAmount value={round.fundingPnl} unit={round.pnlAsset} hidden={hidden} /></small></td><td data-label={t('整轮净收益')}><NativeAmount value={round.netPnl} unit={round.pnlAsset} hidden={hidden} reason={round.warnings.join('；') || '缺少完整成交、手续费或资金费，无法核对整轮净收益。'} />{round.netManual && <IssueHint message={t('整轮净盈亏为手动补录，含读取范围之外的开仓费用与资金费。')} />}</td><td><Button onClick={() => setRoundId(round.id)}>{t('查看详情')}</Button></td>
        </tr>)}</tbody></table></div>{!reviewRounds.length && <Empty>{reviewDay ? '这一天没有已记录的平仓交易，可以选择其他日期或清除日期筛选。' : '所选范围暂无合约交易记录，可调整日期、账户或统计币种。'}</Empty>}{reviewRounds.length > 15 && <div className="transactions-pagination"><span>{t('第')}{currentPage} / {pages}{t('页 · 每页15轮')}</span><Button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t('上一页')}</Button><Button disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{t('下一页')}</Button></div>}</div>
      </Panel>
    </>}
    <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.title ?? '收益明细'} className="transactions-modal returns-detail-modal">
      <div className="returns-detail-body">
      {detail?.spot && <><p className="returns-detail-message">{detail.spot.account}{(detail.spot.amount === null || detail.spot.partial) && <IssueHint message={detail.spot.reason} />}</p>{detail.spot.components ? <Breakdown rows={Object.entries(detail.spot.components).map(([key, value]) => ({ label: ({ opening: '期初持仓价值', closing: '期末持仓价值', buys: '本期买入金额', sells: '本期卖出金额', incoming: '转入时价值', outgoing: '转出时价值', fees: '已扣费用还原', rewards: '奖励价值另列' } as Record<string, string>)[key], value }))} unit={unit} hidden={hidden} /> : <Unavailable hidden={hidden} reason={detail.spot.reason || '缺少完整期初、期末估值或买卖记录。'} />}<div className="returns-detail-total"><span>{t('本期资产盈亏')}</span><NativeAmount value={detail.spot.amount} unit={unit} hidden={hidden} /></div></>}
      {detail?.entries && <><div className="returns-detail-total"><span>{unit} {t('已记录合计')}{!hidden && valueRecordedEntries(detail.entries, unit).missing.length > 0 && <IssueHint message={valueRecordedEntries(detail.entries, unit).missing.map(entry => `${entry.asset}：缺少对应历史换算价，合计未包含此项。`).join('\n')} />}</span><NativeAmount value={returnTotal(valueRecordedEntries(detail.entries, unit).entries)} unit={unit} hidden={hidden} /></div><div className="records-table-scroll"><table className="records-table returns-detail-table"><thead><tr><th>{t('时间 / 账户')}</th><th>{t('项目 / 品种')}</th><th>{t('原币金额')}</th>{detailConverted && <th>{t('折合')} {unit}</th>}</tr></thead><tbody>{[...detail.entries].sort((a, b) => b.time - a.time).slice(0, 100).map(entry => <tr key={entry.id}><td>{stamp(entry.time)}<small>{entry.row.connectionName}</small></td><td data-label={t('项目')}>{categoryLabel(entry)}<small>{entry.row.symbol || '未指定品种'}</small></td><td data-label={t('原币金额')}><NativeAmount value={entry.amount} unit={entry.asset} hidden={hidden} /></td>{detailConverted && <td data-label={'折合 ' + unit}><NativeAmount value={valueRecordedEntries([entry], unit).entries[0]?.amount ?? null} unit={unit} hidden={hidden} /></td>}</tr>)}</tbody></table></div>{!detail.entries.length && <Empty>{t('所选期间尚无这一类记录')}</Empty>}{detail.entries.length > 100 && <span className="returns-panel-count">100 / {detail.entries.length} {t('条')}</span>}</>}
      <a className="returns-text-link" href="#transactions" onClick={() => setDetail(null)}>{t('查看交易记录')} <ArrowUpRight size={12} /></a>
      </div>
    </Modal>
    <ContractRoundModal selected={selectedRound} hidden={hidden} onClose={() => setRoundId('')} />
  </div>
}

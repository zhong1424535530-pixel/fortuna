import { fxLabel, startForexUpdates } from './data/forex'
import { startCnQuoteUpdates } from './data/cn-quotes'
import { dataMode, isReal, liveState, startLiveUpdates } from './data/live'
import * as liveReading from './data/live'
import type { AddAccountType, Connection } from './data/live-types'
import ConnectionDialog from './components/Connections'
import type { ManualAccount } from './data/workspace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MotionConfig, motion } from 'motion/react'
import {
  ArrowUpRight, ChevronDown, ChevronRight,
  LayoutDashboard,
  Menu, RefreshCw, Search, Settings2, ArrowDownUp, Tags,
  Wallet, X, Layers3, ChartNoAxesCombined, Coins, Banknote, Boxes, ReceiptText,
} from 'lucide-react'
import { Button, Panel, Avatar, Trend, Modal, SignedAmount, IssueHint, Unavailable } from './components/ui'
import { AllocationChart, HistoryChart, MajorHoldingsChart } from './components/Charts'
import { ContractExposureChart } from './components/Charts'
import { ContractDetail, ContractExposureBar, ContractsList, EquityBreakdown } from './components/Contracts'
import AccountsPage from './components/AccountsPage'
import AssetAccountFilter from './components/AssetAccountFilter'
import MarginRatios from './components/MarginRatios'
import Select from './components/Select'
import ReturnRangeFilter from './components/ReturnRangeFilter'
import { ClearFilters, FilterBar, FilterField, SearchField } from './components/FilterBar'
import { PeriodChange } from './components/PeriodChange'
import AssetManagerPage from './components/AssetManagerPage'
import AssetCosts from './components/AssetCosts'
import SettingsPage from './components/SettingsPage'
import { TransactionsPage, ReturnsPage } from './components/RecordsPages'
import {
  accounts, allocations, assetAccountGroups, categories, contracts, contractSummary,
  filterHoldings, formatMoney, formatHoldingPrice, formatPrice, formatQuantity, historyFor,
  holdingCostSummary, holdingQuantity, holdingValueCents, positionValueCents, sortedHoldings,
  totalValueCents, assetValueCents, awaitingLiveBalances, filterContracts, summarizeContracts, refreshPortfolio, personalBalance, monthlyRepayment,
} from './data/portfolio'
import type { Category, ContractDirection, ContractPosition, Currency, Holding, HoldingScope } from './data/portfolio'
import { calendarToday } from './data/return-range'
import { equityPoints, EQUITY_REFRESH_MS, syncEquityHistory } from './data/equity-history'
import { heldTodayPnl, todayPriceChange } from './data/daily-pnl'
import type { ReturnRange } from './data/return-range'
import { mergeHoldingRows, overviewSources } from './data/overview'
import Wordmark from './components/Wordmark'
import ProfileMenu from './components/ProfileMenu'
import { t, useLang } from './i18n'

type View = 'overview' | 'holdings' | 'assets/crypto' | 'assets/cn' | 'assets/us' | 'assets/contracts' | 'assets/other' | 'accounts' | 'transactions' | 'returns' | 'manage' | 'settings'
const pageNames: Record<View, string> = { overview: '资产总览', holdings: '全部持仓', 'assets/crypto': '加密资产', 'assets/cn': 'A股', 'assets/us': '美股', 'assets/contracts': '合约持仓', 'assets/other': '其他资产', accounts: '账户与钱包', transactions: '交易记录', returns: '收益分析', manage: '资产与价格', settings: '设置' }
const assetViews = ['assets/crypto', 'assets/cn', 'assets/us', 'assets/contracts', 'assets/other'] as const
// 其他资产页包含车、房等其他资产和手动记录的现金余额
const pageMarkets = (market: string) => market === 'other' ? ['other', 'cash'] : [market]
const summaryIcons = { 加密资产: Coins, 股票: ChartNoAxesCombined, 现金与稳定币: Banknote, 其他资产: Boxes }
function assetScope(view: View): HoldingScope { return view === 'assets/contracts' ? '合约' : '现货与股票' }
function routeFromHash(): View {
  const route = window.location.hash.slice(1)
  return Object.hasOwn(pageNames, route) ? route as View : 'overview'
}
const navigation = [
  { label: '资产总览', icon: LayoutDashboard, view: 'overview' },
  { label: '资产', icon: Layers3, view: 'assets' },
  { label: '账户与钱包', icon: Wallet, view: 'accounts' },
  { label: '交易记录', icon: ArrowDownUp, view: 'transactions' },
  { label: '收益分析', icon: ChartNoAxesCombined, view: 'returns' },
  { label: '资产与价格', icon: Tags, view: 'manage' },
] as const

function sourceNames(asset: Holding) {
  return [...new Set(asset.positions.map(position => accounts.find(account => account.id === position.accountId)?.name).filter(Boolean))] as string[]
}
const sourceLabel = (asset: Holding) => sourceNames(asset).join('、')

function HoldingsList({ items, currency, hidden, onSelect, compact = false, showSources = false }: { items: Holding[]; currency: Currency; hidden: boolean; onSelect: (asset: Holding) => void; compact?: boolean; showSources?: boolean }) {
  const today = calendarToday()
  const rows = items.map(asset => ({ asset, cost: holdingCostSummary(asset), changeToday: todayPriceChange(asset, accounts, today), pnlToday: heldTodayPnl([asset], accounts, today).pnlCents }))
  const missingValue = (asset: Holding) => <Unavailable hidden={hidden} reason={asset.fxPending ? '缺少有效汇率。' : '缺少有效价格，数量保留，未计入估值。'} />
  const value = (asset: Holding) => asset.usdPrice === null ? missingValue(asset) : formatMoney(holdingValueCents(asset), currency, hidden)
  const share = (asset: Holding) => hidden ? '—' : asset.usdPrice === null ? missingValue(asset) : assetValueCents <= 0 ? '—' : `${(holdingValueCents(asset) / assetValueCents * 100).toFixed(1)}%`
  const pnlReason = (cost: ReturnType<typeof holdingCostSummary>) => cost.costCents === null ? '成本未填齐，暂不计算盈亏。' : '缺少现价，暂不计算盈亏。'
  const todayCell = (pnlToday: number | null, changeToday: number | null) => <span className="holding-profit-value"><SignedAmount value={pnlToday} currency={currency} hidden={hidden} />{changeToday === null ? <small>—</small> : <Trend value={changeToday} hidden={hidden} />}</span>
  // 成本未填时整格只显示一个"—"；填了成本才显示均价和盈亏。
  const costCell = (cost: ReturnType<typeof holdingCostSummary>) => cost.averageUsdPrice === null ? <Unavailable hidden={hidden} reason={pnlReason(cost)} /> : <span className="holding-profit-value">
    <small className="numeric">{t('均价')} {formatPrice(cost.averageUsdPrice, currency, hidden)}</small>
    {cost.pnlCents === null ? <Unavailable hidden={hidden} reason={pnlReason(cost)} /> : <span className="holding-pnl-line"><SignedAmount value={cost.pnlCents} currency={currency} hidden={hidden} />{cost.pnlPercent !== null && <Trend value={cost.pnlPercent} hidden={hidden} />}</span>}
  </span>
  return <>
    <div className="table-scroll"><table className={`holdings-table spot-holdings-table ${compact ? 'compact-table' : ''}`}>
      <thead><tr><th>{t('资产')}</th><th className="quantity-column">{t('持有数量')}</th><th className="price-column">{t('价格')}</th><th>{t('持仓估值')}</th><th>{t('今日盈亏')}</th><th className="pnl-column">{t('成本 / 持仓盈亏')}</th><th className="allocation-column">{t('占比')}</th><th className="source-column">{t('存放位置')}</th><th><span className="sr-only">{t('详情')}</span></th></tr></thead>
      <tbody>{rows.map(({ asset, cost, changeToday, pnlToday }) => { const names = sourceNames(asset); return <tr key={asset.id}>
        <td><button type="button" className="asset-name-button" onClick={() => onSelect(asset)}><Avatar src={asset.icon} name={asset.symbol} company={asset.category === '股票'} /><span><strong title={asset.symbol}>{asset.symbol}</strong>{showSources && <small title={sourceLabel(asset)}>{sourceLabel(asset)}</small>}</span></button></td>
        <td className="quantity-column numeric muted">{formatQuantity(holdingQuantity(asset), hidden)}</td>
        <td className="price-column numeric" title={asset.priceUpdatedAt && !asset.manualPrice ? `行情时间：${new Date(asset.priceUpdatedAt).toLocaleString('zh-CN')}` : undefined}>{asset.usdPrice === null ? <Unavailable hidden={hidden} reason={t('尚未取得有效价格。')} /> : formatHoldingPrice(asset, currency, hidden)}</td>
        <td className="numeric value-cell">{value(asset)}</td>
        <td>{todayCell(pnlToday, changeToday)}</td>
        <td className="pnl-column">{costCell(cost)}</td>
        <td className="allocation-column"><div className="table-allocation"><span className="numeric">{share(asset)}</span><span className="tiny-track"><span style={{ width: `${hidden || asset.usdPrice === null || assetValueCents <= 0 ? 0 : Math.min(100, holdingValueCents(asset) / assetValueCents * 100)}%` }} /></span></div></td>
        <td className="source-column"><span className="source-label" title={names.join('、')}>{names[0] ?? '—'}{names.length > 1 && <small> +{names.length - 1}</small>}</span></td>
        <td><Button variant="ghost" className="row-action icon-button" aria-label={`查看 ${asset.symbol} 详情`} onClick={() => onSelect(asset)}><ChevronRight size={16} /></Button></td>
      </tr> })}</tbody>
    </table></div>
    <div className="mobile-holdings">{rows.map(({ asset, cost, changeToday, pnlToday }) => <button type="button" key={asset.id} className="mobile-holding" onClick={() => onSelect(asset)} aria-label={`查看${asset.symbol}持仓详情`}>
      <Avatar src={asset.icon} name={asset.symbol} company={asset.category === '股票'} />
      {/* 左右两列逐行对齐：左边名称、今日、盈亏，右边估值、均价、占比 */}
      <span className="mobile-holding-left">
        <span className="mobile-holding-name"><strong>{asset.symbol}</strong><span className="numeric">{formatQuantity(holdingQuantity(asset), hidden)}</span></span>
        <span>{t('今日')} <SignedAmount value={pnlToday} currency={currency} hidden={hidden} />{changeToday !== null && <Trend value={changeToday} hidden={hidden} />}</span>
        {cost.pnlCents !== null && <span>{t('盈亏')} <SignedAmount value={cost.pnlCents} currency={currency} hidden={hidden} />{cost.pnlPercent !== null && <Trend value={cost.pnlPercent} hidden={hidden} />}</span>}
        {showSources && <span>{sourceLabel(asset)}</span>}
      </span>
      <span className="mobile-holding-right">
        <strong className="numeric">{value(asset)}</strong>
        {cost.averageUsdPrice !== null && <span className="numeric">{t('均价')} {formatPrice(cost.averageUsdPrice, currency, hidden)}</span>}
        <span className="numeric">{share(asset)}</span>
      </span>
    </button>)}</div>
  </>
}

function HoldingDetail({ asset, currency, hidden, onClose }: { asset: Holding | null; currency: Currency; hidden: boolean; onClose: () => void }) {
  const [range, setRange] = useState<ReturnRange>({ period: '30天' })
  const [chartView, setChartView] = useState<'price' | 'value'>('price')
  useEffect(() => { setRange({ period: '30天' }); setChartView('price') }, [asset?.id])
  if (!asset) return null
  const chartPoints = isReal() ? equityPoints(chartView === 'price' ? { mode: 'asset-price', assetId: asset.id, period: range } : { mode: 'asset-value', assetId: asset.id, period: range }) : []
  return <Modal open onClose={onClose} title={`${asset.symbol} · 持仓详情`} className="holding-dialog">
    <div className="detail-asset"><Avatar src={asset.icon} name={asset.symbol} size={46} company={asset.category === '股票'} /><div><h3>{asset.name}</h3><span className="badge subtle">{asset.category}</span></div><span className="detail-asset-source">{asset.source}</span></div>
    <div className="detail-summary"><div><span>{t('持仓估值')}</span><strong className="numeric">{asset.usdPrice === null ? <Unavailable hidden={hidden} reason={asset.fxPending ? '缺少有效汇率。' : '缺少有效价格，数量保留，未计入估值。'} /> : formatMoney(holdingValueCents(asset), currency, hidden)}</strong></div><div><span>{t('持有数量')}</span><strong className="numeric">{formatQuantity(holdingQuantity(asset), hidden)} <small>{asset.category === '股票' && asset.id !== 'rappl' ? '股' : asset.symbol}</small></strong></div><div><span title={asset.priceUpdatedAt && !asset.manualPrice ? `行情时间：${new Date(asset.priceUpdatedAt).toLocaleString('zh-CN')}` : undefined}>{asset.manual || asset.manualPrice ? '填写单价' : '市场参考价'}</span><strong className="numeric">{asset.usdPrice === null ? <Unavailable hidden={hidden} reason={t('尚未取得有效价格。')} /> : formatHoldingPrice(asset, currency, hidden)}</strong></div></div>
    {asset.market !== 'cash' && <AssetCosts key={asset.id} asset={asset} currency={currency} hidden={hidden} />}
    <div className="detail-chart-heading"><div className="segmented"><button type="button" className={chartView === 'price' ? 'active' : ''} onClick={() => setChartView('price')}>{t('价格走势')}</button><button type="button" className={chartView === 'value' ? 'active' : ''} onClick={() => setChartView('value')}>{t('持仓金额变化')}</button></div><ReturnRangeFilter value={range} onChange={setRange} title={t('持仓走势时间范围')} /></div>
    <PeriodChange range={range} points={chartPoints} currency={currency} hidden={hidden} />
    <HistoryChart period={range.period} currency={currency} hidden={hidden} historyPoints={isReal() ? chartPoints : undefined} endValue={chartView === 'price' ? Math.round((asset.usdPrice ?? 0) * 100) : holdingValueCents(asset)} price={chartView === 'price'} />

    <div className="detail-locations"><h4>{t('存放位置')} <span>{asset.positions.length}</span></h4>{asset.positions.map(position => {
      const account = accounts.find(item => item.id === position.accountId)!
      return <div className="detail-location" key={position.accountId}><Avatar src={account.icon} name={account.name} size={26} /><span>{account.name}<small>{account.kind}{isReal() ? '' : ' · 示例账户'}</small></span><span className="numeric">{formatQuantity(position.quantity, hidden)}<small>{asset.usdPrice === null ? <Unavailable hidden={hidden} reason={asset.fxPending ? '缺少有效汇率。' : '缺少有效价格，数量保留，未计入估值。'} /> : formatMoney(positionValueCents(asset, position), currency, hidden)}</small></span></div>
    })}</div>

    
  </Modal>
}

export default function App() {
  const lang = useLang()
  const [view, setView] = useState<View>(routeFromHash)
  const [assetsExpanded, setAssetsExpanded] = useState(() => routeFromHash().startsWith('assets/'))
  const lastAssetView = useRef<View>(routeFromHash().startsWith('assets/') ? routeFromHash() : 'assets/crypto')
  const [revision, setRevision] = useState(0)
  const [currency, setCurrency] = useState<Currency>('USD')
  const [hidden, setHidden] = useState(false)
  const [netRange, setNetRange] = useState<ReturnRange>({ period: '30天' })
  const [category, setCategory] = useState<Category | '全部'>('全部')
  const [holdingsRange, setHoldingsRange] = useState<ReturnRange>({ period: '30天' })
  const [assetReturnRange, setAssetReturnRange] = useState<ReturnRange>({ period: '30天' })
  const [valuationDay, setValuationDay] = useState(calendarToday)
  const [accountFilter, setAccountFilter] = useState('全部')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<HoldingScope>(() => routeFromHash().startsWith('assets/') ? assetScope(routeFromHash()) : '全部')
  const [direction, setDirection] = useState<ContractDirection | '全部'>('全部')
  const [holdingGroupSelection, setHoldingGroupSelection] = useState<{ ids: string[]; accounts: string[] } | null>(null)
  const [accountSource, setAccountSource] = useState<string | null>(null)
  const [selectedAsset, setSelectedAsset] = useState<Holding | null>(null)
  const [selectedContract, setSelectedContract] = useState<ContractPosition | null>(null)
  const [connectionEditor, setConnectionEditor] = useState<Connection | ManualAccount | 'new' | null>(null)
  const [newConnectionType, setNewConnectionType] = useState<AddAccountType>('binance')
  const addConnection = (type: AddAccountType = 'binance') => { setNewConnectionType(type); setConnectionEditor('new') }
  const [mobileOpen, setMobileOpen] = useState(false)
  const [manageLiabilities, setManageLiabilities] = useState(false)
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const sidebarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const nextMidnight = Date.parse(valuationDay + 'T00:00:00+08:00') + 86400000
    const timer = window.setTimeout(() => setValuationDay(calendarToday()), Math.max(0, nextMidnight - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [valuationDay])

  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === '#history') window.history.replaceState(null, '', '#overview')
      const next = routeFromHash()
      setView(next)
      if (next.startsWith('assets/')) { setAssetsExpanded(true); lastAssetView.current = next; setScope(assetScope(next)); setCategory('全部'); setQuery(''); setAccountFilter('全部'); setDirection('全部') }
      setMobileOpen(false)
    }
    if (window.location.hash === '#history') onHash()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const onChange = () => setCompactNavigation(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    if (!mobileOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []).filter(button => button.offsetParent !== null)
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
      if (event.key === 'Tab') {
        const buttons = focusable()
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
      }
    }
    const desktop = window.matchMedia('(min-width: 768px)')
    const onResize = () => { if (desktop.matches) setMobileOpen(false) }
    document.addEventListener('keydown', onKey)
    desktop.addEventListener('change', onResize)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKey)
      desktop.removeEventListener('change', onResize)
      document.getElementById('mobile-menu-toggle')?.focus()
    }
  }, [mobileOpen])

  useEffect(() => {
    const update = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === 'profile') { setRevision(value => value + 1); return }
      refreshPortfolio(); setRevision(value => value + 1)
      if (event instanceof CustomEvent && ['market', 'market-status', 'balances', 'balance-status', 'fx'].includes(event.detail)) {
        setSelectedAsset(asset => asset ? filterHoldings('', '全部', asset.positions.map(position => position.accountId)).find(item => item.id === asset.id) ?? null : null)
        setSelectedContract(position => position ? filterContracts('', position.accountId).find(item => item.id === position.id) ?? null : null)
        return
      }
      if (!(event instanceof CustomEvent && event.detail === 'cost')) { setSelectedAsset(null); setSelectedContract(null); setAccountFilter('全部') }
    }
    window.addEventListener('portfolio-data-change', update)
    return () => window.removeEventListener('portfolio-data-change', update)
  }, [])
  useEffect(() => { void syncEquityHistory(); const historyTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void syncEquityHistory() }, EQUITY_REFRESH_MS); const stopLive = startLiveUpdates(), stopFx = startForexUpdates(), stopCn = startCnQuoteUpdates(); return () => { window.clearInterval(historyTimer); stopLive(); stopFx(); stopCn() } }, [])
  const navigate = useCallback((next: View) => {
    setAccountSource(null)
    if (next.startsWith('assets/')) { setAssetsExpanded(true); lastAssetView.current = next; setScope(assetScope(next)); setCategory('全部'); setQuery(''); setAccountFilter('全部'); setDirection('全部') }
    window.location.hash = next
    setView(next)
    setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])
  const selectCategory = useCallback((name: string) => {
    if (categories.includes(name as Category)) { setScope('现货与股票'); setCategory(name as Category); setDirection('全部'); setAccountFilter('全部'); setQuery(''); navigate('holdings') }
  }, [navigate])
  const assetSection = view.startsWith('assets/')
  const assetMarket = assetSection && view !== 'assets/contracts' ? view.slice(7) : null
  const contractPage = view === 'assets/contracts'
  const accountGroups = useMemo(() => assetAccountGroups(), [revision])
  const selectedAccounts = useMemo(() => assetSection && accountFilter !== '全部' ? accountGroups.find(group => group.id === accountFilter)?.accountIds ?? [] : accountFilter, [assetSection, accountFilter, accountGroups])
  const matchingItems = useMemo(() => filterHoldings(query, scope === '现货与股票' ? category : '全部', selectedAccounts).filter(asset => !assetMarket || pageMarkets(assetMarket).includes(asset.market)), [query, category, selectedAccounts, scope, assetMarket, revision])
  const items = useMemo(() => mergeHoldingRows(matchingItems), [matchingItems])
  const sources = useMemo(() => overviewSources(), [revision])
  const holdingGroup = sortedHoldings.filter(asset => holdingGroupSelection?.ids.includes(asset.id)).map(asset => ({ ...asset, positions: asset.positions.filter(position => holdingGroupSelection?.accounts.includes(position.accountId)) })).filter(asset => asset.positions.length)
  const contractItems = useMemo(() => filterContracts(query, selectedAccounts, direction), [query, selectedAccounts, direction, revision])
  const todayPnl = useMemo(() => assetMarket ? heldTodayPnl(matchingItems, accounts, valuationDay) : null, [matchingItems, assetMarket, revision, valuationDay])
  const overviewToday = useMemo(() => heldTodayPnl(sortedHoldings, accounts, valuationDay), [revision, valuationDay])
  // 总览只列出有估值或有持仓的分类，空分类不占卡片和图例位置。
  const shownAllocations = allocations.filter(item => item.valueCents > 0 || sortedHoldings.some(asset => asset.category === item.name))
  const selectedContractSummary = useMemo(() => summarizeContracts(contractItems), [contractItems])
  const trendAccountIds = accountFilter === '全部' ? undefined : Array.isArray(selectedAccounts) ? selectedAccounts : [accountFilter]
  const trendRange = assetSection ? assetReturnRange : holdingsRange
  const trendPoints = assetSection
    ? view === 'assets/contracts'
      ? []
      : equityPoints({ mode: 'market', market: pageMarkets(assetMarket ?? 'crypto'), accountIds: trendAccountIds, period: trendRange })
    : scope === '合约'
      ? equityPoints({ mode: 'pnl', accountIds: trendAccountIds, period: trendRange })
      : scope === '现货与股票'
        ? equityPoints({ mode: 'category', category: category === '全部' ? undefined : category, accountIds: trendAccountIds, period: trendRange })
        : equityPoints({ mode: 'gross', accountIds: trendAccountIds, period: trendRange })
  const demoPeriod = netRange.period === '1天' || netRange.period === '7天' || netRange.period === '30天' || netRange.period === '1年' ? netRange.period : '30天'
  const history = isReal() ? equityPoints({ mode: 'net', period: netRange }) : historyFor(demoPeriod)
  const filteredTotal = matchingItems.reduce((sum, asset) => sum + holdingValueCents(asset), 0)
  const visibleTotal = scope !== '合约' && matchingItems.some(asset => asset.fxPending) ? null : scope === '合约' ? selectedContractSummary.notionalCents : filteredTotal + (scope === '全部' ? selectedContractSummary.unrealizedPnlCents : 0)
  const hasResults = (scope !== '合约' && items.length > 0) || (scope !== '现货与股票' && contractItems.length > 0)
  const money = (value: number | null, decimals = 2) => awaitingLiveBalances() ? '—' : formatMoney(value, currency, hidden, decimals)
  const clearFilters = () => { setQuery(''); setCategory('全部'); setDirection('全部'); setAccountFilter('全部') }
  const hasActiveFilters = category !== '全部' || direction !== '全部' || accountFilter !== '全部' || Boolean(query)
  const openContracts = () => navigate('assets/contracts')
  const openLiabilities = () => { setManageLiabilities(true); navigate('manage') }
  const balance = personalBalance()
  const repayment = monthlyRepayment()
  const openHoldingGroup = useCallback((assets: Holding[]) => {
    setSelectedAsset(null)
    setHoldingGroupSelection({ ids: assets.map(asset => asset.id), accounts: [...new Set(assets.flatMap(asset => asset.positions.map(position => position.accountId)))] })
  }, [])
  const selectAsset = useCallback((asset: Holding) => { setSelectedContract(null); if (asset.members) openHoldingGroup(asset.members); else setSelectedAsset(asset) }, [openHoldingGroup])
  const selectContract = (position: ContractPosition) => { setSelectedAsset(null); setSelectedContract(position) }

  const currencyControl = <div className="currency-switch" role="group" aria-label={t('估值显示货币')}>{(['USD', 'CNY'] as Currency[]).map(item => <button type="button" key={item} className={currency === item ? 'active' : ''} aria-pressed={currency === item} onClick={() => setCurrency(item)}>{item === 'USD' ? '美元' : '人民币'}</button>)}</div>
  const displayControls = <div className="amount-display-controls">{currencyControl}</div>

  const holdingsFilters = <FilterBar className="holdings-filter-bar">
    <FilterField label={t('搜索')} wide><SearchField label={t('搜索币种、股票或合约')} value={query} onChange={setQuery} placeholder={contractPage ? '搜索合约' : '搜索资产或合约'} /></FilterField>
    {scope === '现货与股票' ? <FilterField label={t('类别')} fit><div className="category-tabs" role="group" aria-label={t('资产类别')}>{(assetMarket ? (assetMarket === 'crypto' ? ['全部', '加密资产', '现金与稳定币'] : ['全部']) : ['全部', ...categories]).map(item => <button type="button" key={item} className={category === item ? 'active' : ''} aria-pressed={category === item} onClick={() => setCategory(item as Category | '全部')}>{item}</button>)}</div></FilterField>
      : scope === '合约' ? <FilterField label={t('方向')} fit><div className="category-tabs" role="group" aria-label={t('合约方向')}>{(['全部', '做多', '做空'] as const).map(item => <button type="button" key={item} className={direction === item ? 'active' : ''} aria-pressed={direction === item} onClick={() => setDirection(item)}>{item === '全部' ? '全部方向' : item}</button>)}</div></FilterField>
        : null}
    <FilterField label={t('存放账户')}>{assetSection ? <AssetAccountFilter groups={accountGroups} value={accountFilter} onChange={setAccountFilter} /> : <Select label={t('筛选存放账户')} value={accountFilter} onChange={setAccountFilter} searchable options={[{ value: '全部', label: '全部账户', icon: <Layers3 size={18} /> }, ...accounts.map(account => ({ value: account.id, label: account.name, icon: account.icon }))]} />}</FilterField>
    {hasActiveFilters && <ClearFilters onClick={clearFilters} />}
  </FilterBar>

  return <MotionConfig reducedMotion="user">
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>{t('跳到主要内容')}</a>
    <div className="app-shell">
      {mobileOpen && <button type="button" className="mobile-scrim" aria-label={t('关闭导航菜单')} onClick={() => setMobileOpen(false)} />}
      <aside ref={sidebarRef} className={`sidebar ${mobileOpen ? 'is-open' : ''}`} aria-label={t('主导航')} inert={compactNavigation && !mobileOpen}>
        <div className="sidebar-identity"><div className="sidebar-brand"><Wordmark className="sidebar-wordmark" /></div><Button className="mobile-close icon-button" variant="ghost" onClick={() => setMobileOpen(false)} aria-label={t('关闭导航')}><X size={19} /></Button></div>
        <nav>{navigation.map(item => {
          const isGroup = item.view === 'assets'
          const active = isGroup ? assetSection : view === item.view
          return <div key={item.view}><button type="button" className={`nav-item ${active ? 'active' : ''}`} aria-current={!isGroup && active ? 'page' : undefined} aria-expanded={isGroup ? assetsExpanded : undefined} aria-controls={isGroup ? 'asset-navigation' : undefined} onClick={() => {
            if (isGroup) { if (assetSection) setAssetsExpanded(value => !value); else navigate(lastAssetView.current) }
            else navigate(item.view as View)
          }}><item.icon size={18} strokeWidth={1.6} /><span>{t(item.label)}</span>{isGroup ? <ChevronDown size={14} className={assetsExpanded ? 'rotate-180 nav-chevron' : 'nav-chevron'} /> : active && <span className="nav-marker" />}</button>
          {isGroup && <div id="asset-navigation" className="asset-subnav" hidden={!assetsExpanded}>{assetViews.map(assetView => <button type="button" key={assetView} className={view === assetView ? 'active' : ''} aria-current={view === assetView ? 'page' : undefined} onClick={() => navigate(assetView)}><span className="subnav-dot" />{t(pageNames[assetView])}</button>)}</div>}</div>
        })}</nav>
        <div className="sidebar-bottom"><button type="button" className={`nav-item ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 size={18} strokeWidth={1.6} />{t('设置')}</button></div>
      </aside>

      <div className="workspace" inert={mobileOpen}>
        <header className="topbar"><div className="topbar-leading"><Button id="mobile-menu-toggle" variant="ghost" className="mobile-menu icon-button" aria-label={t('打开导航菜单')} aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}><Menu size={20} /></Button><span className="breadcrumb"><span className="breadcrumb-root">{t('个人空间')}</span><ChevronRight size={13} /><strong>{t(pageNames[view])}</strong></span></div><ProfileMenu hidden={hidden} onToggleHidden={() => setHidden(value => !value)} onSettings={() => navigate('settings')} /></header>

        <main key={lang} id="main-content" className={`main-content${assetSection ? ' assets-page' : ''}${contractPage ? ' contracts-page' : ''}`} tabIndex={-1}>
          <div className="page-heading"><div><div className="page-title-row"><h1 id="page-heading" tabIndex={-1}>{t(pageNames[view])}</h1>{(liveReading.liveError || liveReading.balanceError || liveReading.marketError) && <IssueHint important message={[liveReading.liveError, liveReading.balanceError && '自动读取暂未成功，保留上次资料：' + liveReading.balanceError, liveReading.marketError && '行情更新暂未成功：' + liveReading.marketError].filter(Boolean).join('；')} />}{view === 'accounts' && <span className="accounts-title-display">{displayControls}</span>}</div></div>{view === 'accounts' && <div className="page-heading-actions">{!isReal() && <span className="date-label">{t('2026 年 10 月 17 日')} <span>{t('示例日期')}</span></span>}<Button onClick={() => addConnection()}>{t('添加账户')}</Button></div>}</div>

          {view === 'settings' ? <SettingsPage /> : view === 'accounts' ? <AccountsPage key={dataMode + (accountSource ?? '')} initialSourceId={accountSource} toolbarStart={displayControls} currency={currency} hidden={hidden} onSelectAsset={selectAsset} onSelectContract={selectContract} onEdit={setConnectionEditor} />
            : view === 'transactions' ? <TransactionsPage key={dataMode} hidden={hidden} />
            : view === 'returns' ? <ReturnsPage currency={currency} hidden={hidden} currencyControls={<div className="amount-display-controls">{currencyControl}</div>} />
            : view === 'manage' ? <AssetManagerPage key={dataMode} currency={currency} hidden={hidden} initialLiabilities={manageLiabilities} displayControls={displayControls} />
            : view === 'overview' ? <div>
            <motion.section className="hero-panel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .35 }}>
              <div className="hero-body">
              <div className="hero-main"><div className="hero-caption"><span>{t('已统计净资产估值')}{!hidden && sortedHoldings.some(asset => asset.usdPrice === null) && <IssueHint message={`${sortedHoldings.filter(asset => asset.usdPrice === null).length}项资产缺少有效价格或汇率，数量保留，未计入估值。`} />}</span>{displayControls}</div>
                <div className={`hero-value numeric ${hidden ? 'is-hidden' : ''}`}>{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : money(totalValueCents)}</div>
                <span className="asset-daily-pnl"><span>{t('今日盈亏')}{!hidden && overviewToday.missingCount > 0 && <IssueHint message={t('部分资产缺少今日参考价、未刷新或读取失败，当前金额未包含这些资产的价格变化。')} />}</span><SignedAmount value={overviewToday.pnlCents} currency={currency} hidden={hidden} /></span>
                <PeriodChange range={netRange} points={isReal() ? history : []} currency={currency} hidden={hidden} />
              </div>
              <div className="hero-trend">
                <div className="hero-trend-heading"><span>{t('净资产走势')}</span><ReturnRangeFilter value={netRange} onChange={setNetRange} title={t('净资产走势时间范围')} /></div>
                <HistoryChart period={netRange.period} currency={currency} hidden={hidden} compact historyPoints={isReal() ? history : undefined} />
              </div>
              </div>
              <div className="hero-toolbar"><div className="hero-status"><button type="button" className="hero-account-count" onClick={() => navigate('accounts')}><Wallet size={13} />{sources.length} {t('个账户')}<ChevronRight size={12} /></button></div><div className="hero-controls"><Button variant="ghost" className="icon-button" aria-label={t('查看账户')} onClick={() => navigate('accounts')}><RefreshCw size={15} /></Button></div></div>
            </motion.section>

            <div className="summary-grid">{shownAllocations.map((item, index) => {
              const Icon = summaryIcons[item.name]
              return <motion.button type="button" className="summary-card" key={item.name} onClick={() => selectCategory(item.name)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .04 * index, duration: .25 }}>
              <div className="summary-caption"><span className="summary-icon" style={{ color: item.color }} aria-hidden="true"><Icon size={18} strokeWidth={1.6} /></span><span>{item.name}{!hidden && sortedHoldings.some(asset => asset.category === item.name && asset.usdPrice === null) && <IssueHint message={t('此类资产存在缺少价格或汇率的持仓，金额只包含可估值部分。')} />}</span><ArrowUpRight size={14} /></div><div className="summary-value numeric">{money(item.valueCents)}</div><div className="summary-bottom"><span>{t('占比')} <strong className="numeric">{hidden || assetValueCents <= 0 ? '—' : `${(item.valueCents / assetValueCents * 100).toFixed(1)}%`}</strong></span></div>
            </motion.button>})}
              <motion.button type="button" className="summary-card" onClick={openContracts} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .2, duration: .25 }}>
                <div className="summary-caption"><span className="summary-icon summary-contract-icon" aria-hidden="true"><ArrowDownUp size={18} strokeWidth={1.6} /></span><span>{t('合约')}</span><ArrowUpRight size={14} /></div>
                <div className="summary-value numeric">{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : <SignedAmount value={contractSummary.pnlMissingCount ? null : contractSummary.unrealizedPnlCents} currency={currency} hidden={hidden} />}</div>
                <div className="summary-bottom"><span>{t('浮动盈亏 ·')} {hidden || awaitingLiveBalances() ? '—' : `${contracts.length} 笔持仓`}</span></div>
              </motion.button>
              <motion.button type="button" className="summary-card" onClick={openLiabilities} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .24, duration: .25 }}>
                <div className="summary-caption"><span className="summary-icon summary-liability-icon" aria-hidden="true"><ReceiptText size={18} strokeWidth={1.6} /></span><span>{t('总负债')}</span><ArrowUpRight size={14} /></div>
                <div className={`summary-value numeric ${balance.liabilitiesCents === 0 && !hidden ? 'summary-empty-value' : 'summary-debt-value'}`}>{balance.liabilitiesCents === 0 && !hidden ? '无负债' : formatMoney(balance.liabilitiesCents, currency, hidden)}</div>
                {repayment.count > 0 && <div className="summary-bottom"><span>{t('每月应还')} {formatMoney(repayment.cents, currency, hidden)}{!hidden && repayment.next && ` · ${repayment.next.date.getMonth() + 1}月${repayment.next.date.getDate()}日 ${repayment.next.name}`}</span></div>}
              </motion.button>
            </div>

            <div className="overview-allocation-grid">
              <Panel title={t('主要资产排行')} className="major-holdings-panel" action={<button type="button" className="text-action" onClick={() => { clearFilters(); setScope('全部'); navigate('holdings') }}>{t('全部持仓')}<ArrowUpRight size={13} /></button>}>
                <MajorHoldingsChart currency={currency} hidden={hidden} onSelect={assets => assets.length === 1 ? selectAsset(assets[0]) : openHoldingGroup(assets)} onViewAll={() => { clearFilters(); setScope('全部'); navigate('holdings') }} />
              </Panel>
              <Panel title={t('资产类别分布')}>
                <div className="allocation-body"><AllocationChart currency={currency} hidden={hidden} onSelect={selectCategory} /><div className="allocation-legend">{shownAllocations.map(item => <button type="button" key={item.name} onClick={() => selectCategory(item.name)}><span className="category-marker" style={{ backgroundColor: item.color }} /><span>{item.name}</span><strong className="numeric">{hidden || assetValueCents <= 0 ? '—' : `${(item.valueCents / assetValueCents * 100).toFixed(1)}%`}</strong><ChevronRight size={12} /></button>)}</div></div>
              </Panel>
            </div>

            <Panel title={t('资金放在哪里')} className="overview-sources-panel" action={<button type="button" className="text-action" onClick={() => navigate('accounts')}>{t('全部账户')}<ArrowUpRight size={13} /></button>}>
              <div className="platform-bars">{sources.map(source => <button type="button" key={source.id} className="platform-row" onClick={() => { navigate('accounts'); setAccountSource(accounts.find(account => source.accountIds.includes(account.id))?.sourceId ?? null) }}>
                <Avatar src={source.icon} name={source.name} size={27} />
                <span className="platform-data"><span className="platform-label"><strong title={source.name}>{source.name}</strong><span className="numeric">{source.unread ? <Unavailable hidden={hidden} reason={t('此来源尚未成功读取余额。')} /> : formatMoney(source.valueCents, currency, hidden)}</span></span><span className="platform-track" aria-hidden><span style={{ width: hidden || source.unread || assetValueCents <= 0 ? 0 : `${Math.min(100, source.valueCents / assetValueCents * 100)}%` }} /></span></span>
                <span className="platform-percent numeric">{hidden || source.unread || assetValueCents <= 0 ? '—' : `${(source.valueCents / assetValueCents * 100).toFixed(1)}%`}</span><ChevronRight size={13} />
              </button>)}{!sources.length && <div className="overview-sources-empty">{t('暂无已添加的账户')}</div>}</div>
            </Panel>
          </div> : <>
            {contractPage ? <>
              <Panel className="contract-page-filters">{holdingsFilters}</Panel>
              <Panel className="holdings-overview contract-pnl-overview">
                <div className="holdings-balance">
                  <div className="holdings-balance-caption"><span>{t('浮动盈亏')}</span>{displayControls}</div>
                  <strong className="numeric" title={t('按所选持仓最近读取的浮动盈亏汇总')}>{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : selectedContractSummary.pnlMissingCount ? <Unavailable hidden={hidden} reason={t('部分合约持仓缺少完整浮动盈亏。')} /> : <SignedAmount value={selectedContractSummary.unrealizedPnlCents} currency={currency} hidden={hidden} />}</strong>
                </div>
                <MarginRatios accounts={liveState.snapshot.accounts} contracts={liveState.snapshot.contracts} selectedIds={trendAccountIds} hidden={hidden} />
              </Panel>
              <div className="contract-position-metrics">
                <div><span>{t('仓位总金额')}</span><strong className="numeric">{!hidden && selectedContractSummary.priceMissingCount ? <Unavailable reason={t('部分仓位缺少有效标记价格，无法计算完整仓位金额。')} /> : money(selectedContractSummary.notionalCents)}</strong></div>
                <div><span>{t('已知占用保证金')}</span><strong className="numeric">{!hidden && selectedContractSummary.marginMissingCount && selectedContractSummary.marginMissingCount === contractItems.length ? <Unavailable reason={t('平台没有提供这些仓位可单独拆分的保证金。')} /> : money(selectedContractSummary.knownMarginCents)}</strong>{!hidden && selectedContractSummary.marginMissingCount > 0 && <IssueHint message={`${selectedContractSummary.marginMissingCount}笔持仓的保证金暂不能单独拆分，金额仅含已知部分。`} />}</div>
                <div><span>{t('持仓笔数')}</span><strong className="numeric">{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : hidden ? '••••••' : `${contractItems.length} 笔`}</strong></div>
              </div>
            </> : <Panel className="holdings-overview"><div className="holdings-balance">
              <div className="holdings-balance-caption"><span>{assetMarket ? '预估总资产' : scope === '合约' ? '合约仓位金额' : scope === '现货与股票' ? '筛选资产余额' : query.trim() ? '筛选余额与盈亏合计' : '所选账户资产净值'}</span>{displayControls}</div>
              <strong className="numeric">{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : scope === '合约' && selectedContractSummary.priceMissingCount ? <Unavailable hidden={hidden} reason={t('部分仓位缺少有效价格，无法完整估值。')} /> : money(visibleTotal)}</strong>
              {todayPnl ? <span className="asset-daily-pnl"><span>{t('今日盈亏')}{!hidden && todayPnl.missingCount > 0 && <IssueHint message={t('部分资产缺少今日参考价、未刷新或读取失败，金额只包含已有资料。')} />}</span><SignedAmount value={todayPnl.pnlCents} currency={currency} hidden={hidden} /></span> : <span>{scope !== '合约' && `${items.length} 项资产`}{scope === '全部' && <i />}{scope !== '现货与股票' && `${contractItems.length} 笔合约`}</span>}
              <PeriodChange range={trendRange} points={isReal() ? trendPoints : []} currency={currency} hidden={hidden} />

            </div><div className="holdings-trend">
              <div className="holdings-trend-heading"><div className="holdings-trend-title"><h2>{assetSection ? '资产走势' : '收益走势'}</h2></div><ReturnRangeFilter value={trendRange} onChange={assetSection ? setAssetReturnRange : setHoldingsRange} title={assetSection ? '资产走势时间范围' : '收益走势时间范围'} /></div>
              <HistoryChart period={trendRange.period} currency={currency} hidden={hidden} compact className="holdings-return-chart" historyPoints={isReal() ? trendPoints : undefined} />
            </div></Panel>}
            {!assetMarket && scope === '全部' && <EquityBreakdown pnlIncomplete={selectedContractSummary.pnlMissingCount > 0} assetsCents={filteredTotal} pnlCents={selectedContractSummary.unrealizedPnlCents} currency={currency} hidden={hidden} filtered={Boolean(query.trim())} />}
            <Panel className="holdings-panel full-holdings-panel">
              {!assetSection && <div className="holding-scope-tabs" role="group" aria-label={t('持仓查看范围')}>{(['全部', '现货与股票', '合约'] as const).map(item => <button type="button" key={item} className={scope === item ? 'active' : ''} aria-pressed={scope === item} onClick={() => { setScope(item); setCategory('全部'); setDirection('全部') }}>{item}{item === '合约' && <Layers3 size={13} />}</button>)}</div>}
              {!contractPage && holdingsFilters}
              {scope !== '合约' && items.length > 0 && <>
                <div className="holding-group-heading"><div><h2>{assetMarket ? t(pageNames[view]) : '资产余额与股票'} <span>{items.length} {t('项')}</span></h2></div></div>
                <HoldingsList items={items} currency={currency} hidden={hidden} onSelect={selectAsset} />
              </>}
              {!assetMarket && scope !== '现货与股票' && contractItems.length > 0 && <>
                <div className="holding-group-heading"><div><h2>{t('合约持仓')} <span>{hidden && contractPage ? '—' : `${contractItems.length} 笔`}</span></h2></div>{!contractPage && <div className="group-pnl"><small>{t('浮动盈亏')}</small><SignedAmount value={selectedContractSummary.pnlMissingCount ? null : selectedContractSummary.unrealizedPnlCents} currency={currency} hidden={hidden} /></div>}</div>
                {contractPage ? <ContractExposureBar items={contractItems} currency={currency} hidden={hidden} /> : scope === '合约' && <div className="contract-filter-overview"><div><span>{t('已知占用保证金')}</span><strong className="numeric">{money(selectedContractSummary.knownMarginCents)}</strong>{selectedContractSummary.marginMissingCount > 0 && <IssueHint message={`${selectedContractSummary.marginMissingCount}笔持仓的保证金暂不能单独拆分，金额仅含已知部分。`} />}</div><ContractExposureChart items={contractItems} currency={currency} hidden={hidden} /></div>}
                <ContractsList items={contractItems} currency={currency} hidden={hidden} onSelect={selectContract} />
              </>}
              {!hasResults && <div className="empty-state"><Search size={25} strokeWidth={1.3} /><h3>{t('没有符合显示条件的持仓')}</h3>{hasActiveFilters && <Button onClick={clearFilters}>{t('清除筛选')}</Button>}</div>}

            </Panel>
          </>}

          {!assetSection && view !== 'accounts' && <footer className="page-footer"><span>{fxLabel()}</span></footer>}
        </main>
      </div>
    </div>

    {connectionEditor && <ConnectionDialog key={connectionEditor === 'new' ? 'new' : connectionEditor.id} connection={connectionEditor !== 'new' && 'type' in connectionEditor ? connectionEditor : undefined} manualAccount={connectionEditor !== 'new' && !('type' in connectionEditor) ? connectionEditor : undefined} initialType={newConnectionType} onClose={() => setConnectionEditor(null)} />}
    <Modal open={holdingGroup.length > 0} onClose={() => setHoldingGroupSelection(null)} title={`${holdingGroup[0]?.symbol ?? ''} · 持仓明细`}>
      <HoldingsList items={holdingGroup} currency={currency} hidden={hidden} onSelect={asset => { setHoldingGroupSelection(null); selectAsset(asset) }} showSources />
    </Modal>
    <HoldingDetail asset={selectedAsset} currency={currency} hidden={hidden} onClose={() => setSelectedAsset(null)} />
    {selectedContract && <ContractDetail key={selectedContract.id} position={selectedContract} currency={currency} hidden={hidden} onClose={() => setSelectedContract(null)} />}
  </MotionConfig>
}

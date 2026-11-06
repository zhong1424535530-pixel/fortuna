import { isReal, liveState } from './live.ts'
import type { DayOpenPrice, LiveAccount, LiveSnapshot } from './live-types.ts'
import { walletFamilies } from './live-types.ts'
import { monthlyDue, nextDueDate } from './loan-repayment.ts'
import { commitWorkspace, liabilityKinds, validateWorkspace, workspace } from './workspace.ts'
import type { AssetMarket, Liability, WorkspaceData } from './workspace.ts'
import { automaticAssetIcon } from './asset-icons.ts'
import Decimal from 'decimal.js'
import { dedupeNativeHoldings } from './asset-identity.ts'
import { toUsd, usdCny } from './forex.ts'
import { cnQuotes, quoteKey } from './cn-quotes.ts'
import { calendarToday } from './return-range.ts'
import type { ContractExitOrder } from './contract-protection.ts'
export type { AssetMarket } from './workspace.ts'

export type Currency = 'USD' | 'CNY'
export type Category = '加密资产' | '股票' | '现金与稳定币' | '其他资产'
export type Period = '1天' | '7天' | '30天' | '1年'
export type HoldingScope = '全部' | '现货与股票' | '合约'
export type ContractDirection = '做多' | '做空'
export type HistoryPoint = { label: string; valueCents: number }
export const sourceGroups = ['交易所', '链上钱包', '券商', '手动账户'] as const

export const DEMO_DATE = '2026-10-17'
export const periods: Period[] = ['1天', '7天', '30天', '1年']
export const categories: Category[] = ['加密资产', '股票', '现金与稳定币', '其他资产']
export const categoryColors: Record<Category, string> = {
  加密资产: '#ff9f0a', 股票: '#5e5ce6', 现金与稳定币: '#0a84ff', 其他资产: '#bf5af2', // 苹果系统色

}

export type AccountId = string
export type Account = { id: AccountId; sourceId: string; name: string; kind: string; icon: string; color: string } & Partial<Omit<LiveAccount, 'id' | 'sourceId' | 'name' | 'kind' | 'icon' | 'color'>>
function buildAccounts(data: WorkspaceData = workspace, catalog: LiveSnapshot = liveState.snapshot, all = false): Account[] {
  const seeds: Account[] = [...catalog.accounts, ...(data.manualAccounts ?? []).map(account => ({ ...account, sourceId: account.id, kind: '手动账户', icon: account.icon ?? '', color: '#b5a1bf', status: 'ok' as const, pnlCents: 0 }))]
  if (all) for (const asset of data.manualAssets) if (isLiveAccount(asset.accountId) && !seeds.some(account => account.id === asset.accountId)) seeds.push({ id: asset.accountId, sourceId: asset.accountId, name: '已移除的账户', kind: '交易所', icon: '', color: '#91ad9c' })
  return [...seeds, ...(data.manualAssets.some(asset => asset.accountId === 'manual') ? [{ id: 'manual' as const, sourceId: 'manual', name: '手动账户', kind: '手动账户', icon: '', color: '#91ad9c' }] : [])]
}
export let accounts = buildAccounts()
export function countOriginalAccounts(items: Account[] = accounts) { return new Set(items.map(account => account.sourceId + ':' + (account.originName ?? account.id))).size }
export type AssetSource = {
  id: string
  name: string
  group: (typeof sourceGroups)[number]
  icon: string
  accountIds: AccountId[]
  valueCents: number
  incomplete?: boolean
  updatedAt?: string | null
}
export type AssetAccountGroup = Pick<AssetSource, 'id' | 'name' | 'icon' | 'accountIds'>
export function assetAccountGroups(accountList = accounts, connections = liveState.connections): AssetAccountGroup[] {
  const groups: AssetAccountGroup[] = []
  for (const account of accountList) {
    const connection = connections.find(item => 'live-' + item.id === account.sourceId)
    const address = connection?.type === 'wallet' ? connection.address ?? account.address : account.kind === '钱包' ? account.address : undefined
    const id = address ? 'wallet:' + (address.toLowerCase().startsWith('0x') ? address.toLowerCase() : address) : account.sourceId
    const existing = groups.find(group => group.id === id)
    if (existing) existing.accountIds.push(account.id)
    else groups.push({ id, name: connection?.name ?? account.name, icon: connection?.type === 'binance' ? '/icons/binance.svg' : account.icon, accountIds: [account.id] })
  }
  return groups
}
export type Position = { accountId: AccountId; quantity: number; quantityText?: string; valueCents?: number | null }
export type ContractPosition = {
  id: string
  symbol: string
  name: string
  icon: string
  accountId: AccountId
  direction: ContractDirection
  quantity: number
  baseAsset: string
  entryPriceUsd: number | null
  markPriceUsd: number | null
  priceUpdatedAt?: string
  leverage: number | null
  marginMode: '逐仓' | '全仓' | '组合保证金' | '未知'
  marginCents: number | null
  liquidationPriceUsd: number | null
  unrealizedPnlCents: number | null
  exitOrders?: ContractExitOrder[] | null
}
export type Holding = {
  members?: Holding[]
  id: string
  symbol: string
  name: string
  category: Category
  market: AssetMarket
  usdPrice: number | null
  priceUpdatedAt?: string
  dayOpen?: DayOpenPrice
  change24h: number | null
  manual?: boolean
  manualPrice?: boolean
  fxPending?: boolean
  icon: string
  color: string
  source: string
  description: string
  positions: Position[]
}

// 今日涨跌按昨收计算；只在行情时间是当天时有效，周末显示为暂无。
function cnQuoteFields(quote: { prevClose: number; at: number }, rate: number | null) {
  const date = calendarToday(new Date(quote.at)), prev = toUsd(quote.prevClose, 'CNY', rate)
  return { priceUpdatedAt: new Date(quote.at).toISOString(), ...(prev ? { dayOpen: { date, usdPrice: prev, at: Date.parse(date + 'T00:00:00+08:00') / 1000 } } : {}) }
}

function buildHoldings(accountList = accounts, data: WorkspaceData = workspace, strict = false, catalog: LiveSnapshot = liveState.snapshot, rate = usdCny()): Holding[] {
  const seeds: Holding[] = dedupeNativeHoldings(catalog.holdings)
  const assets = seeds.map(asset => ({ ...asset, positions: asset.positions.map(position => ({ ...position })) }))
  for (const entry of data.manualAssets) {
    if (!accountList.some(account => account.id === entry.accountId)) { if (strict) throw new Error('手动资产对应的账户不存在，请重新选择。'); continue }
    const key = quoteKey(entry), quote = key ? cnQuotes[key] : undefined, isCn = entry.market === 'cn'
    // 手动加密资产没填价格时，跟随已接入账户里同代码币种的行情。
    const followed = entry.market === 'crypto' && entry.price === null ? seeds.find(seed => seed.market === 'crypto' && seed.usdPrice !== null && seed.symbol.toUpperCase() === entry.symbol.toUpperCase()) : undefined
    assets.push({ id: entry.id, symbol: entry.symbol, name: isCn ? quote?.name || entry.name : entry.name, market: entry.market, category: entry.market === 'cash' ? '现金与稳定币' : entry.market === 'crypto' ? '加密资产' : entry.market === 'other' ? '其他资产' : '股票', usdPrice: quote ? toUsd(quote.price, isCn ? 'CNY' : 'USD', rate) : followed ? followed.usdPrice : toUsd(entry.price, entry.currency, rate), fxPending: quote ? isCn && rate === null : followed ? false : entry.price !== null && entry.price > 0 && entry.currency === 'CNY' && rate === null, change24h: null, icon: entry.icon, color: '#91ad9c', source: followed ? '跟随已接入行情' : '本机手动录入', description: quote ? (isCn ? 'A股自动行情（东方财富，腾讯备用），约每分钟更新。' : '美股自动行情（腾讯），约每分钟更新；非交易时段为最近收盘价。') : followed ? '没有填写价格，跟随已接入账户中同代码币种的行情。' : `手动资料 · ${entry.updatedAt}。人工填写的资产，不自动获取历史行情。`, manual: true, ...(quote ? isCn ? cnQuoteFields(quote, rate) : { priceUpdatedAt: new Date(quote.at).toISOString() } : followed?.priceUpdatedAt ? { priceUpdatedAt: followed.priceUpdatedAt } : {}), positions: [{ accountId: entry.accountId as AccountId, quantity: entry.quantity }] })
  }
  return assets.map(asset => {
    const custom = data.customizations[asset.id]
    // 此前A股固定自动行情，改价入口是关闭的；放开前遗留的手动价继续不生效，之后的手动改价才生效。
    const override = custom?.mode === 'manual' && asset.market === 'cn' && (custom.priceUpdatedAt ?? custom.updatedAt) < CN_MANUAL_PRICE_SINCE ? { ...custom, mode: 'auto' as const } : custom
    const usdPrice = override?.mode === 'manual' ? toUsd(override.price, override.currency, rate) : asset.usdPrice
    const safePrice = usdPrice !== null && !Number.isSafeInteger(Math.round(holdingQuantity(asset) * usdPrice * 100)) ? null : usdPrice
    const fxPending = override?.mode === 'manual' ? override.price !== null && override.price > 0 && override.currency === 'CNY' && rate === null : asset.fxPending
    if (strict && safePrice !== usdPrice) throw new Error('数量与价格乘积过大，无法准确保存，请核对后再试。')
    return { ...asset, fxPending, icon: override?.icon !== undefined ? override.icon : automaticAssetIcon(asset), ...(override?.mode === 'manual' ? { positions: asset.positions.map(position => ({ accountId: position.accountId, quantity: position.quantity, quantityText: position.quantityText })) } : {}), usdPrice: safePrice, ...(override?.mode === 'manual' ? { manualPrice: true, change24h: null, source: '本机手动定价' } : {}) }
  })
}
export let holdings = buildHoldings()
export function awaitingLiveBalances() { return isReal() && liveState.connections.length > 0 && !liveState.snapshot.accounts.some(account => account.updatedAt) && !holdings.some(asset => asset.manual) }
export function hasLocalValuation() { return isReal() || holdings.some(asset => asset.manual || asset.manualPrice) || (workspace.liabilities?.length ?? 0) > 0 }

// 价格能否自动：加密资产、美股、A股有行情，可手动覆盖；房产、车辆等其他资产只能手填；现金固定 1:1。全项目都问这里。
const CN_MANUAL_PRICE_SINCE = '2026-10-29T00:00:00.000Z'
export const supportsAutoPrice = (market: AssetMarket) => market === 'crypto' || market === 'us' || market === 'cn'
export const assetMarkets: { id: AssetMarket; label: string }[] = [{ id: 'crypto', label: '加密资产' }, { id: 'cn', label: 'A股' }, { id: 'us', label: '美股' }]
export function holdingsByMarket(market: AssetMarket) { return sortedHoldings.filter(asset => asset.market === market) }

function buildContracts() { return liveState.snapshot.contracts.map(position => {
  const icon = automaticAssetIcon({ ...position, market: 'crypto' })
  // 图标识别修正后换地址，让之前显示占位的图片重新加载。
  return { ...position, icon: icon.startsWith('/api/asset-icon?') ? icon + '&v=contracts-3' : icon }
}) }
export let contracts: ContractPosition[] = buildContracts()

export function contractValueCents(position: ContractPosition) {
  return position.markPriceUsd === null ? 0 : Math.round(position.quantity * position.markPriceUsd * 100)
}

export function summarizeContracts(items: ContractPosition[]) {
  return items.reduce((sum, position) => {
    const value = contractValueCents(position)
    sum.notionalCents += value
    if (position.direction === '做多') sum.longNotionalCents += value
    else sum.shortNotionalCents += value
    sum.unrealizedPnlCents += position.unrealizedPnlCents ?? 0
    if (position.unrealizedPnlCents === null) sum.pnlMissingCount++
    if (position.markPriceUsd === null) sum.priceMissingCount++
    if (position.marginCents === null) sum.marginMissingCount += 1
    else sum.knownMarginCents += position.marginCents
    return sum
  }, { notionalCents: 0, longNotionalCents: 0, shortNotionalCents: 0, unrealizedPnlCents: 0, knownMarginCents: 0, marginMissingCount: 0, pnlMissingCount: 0, priceMissingCount: 0 })
}

export function filterContracts(query: string, accountId: string | readonly string[] = '全部', direction: ContractDirection | '全部' = '全部') {
  const term = query.trim().toLocaleLowerCase()
  return contracts.filter(position => (
    (accountId === '全部' || (typeof accountId === 'string' ? position.accountId === accountId : accountId.includes(position.accountId)))
    && (direction === '全部' || position.direction === direction)
    && (!term || `${position.symbol} ${position.name} ${position.baseAsset}`.toLocaleLowerCase().includes(term))
  )).sort((a, b) => contractValueCents(b) - contractValueCents(a))
}

// 接入余额优先使用服务端精确计算并保存的分币估值，人工资料沿用本机计算。
export function positionValueCents(holding: Holding, position: Position) {
  return holding.usdPrice === null ? 0 : position.valueCents != null ? position.valueCents : Math.round(holding.usdPrice * position.quantity * 100)
}

export function holdingValueCents(holding: Holding): number {
  if (holding.members) return holding.members.reduce((sum, member) => sum + holdingValueCents(member), 0)
  return holding.positions.reduce((sum, position) => sum + positionValueCents(holding, position), 0)
}

export function holdingQuantity(holding: Holding): number {
  if (holding.members) return holding.members.flatMap(member => member.positions).reduce((sum, position) => sum.plus(position.quantityText ?? position.quantity), new Decimal(0)).toNumber()
  return holding.positions.reduce((sum, position) => sum + position.quantity, 0)
}

export function positionCostBasis(asset: Holding, position: Position, data: WorkspaceData = workspace) {
  const entry = data.costs?.[asset.id]?.[position.accountId]
  // shortcut: 数量变动先要求重填，接入完整流水后再自动结转剩余成本。
  return entry && entry.quantity === position.quantity ? entry : null
}

export function holdingCostSummary(asset: Holding, data: WorkspaceData = workspace, rate = usdCny()): { costCents: number | null; missingCount: number; pendingFx: boolean; feeIncluded: boolean; averageUsdPrice: number | null; pnlCents: number | null; pnlPercent: number | null } {
  if (asset.members) {
    const entries = asset.members.map(member => ({ member, cost: holdingCostSummary(member, data, rate) }))
    const missingCount = entries.reduce((sum, entry) => sum + entry.cost.missingCount, 0)
    const total = entries.reduce((sum, entry) => sum + (entry.cost.costCents ?? 0), 0)
    const costCents = entries.some(entry => entry.cost.costCents === null) || !Number.isSafeInteger(total) ? null : total
    const quantity = holdingQuantity(asset)
    const costUsd = entries.reduce((sum, entry) => sum.plus(new Decimal(entry.cost.averageUsdPrice ?? 0).mul(holdingQuantity(entry.member))), new Decimal(0))
    const pnlCents = costCents === null || asset.usdPrice === null ? null : holdingValueCents(asset) - costCents
    return { costCents, missingCount, pendingFx: entries.some(entry => entry.cost.pendingFx), feeIncluded: costCents !== null && entries.every(entry => entry.cost.feeIncluded), averageUsdPrice: costCents === null || quantity === 0 ? null : costUsd.div(quantity).toNumber(), pnlCents, pnlPercent: pnlCents === null || !costCents ? null : pnlCents / costCents * 100 }
  }
  let knownCents = 0, knownUsd = 0, missingCount = 0, feeIncluded = true, pendingFx = false
  for (const position of asset.positions) {
    const entry = positionCostBasis(asset, position, data)
    if (!entry) { missingCount++; continue }
    const unit = toUsd(entry.averagePrice, entry.currency, rate)
    if (unit === null) { pendingFx = true; continue }
    const usd = unit * position.quantity
    knownCents += Math.round(usd * 100)
    knownUsd += usd
    if (!entry.feeIncluded) feeIncluded = false
  }
  const costCents = missingCount || pendingFx || !asset.positions.length || !Number.isSafeInteger(knownCents) ? null : knownCents
  const quantity = holdingQuantity(asset)
  const pnlCents = costCents === null || asset.usdPrice === null ? null : holdingValueCents(asset) - costCents
  return {
    costCents, missingCount, pendingFx, feeIncluded: costCents !== null && feeIncluded,
    averageUsdPrice: costCents === null || quantity === 0 ? null : knownUsd / quantity,
    pnlCents,
    pnlPercent: pnlCents === null || costCents === null || costCents <= 0 ? null : pnlCents / costCents * 100,
  }
}

export let assetValueCents = holdings.reduce((sum, holding) => sum + holdingValueCents(holding), 0)
function currentContractSummary() { const result = summarizeContracts(contracts); if (isReal()) result.unrealizedPnlCents = liveState.snapshot.accounts.reduce((sum, account) => sum + (account.pnlCents ?? 0), 0); if (isReal()) result.pnlMissingCount = liveState.snapshot.accounts.filter(account => account.pnlCents === null).length; return result }
export let contractSummary = currentContractSummary()
export function liabilityValueCents(debt: Liability, rate = usdCny()): number | null { const amount = toUsd(debt.amount, debt.currency, rate); return debt.settled ? 0 : amount === null ? null : Math.round(amount * 100) }
// 每月应还合计（各笔「下一期」之和，折成美元分）与最近的还款日；汇率缺失时合计为 null。
export function monthlyRepayment(data: WorkspaceData = workspace, rate = usdCny(), today = new Date()) {
  const plans = (data.liabilities ?? []).flatMap(debt => debt.repayment && !debt.settled && debt.amount > 0 ? [{ debt, due: monthlyDue(debt.amount, debt.repayment), next: nextDueDate(debt.repayment.day, today) }] : [])
  const values = plans.map(({ debt, due }) => toUsd(due.first, debt.currency, rate))
  const next = plans.reduce<{ date: Date; name: string } | null>((best, plan) => !best || plan.next < best.date ? { date: plan.next, name: plan.debt.name } : best, null)
  return { count: plans.length, cents: values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + Math.round(value! * 100), 0), next }
}
export function personalBalance(data: WorkspaceData = workspace, assetsCents = assetValueCents, pnlCents = contractSummary.unrealizedPnlCents, rate = usdCny()) {
  const debts = data.liabilities ?? []
  const groups = liabilityKinds.map(kind => {
    const values = debts.filter(debt => debt.kind === kind).map(debt => liabilityValueCents(debt, rate))
    return { kind, valueCents: values.reduce<number>((sum, value) => sum + (value ?? 0), 0), missing: values.some(value => value === null) }
  })
  const liabilitiesCents = groups.some(group => group.missing) ? null : groups.reduce((sum, group) => sum + group.valueCents, 0)
  const pendingAssets = rate === null && [...data.manualAssets, ...liveState.snapshot.holdings].some(asset => {
    const override = data.customizations[asset.id]
    const price = override?.mode === 'manual' ? override : 'currency' in asset ? asset : null
    const quantity = 'quantity' in asset ? asset.quantity : holdingQuantity(asset)
    return price?.currency === 'CNY' && price.price !== null && price.price > 0 && quantity > 0
  })
  const grossCents = pendingAssets ? null : assetsCents + pnlCents
  return { grossCents, liabilitiesCents, netCents: liabilitiesCents === null || grossCents === null ? null : grossCents - liabilitiesCents, pendingFx: liabilitiesCents === null || pendingAssets, groups, activeCount: debts.filter(debt => !debt.settled && debt.amount > 0).length }
}
export let grossValueCents = personalBalance().grossCents
export let totalValueCents = personalBalance().netCents
export let sortedHoldings = [...holdings].sort((a, b) => holdingValueCents(b) - holdingValueCents(a))
function calculateAllocations() { return categories.map(name => ({
  name,
  valueCents: holdings.filter(holding => holding.category === name).reduce((sum, holding) => sum + holdingValueCents(holding), 0),
  color: categoryColors[name],
})) }
export let allocations = calculateAllocations()
function calculateBalances() { return accounts.map(account => {
  const assetsCents = holdings.reduce((sum, holding) => sum + holding.positions.filter(position => position.accountId === account.id).reduce((subtotal, position) => subtotal + positionValueCents(holding, position), 0), 0)
  const pnlCents = account.pnlCents === null ? 0 : account.pnlCents ?? summarizeContracts(filterContracts('', account.id)).unrealizedPnlCents
  return { ...account, assetsCents, pnlCents, pnlIncomplete: account.pnlCents === null, valueCents: assetsCents + pnlCents }
}).sort((a, b) => b.valueCents - a.valueCents) }
export let accountBalances = calculateBalances()

function calculateSources() { return accounts.reduce<AssetSource[]>((sources, account) => {
  let source = sources.find(item => item.id === account.sourceId)
  if (!source) {
    const primary = accounts.find(item => item.id === account.sourceId) ?? account
    const connection = liveState.connections.find(item => 'live-' + item.id === account.sourceId)
    source = { id: account.sourceId, name: isReal() ? connection?.name ?? primary.name : primary.name, group: primary.kind === '钱包' ? '链上钱包' : primary.kind === '券商' ? '券商' : primary.kind === '手动账户' ? '手动账户' : '交易所', icon: connection?.type === 'wallet' ? walletFamilies.find(item => item.id === (connection.walletFamily ?? 'evm'))!.icon : primary.icon, accountIds: [], valueCents: 0 }
    sources.push(source)
  }
  source.accountIds.push(account.id)
  if (account.status && account.status !== 'ok') source.incomplete = true
  if (liveState.connections.find(item => 'live-' + item.id === account.sourceId)?.status !== 'ok' && account.sourceId.startsWith('live-')) source.incomplete = true
  if (account.updatedAt && (!source.updatedAt || account.updatedAt > source.updatedAt)) source.updatedAt = account.updatedAt
  source.valueCents += accountBalances.find(item => item.id === account.id)!.valueCents
  return sources
}, []) }
export let assetSources = calculateSources()
// 后缀由各平台读取器生成（spot、usdm、unified、trading、funding、各链名等），不再逐个列举，避免新增平台后把整份资料误判为损坏。
const isLiveAccount = (id: string) => /^live-[0-9a-f-]{36}-[a-z][a-z-]{1,19}$/.test(id)
export function assertWorkspacePortfolio(next: WorkspaceData, catalog: LiveSnapshot = liveState.snapshot) {
  if (!validateWorkspace(next)) throw new Error('资料不完整或金额过大，请核对数量、价格及成本后再保存。')
  // 保存检查按原币金额的上限核对，不能因汇率断网把已有人工资料误报为损坏。
  const nextHoldings = buildHoldings(buildAccounts(next, catalog, true), next, true, catalog, 1)
  const value = nextHoldings.reduce((sum, asset) => sum + holdingValueCents(asset), 0)
  const balance = personalBalance(next, value, 0, 1)
  if (![value, balance.grossCents, balance.liabilitiesCents, balance.netCents].every(Number.isSafeInteger)) throw new Error('合计金额过大，无法准确保存，请核对后再试。')
  for (const asset of next.manualAssets.filter(asset => asset.market === 'cash')) {
    const override = next.customizations[asset.id]
    if (override?.mode === 'manual' && (override.price !== 1 || override.currency !== asset.currency)) throw new Error('现金余额的单位价值固定为对应货币1元，请修改余额数量。')
  }
  for (const [assetId, entries] of Object.entries(next.costs ?? {})) {
    const asset = nextHoldings.find(item => item.id === assetId)
    if (Object.keys(entries).some(accountId => !isLiveAccount(accountId) && !asset?.positions.some(position => position.accountId === accountId))) throw new Error('成本对应的资产或账户不存在，请重新选择。')
    if (!asset) continue
    const cost = holdingCostSummary(asset, next, 1)
    if (cost.pnlCents !== null && !Number.isSafeInteger(cost.pnlCents)) throw new Error('成本与盈亏金额过大，无法准确保存，请核对后再试。')
  }
}
export function savePortfolioWorkspace(next: WorkspaceData, change: 'valuation' | 'cost' = 'valuation') { assertWorkspacePortfolio(next); return commitWorkspace(next, change) }
export function refreshPortfolio() {
  accounts = buildAccounts()
  holdings = buildHoldings()
  contracts = buildContracts()
  contractSummary = currentContractSummary()
  assetValueCents = holdings.reduce((sum, asset) => sum + holdingValueCents(asset), 0)
  const balance = personalBalance()
  grossValueCents = balance.grossCents
  totalValueCents = balance.netCents
  sortedHoldings = [...holdings].sort((a, b) => holdingValueCents(b) - holdingValueCents(a))
  allocations = calculateAllocations()
  accountBalances = calculateBalances()
  assetSources = calculateSources()
}

export function filterHoldings(query: string, category: Category | '全部', accountId: string | readonly string[] = '全部') {
  const term = query.trim().toLocaleLowerCase()
  return holdings.map(holding => accountId === '全部' ? holding : {
    ...holding,
    positions: holding.positions.filter(position => typeof accountId === 'string' ? position.accountId === accountId : accountId.includes(position.accountId)),
  }).filter(holding => (
    holding.positions.length > 0
    &&
    (category === '全部' || holding.category === category)
    && (!term || `${holding.symbol} ${holding.name}`.toLocaleLowerCase().includes(term))
  )).sort((a, b) => holdingValueCents(b) - holdingValueCents(a))
}

export function formatMoney(cents: number | null, currency: Currency, hidden = false, decimals = 2): string {
  if (hidden) return '••••••'
  const rate = currency === 'CNY' ? usdCny() : 1
  if (cents === null || rate === null) return '汇率待获取'
  if (!Number.isFinite(cents)) return '待估值'
  const value = cents / 100 * rate
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)
}

export function formatSignedMoney(cents: number, currency: Currency, hidden = false) {
  if (hidden) return '••••••'
  return `${cents > 0 ? '+' : ''}${formatMoney(cents, currency)}`
}

export function formatQuantity(quantity: number, hidden = false) {
  return hidden ? '••••' : new Intl.NumberFormat('zh-CN', quantity !== 0 && Math.abs(quantity) < .000001 ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 6 }).format(quantity)
}

// 全站价格精度：≥1 保留 2 位小数；0.01–1 保留 4 位；<0.01 保留 4 位有效数字。
export function priceFormat(price: number): Intl.NumberFormatOptions {
  const size = Math.abs(price)
  if (size > 0 && size < .01) return { maximumSignificantDigits: 4 }
  const digits = size > 0 && size < 1 ? 4 : 2
  return { minimumFractionDigits: digits, maximumFractionDigits: digits }
}

export function formatPriceNumber(value: string | number) {
  const price = Number(value)
  return Number.isFinite(price) ? price.toLocaleString('zh-CN', priceFormat(price)) : String(value)
}

export function formatPrice(usdPrice: number | null, currency: Currency, hidden = false) {
  if (hidden) return '••••••'
  const rate = currency === 'CNY' ? usdCny() : 1
  if (rate === null) return '汇率待获取'
  if (usdPrice === null) return '待补价格'
  const price = usdPrice * rate
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...priceFormat(price) }).format(price)
}

export function formatNativePrice(amount: number, original: Currency, display: Currency, hidden = false) {
  if (hidden) return '••••••'
  if (original === display) return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: display, currencyDisplay: 'narrowSymbol', ...priceFormat(amount) }).format(amount)
  const usd = toUsd(amount, original)
  return usd === null ? '汇率待获取' : formatPrice(usd, display)
}

export function formatHoldingPrice(asset: Holding, currency: Currency, hidden = false) {
  return asset.fxPending && !hidden ? '汇率待获取' : formatPrice(asset.usdPrice, currency, hidden)
}

// 接入后尚未积累历史记录，保持空白，不生成示意曲线。
export function historyFor(_period: Period, _endValue = totalValueCents): HistoryPoint[] { return [] }
export function sourceHistoryFor(_sourceId: string, _period: Period): HistoryPoint[] { return [] }

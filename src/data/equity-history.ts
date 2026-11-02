import type { ContractDirection, HistoryPoint, Period } from './portfolio.ts'
import { accounts, accountBalances, awaitingLiveBalances, contracts, grossValueCents, holdings, positionValueCents, totalValueCents } from './portfolio.ts'
import type { ReturnRange } from './return-range.ts'
import { Decimal } from 'decimal.js'

const markets = new Set(['crypto', 'us', 'cn', 'cash', 'other'])
const categories = new Set(['加密资产', '股票', '现金与稳定币', '其他资产'])
export const equityCurveNote = '按持仓数量×现价绘制。开始记录前没有更早快照时，区间左侧沿用首次估值。曲线包含充值、提现和转账，不是扣除费用后的收益。'

export type EquityPoint = {
  t: number
  net: number
  gross: number
  rows: [string, string, number, string, string][]
  prices: [string, number][]
  contracts: [string, string, number | null, number | null][]
  contractDirections?: [string, ContractDirection][]
  accounts: [string, number][]
  investmentPositions?: [string, string, string, string, string, number | null][]
  investmentAccounts?: [string, string, string, string, string][]
}

type Measure = {
  mode: 'net' | 'gross' | 'accounts' | 'market' | 'category' | 'asset-value' | 'asset-price' | 'contract-price' | 'pnl'
  accountIds?: readonly string[]
  market?: string | readonly string[]
  category?: string
  assetId?: string
  contractId?: string
  contractIds?: readonly string[]
  contractDirection?: ContractDirection
}

export type EquityQuery = Measure & { start: number; end: number; all?: boolean }

function text(value: unknown, limit: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function cents(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1e15 && value <= 1e15
}

export function validEquityPoint(value: unknown, now = Math.floor(Date.now() / 1000)): value is EquityPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as EquityPoint
  if (!Number.isSafeInteger(point.t) || point.t < 1_500_000_000 || point.t > now + 120) return false
  if (!cents(point.net) || !cents(point.gross)) return false
  if (!Array.isArray(point.rows) || point.rows.length > 400 || !Array.isArray(point.prices) || point.prices.length > 400) return false
  if (!Array.isArray(point.contracts) || point.contracts.length > 200 || !Array.isArray(point.accounts) || point.accounts.length > 80) return false
  for (const row of point.rows) {
    if (!Array.isArray(row) || row.length !== 5 || !text(row[0], 160) || !text(row[1], 80) || !cents(row[2]) || row[2] < 0 || !markets.has(row[3]) || !categories.has(row[4])) return false
  }
  for (const row of point.prices) {
    if (!Array.isArray(row) || row.length !== 2 || !text(row[0], 160) || typeof row[1] !== 'number' || !Number.isFinite(row[1]) || row[1] <= 0 || row[1] > 1e12) return false
  }
  for (const row of point.contracts) {
    if (!Array.isArray(row) || row.length !== 4 || !text(row[0], 160) || !text(row[1], 80)) return false
    if (!(row[2] === null || typeof row[2] === 'number' && Number.isFinite(row[2]) && row[2] > 0 && row[2] <= 1e12)) return false
    if (!(row[3] === null || cents(row[3]))) return false
  }
  if (point.contractDirections !== undefined && (!Array.isArray(point.contractDirections) || point.contractDirections.length > 200 || point.contractDirections.some(row => !Array.isArray(row) || row.length !== 2 || !text(row[0], 160) || !['做多', '做空'].includes(row[1])))) return false
  for (const row of point.accounts) {
    if (!Array.isArray(row) || row.length !== 2 || !text(row[0], 80) || !cents(row[1])) return false
  }
  if (point.investmentAccounts !== undefined && (!Array.isArray(point.investmentAccounts) || point.investmentAccounts.length > 80 || point.investmentAccounts.some(row => !Array.isArray(row) || row.length !== 5 || row.some(item => !text(item, 160))))) return false
  if (point.investmentPositions !== undefined && (!Array.isArray(point.investmentPositions) || point.investmentPositions.length > 400 || point.investmentPositions.some(row => !Array.isArray(row) || row.length !== 6 || !text(row[0], 160) || !text(row[1], 80) || !markets.has(row[2]) || !text(row[3], 160) || typeof row[4] !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/.test(row[4]) || !(row[5] === null || cents(row[5]) && row[5] >= 0)))) return false
  return true
}

export function appendEquityPoint(points: readonly EquityPoint[], point: EquityPoint, now = point.t): EquityPoint[] {
  if (!validEquityPoint(point, Math.max(now, point.t))) return [...points]
  const next = points.filter(item => validEquityPoint(item, Math.max(now, point.t)) && item.t < point.t)
  const last = next.at(-1)
  if (last && point.t - last.t < 50) next[next.length - 1] = point
  else next.push(point)
  return compactEquityPoints(next, now)
}

// 旧曲线逐级变稀：2天内每分钟，35天内每小时，更早每天一个，另外每天的日初、日末点永远保留。
// 没有总数上限：压缩后一年只增加约一千个点，时间再久也不会丢掉早期历史。
export function compactEquityPoints(next: readonly EquityPoint[], now: number): EquityPoint[] {
  const edges = new Map<string, number>()
  for (const item of next) {
    const local = item.t + 8 * 3600, second = local % 86400, day = Math.floor(local / 86400)
    if (second < 300 && !edges.has(day + ':open')) edges.set(day + ':open', item.t)
    if (second >= 86100) edges.set(day + ':close', item.t)
  }
  const boundaries = new Set(edges.values())
  const keep: EquityPoint[] = []
  for (const item of next) {
    const age = now - item.t
    const gap = age > 35 * 86400 ? 86400 : age > 2 * 86400 ? 3600 : 60
    const kept = keep.at(-1)
    // 本期收益需要真实日界估值；压缩旧曲线时保留已有的日初、日末记录。
    if (!kept || item.t - kept.t >= gap || boundaries.has(item.t)) keep.push(item)
  }
  const tail = next.at(-1)
  if (tail && keep.at(-1) !== tail) keep.push(tail)
  return keep
}

export function buildEquitySample(t = Math.floor(Date.now() / 1000)): EquityPoint | null {
  if (awaitingLiveBalances()) return null
  if (totalValueCents === null || grossValueCents === null) return null
  if (!holdings.length && !contracts.length) return null
  const point: EquityPoint = {
    t,
    net: totalValueCents,
    gross: grossValueCents,
    rows: holdings.flatMap(asset => asset.positions.flatMap(position => {
      const value = positionValueCents(asset, position)
      return Number.isSafeInteger(value) && value >= 0 ? [[asset.id, position.accountId, value, asset.market, asset.category] as [string, string, number, string, string]] : []
    })),
    prices: holdings.flatMap(asset => asset.usdPrice !== null && asset.usdPrice > 0 && asset.usdPrice <= 1e12 ? [[asset.id, asset.usdPrice] as [string, number]] : []),
    contracts: contracts.flatMap(position => {
      const mark = position.markPriceUsd !== null && position.markPriceUsd > 0 && position.markPriceUsd <= 1e12 ? position.markPriceUsd : null
      const pnl = position.unrealizedPnlCents !== null && Number.isSafeInteger(position.unrealizedPnlCents) ? position.unrealizedPnlCents : null
      return [[position.id, position.accountId, mark, pnl] as [string, string, number | null, number | null]]
    }),
    contractDirections: contracts.map(position => [position.id, position.direction]),
    accounts: accountBalances.flatMap(account => Number.isSafeInteger(account.valueCents) ? [[account.id, account.valueCents] as [string, number]] : []),
    investmentPositions: holdings.flatMap(asset => asset.members ?? [asset]).flatMap(asset => asset.positions.map(position => [asset.id, asset.symbol, asset.category === '现金与稳定币' ? 'cash' : asset.market, position.accountId, new Decimal(position.quantityText ?? position.quantity).toFixed(), asset.usdPrice === null ? null : positionValueCents(asset, position)])),
    investmentAccounts: accounts.map(account => [account.id, account.sourceId, account.name, account.kind === '钱包' ? '链上' : account.accountGroup ?? (account.kind === '手动账户' ? '手动' : '现货'), account.status ?? 'pending']),
  }
  // 附加核对资料不完整时，仍保留原有资产曲线，不让它阻断日常记录。
  if (!validEquityPoint(point as unknown, t)) { delete point.investmentPositions; delete point.investmentAccounts }
  return validEquityPoint(point, t) ? point : null
}

function selected(ids: readonly string[] | undefined, id: string) {
  return !ids || ids.includes(id)
}

function measure(point: EquityPoint, query: Measure): number | null {
  if (query.mode === 'net') return point.net
  if (query.mode === 'gross') return point.gross
  if (query.mode === 'accounts') return point.accounts.filter(row => selected(query.accountIds, row[0])).reduce((sum, row) => sum + row[1], 0)
  if (query.mode === 'market') return point.rows.filter(row => [query.market].flat().includes(row[3]) && selected(query.accountIds, row[1])).reduce((sum, row) => sum + row[2], 0)
  if (query.mode === 'category') return point.rows.filter(row => (!query.category || row[4] === query.category) && selected(query.accountIds, row[1])).reduce((sum, row) => sum + row[2], 0)
  if (query.mode === 'asset-value') return point.rows.filter(row => row[0] === query.assetId && selected(query.accountIds, row[1])).reduce((sum, row) => sum + row[2], 0)
  if (query.mode === 'pnl') {
    let positions = point.contracts.filter(row => selected(query.accountIds, row[1]) && selected(query.contractIds, row[0]))
    if (query.contractDirection) {
      const directions = new Map(point.contractDirections)
      // 旧快照未保存方向，不能用今天的多空去猜过去的单向仓位。
      if (positions.some(row => !directions.has(row[0]))) return null
      positions = positions.filter(row => directions.get(row[0]) === query.contractDirection)
    }
    return positions.some(row => row[3] === null) ? null : positions.reduce((sum, row) => sum + row[3]!, 0)
  }
  if (query.mode === 'asset-price') {
    const price = point.prices.find(row => row[0] === query.assetId)?.[1]
    return price === undefined ? null : price * 100
  }
  const mark = point.contracts.find(row => row[0] === query.contractId)?.[2]
  return mark == null ? null : mark * 100
}

export function equityLabel(t: number, span: number) {
  const withTime = span <= 2 * 86400
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: withTime ? '2-digit' : undefined, minute: withTime ? '2-digit' : undefined, hourCycle: 'h23' }).format(new Date(t * 1000))
}

export function rangeBounds(range: Period | ReturnRange, now = Date.now()) {
  const end = Math.floor(now / 1000)
  if (typeof range !== 'string' && range.period === '全部时间') return { start: 0, end, all: true }
  if (typeof range !== 'string' && range.period === '自定义') return { start: Math.floor(Date.parse(range.start + 'T00:00:00+08:00') / 1000), end: Math.min(end, Math.floor(Date.parse(range.end + 'T23:59:59+08:00') / 1000)), all: false }
  const period = typeof range === 'string' ? range : range.period
  const days = period === '1天' ? 1 : period === '7天' ? 7 : period === '30天' ? 30 : 365
  return { start: end - days * 86400, end, all: false }
}

export function projectEquity(stored: readonly EquityPoint[], query: EquityQuery, live: EquityPoint | null): HistoryPoint[] {
  let series = stored.filter(item => validEquityPoint(item, Math.max(query.end, item.t)))
  if (live && validEquityPoint(live, Math.max(query.end, live.t)) && live.t >= (series.at(-1)?.t ?? 0)) series = appendEquityPoint(series, live, live.t)
  const known = series.flatMap(point => {
    const value = measure(point, query)
    return value === null ? [] : [{ t: point.t, cents: value }]
  })
  if (!known.length) return []
  let start = query.all ? known[0].t : query.start
  if (query.mode === 'pnl' && query.contractDirection) start = Math.max(start, known[0].t)
  const end = Math.max(query.end, known.at(-1)!.t)
  if (!(end > start)) start = end - 60
  const anchors: { t: number; cents: number }[] = []
  const push = (anchor: { t: number; cents: number }) => {
    const previous = anchors.at(-1)
    if (previous?.t === anchor.t) previous.cents = anchor.cents
    else anchors.push(anchor)
  }
  const inside = known.filter(point => point.t >= start && point.t <= end)
  if (query.all) for (const point of inside.length ? inside : known) push(point)
  else {
    const prior = [...known].reverse().find(point => point.t <= start)
    push({ t: start, cents: (prior ?? inside[0] ?? known.at(-1)!).cents })
    for (const point of inside) if (point.t > start) push(point)
  }
  if (anchors.at(-1)!.t < end) push({ t: end, cents: anchors.at(-1)!.cents })
  const span = end - start
  return anchors.map(point => ({ label: equityLabel(point.t, span), valueCents: point.cents }))
}

let points: EquityPoint[] = []
export const savedEquityPoints = (): readonly EquityPoint[] => points
const notifyHistory = () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('equity-history-change')) }

export function equityPoints(query: Measure & { period?: Period | ReturnRange }, now = Date.now()): HistoryPoint[] {
  const bounds = rangeBounds(query.period ?? '30天', now)
  return projectEquity(points, { ...query, ...bounds }, buildEquitySample(bounds.end))
}

// 全部历史只在打开页面和每 6 小时读一次（几年后体积很大）；其余时间只补最近 2 小时的新点并替换同一时段。
const FULL_SYNC_MS = 6 * 3600000
let fullSyncAt = 0
export async function syncEquityHistory() {
  const full = !points.length || Date.now() - fullSyncAt > FULL_SYNC_MS
  const since = full ? 0 : points.at(-1)!.t - 7200
  try {
    const response = await fetch('/api/equity-history' + (since ? '?start=' + since : ''), { headers: { 'X-Investment-App': '1' }, signal: AbortSignal.timeout(full ? 60000 : 15000) })
    const body = await response.json()
    if (response.ok && Array.isArray(body.points)) {
      const fresh = body.points.filter((point: unknown) => validEquityPoint(point))
      points = full ? fresh : [...points.filter(point => point.t < since), ...fresh]
      if (full) fullSyncAt = Date.now()
      notifyHistory()
    }
  } catch { /* 读取失败时仍用当前估值画平线。 */ }
}
// 走势点只由服务器记录（网页关着也照常记），页面只负责定时读取，避免设备时钟不准把历史写乱。
export const EQUITY_REFRESH_MS = 300000


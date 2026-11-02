import { validFeeValuations } from './fee-valuation.ts'
import type { FeeValuation } from './fee-valuation.ts'
import { Decimal } from 'decimal.js'
import { canValueReward, isTransactionReward, rewardDescription } from './transaction-rewards.ts'
const Exact = Decimal.clone({ precision: 100 })
export const transactionTypes = ['买入', '卖出', '充值', '提现', '账户间转账', '资金费', '已实现盈亏', '手续费', '其他收支', '收到', '转出', '兑换', '奖励'] as const
export type WalletMovement = { token: string; asset: string; quantity: string; direction: 'in' | 'out'; counterparty: string }
export type RewardValuation = { price: string; usdtQuantity: string; at: number; pair: string; basis: 'parity' | 'minute-open' }
export type Transaction = {
  id: string; connectionId: string; connectionName: string; identity: string
  account: string; scope: string; type: (typeof transactionTypes)[number]; time: number
  asset: string; quantity: string; symbol: string; quoteAsset: string; quoteQuantity: string | null; price: string | null
  fees: { asset: string; quantity: string }[]; realizedPnl: string | null; pnlAsset: string
  status: '已完成' | '处理中' | '失败' | '待确认' | '已记录'; orderId: string; txHash: string; network: string; address: string; note: string; relatedTradeId: string
  movements?: WalletMovement[]; walletOwner?: string; positionSide?: PositionSide; rewardValuation?: RewardValuation; feeValuations?: FeeValuation[]
}
export type PositionSide = 'LONG' | 'SHORT' | 'BOTH'
export type TransactionCoverage = { from: number; to: number; count: number }
export type PositionCheck = { at: number; positions: { side: PositionSide; quantity: string }[] }
export type TransactionCheckpoint = { coverage: TransactionCoverage; positionCheck?: PositionCheck }
export type TransactionSync = { connectionId: string; connectionName: string; identity: string; key: string; label: string; status: 'ok' | 'partial' | 'error'; from: number; to: number; at: number; lastSuccess: number | null; warning: string; coverage?: TransactionCoverage; positionCheck?: PositionCheck; checkpoints?: TransactionCheckpoint[] }
export type TransactionState = { records: Transaction[]; syncs: TransactionSync[] }
export type TransactionFilters = { query: string; type: string; account: string; source: string; start: string; end: string }
export const emptyTransactions = (): TransactionState => ({ records: [], syncs: [] })
const text = (value: unknown, limit: number, empty = true): value is string => typeof value === 'string' && value.length <= limit && (empty || !!value) && !/[\x00-\x1f]/.test(value)
const amount = (value: unknown): value is string => typeof value === 'string' && /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,36})?$/.test(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1483228800000 && Number(value) <= Date.now() + 300000
const connectionId = (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)
export function validTransactionState(value: unknown, { archive = false } = {}): value is TransactionState {
  if (!value || typeof value !== 'object') return false
  const state = value as TransactionState
  if (!Array.isArray(state.records) || !archive && state.records.length > 100000 || !Array.isArray(state.syncs) || !archive && state.syncs.length > 4000) return false
  const ids = new Set<string>(), scopes = new Set<string>()
  for (const row of state.records) {
    if (!row || !text(row.id, 256, false) || ids.has(row.id) || !connectionId(row.connectionId) || !text(row.connectionName, 80, false) || !text(row.identity, 80, false) || !text(row.account, 120, false) || !text(row.scope, 80, false) || !transactionTypes.includes(row.type) || !time(row.time) || !text(row.asset, 40, false) || !amount(row.quantity) || !text(row.symbol, 64) || !text(row.quoteAsset, 40) || !(row.quoteQuantity === null || amount(row.quoteQuantity)) || !(row.price === null || amount(row.price)) || !Array.isArray(row.fees) || row.fees.length > 4 || row.fees.some(fee => !fee || !text(fee.asset, 40, false) || !amount(fee.quantity)) || !(row.realizedPnl === null || amount(row.realizedPnl)) || !text(row.pnlAsset, 40) || !['已完成', '处理中', '失败', '待确认', '已记录'].includes(row.status) || !text(row.orderId, 100) || !text(row.txHash, 512) || !text(row.network, 80) || !text(row.address, 256) || !text(row.note, 1000) || !text(row.relatedTradeId, 256)) return false
    if (row.price !== null && (row.price.startsWith('-') || !row.quoteAsset) || row.quoteQuantity !== null && (row.quoteQuantity.startsWith('-') || !row.quoteAsset) || row.realizedPnl !== null && !row.pnlAsset) return false
    if (row.positionSide !== undefined && (row.scope !== 'usdm' || !['买入', '卖出'].includes(row.type) || !['LONG', 'SHORT', 'BOTH'].includes(row.positionSide) || !/^[1-9]\d*$/.test(row.id.split(':').at(-1) ?? '') || Number(row.quantity) <= 0)) return false
    if (row.walletOwner !== undefined && !text(row.walletOwner, 100, false)) return false
    if (row.movements !== undefined && (!Array.isArray(row.movements) || row.movements.length > 100 || row.movements.some(move => !move || !text(move.token, 100, false) || !text(move.asset, 40, false) || !amount(move.quantity) || move.quantity.startsWith('-') || !['in', 'out'].includes(move.direction) || !text(move.counterparty, 256)))) return false
    if (row.scope.startsWith('wallet:') && (!['收到', '转出', '兑换'].includes(row.type) || !row.walletOwner || !row.movements)) return false
    if (!validFeeValuations(row)) return false
    if (row.rewardValuation !== undefined) {
      const value = row.rewardValuation, stable = ['USDT', 'USDC'].includes(row.asset)
      if (!value || !canValueReward(row) || !amount(value.price) || Number(value.price) <= 0 || !amount(value.usdtQuantity) || !time(value.at) || !text(value.pair, 44)) return false
      if (stable ? value.basis !== 'parity' || value.price !== '1' || value.at !== row.time || value.pair !== '' : value.basis !== 'minute-open' || value.at !== Math.floor(row.time / 60000) * 60000 || ![row.asset + 'USDT', row.asset + 'USDC'].includes(value.pair)) return false
      if (!new Exact(row.quantity).mul(value.price).toDecimalPlaces(36).eq(value.usdtQuantity)) return false
    }
    ids.add(row.id)
  }
  for (const item of state.syncs) {
    if (!item || !connectionId(item.connectionId) || !text(item.connectionName, 80, false) || !text(item.identity, 80, false) || !text(item.key, 100, false) || !text(item.label, 120, false) || !['ok', 'partial', 'error'].includes(item.status) || !time(item.from) || !time(item.to) || item.from > item.to || !time(item.at) || !(item.lastSuccess === null || time(item.lastSuccess) && item.lastSuccess <= item.to) || !text(item.warning, 1000)) return false
    const validCheckpoint = (checkpoint: TransactionCheckpoint): boolean => {
      const coverage = checkpoint?.coverage, check = checkpoint?.positionCheck
      if (!coverage || !time(coverage.from) || !time(coverage.to) || coverage.from > coverage.to || coverage.to > item.to || !Number.isSafeInteger(coverage.count) || coverage.count < 0 || !archive && coverage.count > 100000 || !(item.key === 'income' || item.key.startsWith('usdm:') || item.key.startsWith('spot:'))) return false
      return check === undefined || !!check && item.key.startsWith('usdm:') && check.at === coverage.to && Array.isArray(check.positions) && check.positions.length === 3 && new Set(check.positions.map(p => p?.side)).size === 3 && !check.positions.some(p => !p || !['LONG', 'SHORT', 'BOTH'].includes(p.side) || !amount(p.quantity) || p.side === 'LONG' && p.quantity.startsWith('-') || p.side === 'SHORT' && Number(p.quantity) > 0)
    }
    if ((item.coverage !== undefined || item.positionCheck !== undefined) && !validCheckpoint({ coverage: item.coverage!, positionCheck: item.positionCheck })) return false
    if (item.checkpoints !== undefined && (!Array.isArray(item.checkpoints) || item.checkpoints.length > 1000 || item.checkpoints.some(checkpoint => !validCheckpoint(checkpoint)))) return false
    const key = item.connectionId + ':' + item.key
    if (scopes.has(key)) return false
    scopes.add(key)
  }
  // 本文件只接收明确列出的资料，避免把密钥随第三方对象保存下来。
  const allowed = new Set(['records', 'syncs', 'id', 'connectionId', 'connectionName', 'identity', 'account', 'scope', 'type', 'time', 'asset', 'quantity', 'symbol', 'quoteAsset', 'quoteQuantity', 'price', 'fees', 'realizedPnl', 'pnlAsset', 'status', 'orderId', 'txHash', 'network', 'address', 'note', 'relatedTradeId', 'key', 'label', 'from', 'to', 'at', 'lastSuccess', 'warning', 'movements', 'walletOwner', 'token', 'direction', 'counterparty', 'positionSide', 'coverage', 'count', 'positionCheck', 'positions', 'side', 'checkpoints', 'feeValuations', 'rewardValuation', 'usdtQuantity', 'pair', 'basis'])
  const safe = (node: unknown): boolean => !node || typeof node !== 'object' || Object.entries(node).every(([key, entry]) => (Array.isArray(node) || allowed.has(key)) && safe(entry))
  return safe(state)
}
export function filterTransactions(rows: Transaction[], filters: TransactionFilters): Transaction[] {
  const query = filters.query.trim().toLowerCase()
  const start = filters.start ? Date.parse(filters.start + 'T00:00:00+08:00') : -Infinity
  const end = filters.end ? Date.parse(filters.end + 'T23:59:59.999+08:00') : Infinity
  return rows.filter(row => row.time >= start && row.time <= end && (!filters.type || row.type === filters.type) && (!filters.account || row.scope === filters.account) && (!filters.source || row.connectionId === filters.source) && (!query || [row.type, row.account, row.asset, row.symbol, row.orderId, row.txHash, row.connectionName, row.address, isTransactionReward(row) ? rewardDescription(row) : '', row.walletOwner ?? '', ...(row.movements ?? []).flatMap(move => [move.asset, move.token, move.counterparty])].some(value => value.toLowerCase().includes(query))))
}

export function walletTransactionUrl(row: Transaction): string {
  const chain = row.scope.startsWith('wallet:') ? row.scope.slice(7) : ''
  if (chain === 'btc') return /^[0-9a-f]{64}$/i.test(row.txHash) ? 'https://mempool.space/tx/' + row.txHash : ''
  if (chain === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(row.txHash) ? 'https://solscan.io/tx/' + row.txHash : ''
  const hosts: Record<string, string> = { eth: 'eth.blockscout.com', bsc: 'bscscan.com', arbitrum: 'arbitrum.blockscout.com', base: 'base.blockscout.com', optimism: 'optimism.blockscout.com', polygon: 'polygon.blockscout.com', avalanche: 'snowtrace.io', gnosis: 'gnosis.blockscout.com', scroll: 'scroll.blockscout.com', zksync: 'zksync.blockscout.com' }
  return hosts[chain] && /^0x[0-9a-f]{64}$/i.test(row.txHash) ? 'https://' + hosts[chain] + '/tx/' + row.txHash : ''
}

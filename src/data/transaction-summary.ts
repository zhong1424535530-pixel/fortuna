import { Decimal } from 'decimal.js'
import { coinKey } from './asset-identity.ts'
import { networks } from './live-types.ts'
import type { Connection } from './live-types.ts'
import type { ContractRound } from './contract-history.ts'
import { rewardUsdtValue } from './transaction-rewards.ts'
import { feeInUnit } from './fee-valuation.ts'
import type { Transaction, TransactionFilters, TransactionState, WalletMovement } from './transactions.ts'

const Money = Decimal.clone({ precision: 100 })
export type SummaryAmount = { key: string; asset: string; quantity: string; detail: string }
export type FeePrice = { key: string; price: string; at: number }
type Totals = Map<string, SummaryAmount>
type WalletConnection = Pick<Connection, 'type' | 'address' | 'walletFamily' | 'chains'>
const capitalChains: Record<string, string> = { ETH: 'eth', ERC20: 'eth', BSC: 'bsc', BEP20: 'bsc', BTC: 'btc', SOL: 'solana', SOLANA: 'solana', ARBITRUM: 'arbitrum', ARBITRUMONE: 'arbitrum', BASE: 'base', OPTIMISM: 'optimism', MATIC: 'polygon', POLYGON: 'polygon', AVAXC: 'avalanche', GNOSIS: 'gnosis', SCROLL: 'scroll', ZKSYNCERA: 'zksync' }
const chainOf = (row: Pick<Transaction, 'scope' | 'network'>) => row.scope.startsWith('wallet:') ? row.scope.slice(7) : capitalChains[row.network.toUpperCase()] ?? ''
const addressKey = (chain: string, address: string) => chain + ':' + (/^0x[0-9a-f]{40}$/i.test(address) || /^(bc1|tb1)/i.test(address) ? address.toLowerCase() : address)
const hashKey = (row: Transaction) => {
  const chain = chainOf(row)
  return chain && /^(?:0x[0-9a-f]{64}|[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/i.test(row.txHash) ? chain + ':' + (chain === 'solana' ? row.txHash : row.txHash.toLowerCase()) : ''
}

export function transactionAssetId(row: Pick<Transaction, 'scope' | 'id' | 'network'>, asset: string, token = 'native'): string {
  const chain = row.scope.startsWith('wallet:') ? chainOf(row) : ''
  const network = networks.find(item => item.id === chain)
  return chain ? chain === 'btc' ? 'bitcoin:native' : chain === 'solana' ? 'solana:' + token : `evm:${network?.chainId ?? chain}:${token}` : row.id.split(':')[0] + ':' + asset
}
function amountInfo(row: Transaction, asset: string, token = 'native'): Omit<SummaryAmount, 'quantity'> {
  const chain = row.scope.startsWith('wallet:') ? chainOf(row) : ''
  const id = transactionAssetId(row, asset, token)
  const key = coinKey({ id, market: 'crypto' })
  return { key, asset, detail: key.startsWith('coin:') || !chain ? '' : `${row.network || chain}${token === 'native' ? '' : ' · ' + token}` }
}
function add(totals: Totals, row: Transaction, asset: string, quantity: string, token?: string) {
  const info = amountInfo(row, asset, token), previous = totals.get(info.key)
  totals.set(info.key, { ...info, quantity: new Money(previous?.quantity ?? 0).plus(quantity).toFixed() })
}
// 交易所费用与单笔明细一致，按成交当分钟价折成 USDT；缺历史价的保留原币，汇总时再用现价补。
function addFee(totals: Totals, row: Transaction, asset: string, quantity: string, wallet: boolean) {
  const usdt = wallet ? null : feeInUnit(row, { asset, quantity }, 'USDT')
  add(totals, row, usdt === null ? asset : 'USDT', usdt ?? quantity)
}
const amounts = (totals: Totals) => [...totals.values()].sort((a, b) => {
  const priority = (asset: string) => asset === 'USDT' ? 0 : asset === 'USDC' ? 1 : 2
  return priority(a.asset) - priority(b.asset) || a.asset.localeCompare(b.asset) || a.key.localeCompare(b.key)
})

export function summaryAmount(value: string, signed = false): string {
  const rounded = new Money(value).toDecimalPlaces(2, Money.ROUND_HALF_UP)
  return (signed && rounded.gt(0) ? '+' : '') + (rounded.isZero() ? '0.00' : rounded.toFixed(2))
}

export function feesInUsdt(entries: readonly SummaryAmount[], quotes: readonly FeePrice[], now = Date.now()) {
  let total = new Money(0), missing = 0
  for (const entry of entries) {
    if (new Money(entry.quantity).isZero()) continue
    const stable = ['coin:tether', 'coin:usd-coin'].includes(entry.key) || /^crypto:(?:binance|okx|bybit|bitget|gate|bitunix):(?:USDT|USDC)$/.test(entry.key)
    const quote = quotes.find(item => item.key === entry.key && item.at <= now + 30000 && now - item.at <= 300000)
    try {
      const price = new Money(stable ? '1' : quote?.price ?? 'NaN')
      if (!price.isFinite() || price.lte(0) || price.gt('1e12')) throw new Error()
      total = total.plus(new Money(entry.quantity).mul(price))
    } catch { missing++ }
  }
  return { amounts: entries.length && !missing ? [{ key: 'coin:tether', asset: 'USDT', quantity: total.toFixed(), detail: '' }] : [], missing }
}

export function summarizeTransactions(state: TransactionState, rounds: readonly ContractRound[], filters: TransactionFilters, connections: readonly WalletConnection[] = []) {
  const from = filters.start ? Date.parse(filters.start + 'T00:00:00+08:00') : -Infinity
  const to = filters.end ? Date.parse(filters.end + 'T23:59:59.999+08:00') : Infinity
  const selected = (row: { time: number; connectionId: string }) => row.time >= from && row.time <= to && (!filters.source || row.connectionId === filters.source)
  const pnl: Totals = new Map(), fees: Totals = new Map(), feeRefunds: Totals = new Map(), deposits: Totals = new Map(), received: Totals = new Map(), withdrawals: Totals = new Map(), sent: Totals = new Map(), rewards: Totals = new Map()
  let missingPnl = 0, missingFees = 0
  let fundingIncome = new Money(0), fundingExpense = new Money(0), fundingCount = 0, missingFunding = 0
  const owned = new Set<string>(), byHash = new Map<string, Transaction[]>(), capitalTotals = new Map<string, Decimal>()
  const capitalKey = (row: Transaction) => hashKey(row) + ':' + row.type + ':' + amountInfo(row, row.asset).key + ':' + addressKey(chainOf(row), row.address)
  for (const row of state.records) {
    if (row.walletOwner) owned.add(addressKey(chainOf(row), row.walletOwner))
    const hash = hashKey(row)
    if (hash && row.status === '已完成') {
      if (!byHash.has(hash)) byHash.set(hash, [])
      byHash.get(hash)!.push(row)
      if (row.scope === 'capital' && ['充值', '提现'].includes(row.type)) {
        const key = capitalKey(row)
        capitalTotals.set(key, (capitalTotals.get(key) ?? new Money(0)).plus(row.quantity))
      }
    }
  }
  for (const connection of connections) if (connection.type === 'wallet' && connection.address) {
    const chains = connection.walletFamily === 'btc' ? ['btc'] : connection.walletFamily === 'solana' ? ['solana'] : connection.chains ?? networks.map(item => item.id)
    for (const chain of chains) owned.add(addressKey(chain, connection.address))
  }
  const ownAddress = (chain: string, address: string) => !!chain && !!address && owned.has(addressKey(chain, address))
  const capitalMatches = (capital: Transaction, wallet: Transaction, move: WalletMovement) => {
    // 同交易同地址的多笔提现，在钱包里可能已合成一次收款。
    const quantity = capitalTotals.get(capitalKey(capital)) ?? new Money(capital.quantity)
    if (capital.asset !== move.asset || amountInfo(capital, capital.asset).key !== amountInfo(wallet, move.asset, move.token).key || !quantity.eq(move.quantity)) return false
    if (capital.type === '提现' && move.direction === 'in') return !!wallet.walletOwner && addressKey(chainOf(wallet), capital.address) === addressKey(chainOf(wallet), wallet.walletOwner)
    return capital.type === '充值' && move.direction === 'out' && !!capital.address && addressKey(chainOf(wallet), capital.address) === addressKey(chainOf(wallet), move.counterparty)
  }
  const internalMove = (row: Transaction, move: WalletMovement) => ownAddress(chainOf(row), move.counterparty) || (byHash.get(hashKey(row)) ?? []).some(other => other.scope === 'capital' && capitalMatches(other, row, move))
  const internalCapital = (row: Transaction) => row.type === '提现' && ownAddress(chainOf(row), row.address) || (byHash.get(hashKey(row)) ?? []).some(other => {
    if (other.walletOwner) return (other.movements ?? []).some(move => capitalMatches(row, other, move))
    return other.scope === 'capital' && other.identity !== row.identity && other.type !== row.type && ['充值', '提现'].includes(other.type) && row.asset === other.asset && row.address && addressKey(chainOf(row), row.address) === addressKey(chainOf(other), other.address) && new Money(row.quantity).eq(other.quantity)
  })
  // 同一成交的费用核对币种与金额一致后采用独立收支，其他返还不能抵掉原成交支出。
  const incomeFees = new Set(state.records.filter(row => row.type === '手续费' && row.relatedTradeId && row.status === '已完成').map(row => row.relatedTradeId + ':' + row.asset + ':' + new Money(row.quantity).negated().toFixed()))
  const seenFees = new Set<string>(), seenMoves = new Set<string>()
  for (const round of rounds) if (round.status === '已平仓' && round.closedAt !== null && selected({ time: round.closedAt, connectionId: round.connectionId })) {
    if (round.realizedPnl === null) { missingPnl++; continue }
    const sample = round.fills[0]?.row
    if (sample) add(pnl, sample, round.pnlAsset, round.realizedPnl)
  }
  for (const row of state.records) {
    if (!selected(row)) continue
    const wallet = row.scope.startsWith('wallet:')
    const completed = row.status === '已完成'
    if (completed || wallet && row.status === '失败') {
      const feeKey = wallet ? (hashKey(row) || row.id) + ':' + addressKey(chainOf(row), row.walletOwner ?? '') : row.id
      if (!seenFees.has(feeKey)) {
        seenFees.add(feeKey)
        for (const fee of row.fees) {
          if (incomeFees.has(row.id + ':' + fee.asset + ':' + new Money(fee.quantity).toFixed())) continue
          const value = new Money(fee.quantity)
          addFee(value.isNegative() ? feeRefunds : fees, row, fee.asset, value.abs().toFixed(), wallet)
        }
        if (row.type === '手续费') {
          const value = new Money(row.quantity)
          addFee(value.isPositive() ? feeRefunds : fees, row, row.asset, value.abs().toFixed(), wallet)
        }
        if (!row.fees.length && (['买入', '卖出', '提现'].includes(row.type) || wallet && ['转出', '兑换'].includes(row.type))) missingFees++
      }
    }
    const rewardValue = rewardUsdtValue(row)
    if (rewardValue !== null) add(rewards, row, 'USDT', rewardValue)
    if (!completed) continue
    if (row.scope === 'usdm' && row.type === '资金费') {
      fundingCount++
      if (['USDT', 'USDC'].includes(row.asset)) {
        const value = new Money(row.quantity)
        if (value.isNegative()) fundingExpense = fundingExpense.plus(value.abs())
        else fundingIncome = fundingIncome.plus(value)
      } else missingFunding++
    }
    if (row.type === '充值' || row.type === '提现') {
      if (internalCapital(row)) continue
      add(row.type === '充值' ? deposits : withdrawals, row, row.asset, row.quantity)
    } else if (wallet && ['收到', '转出'].includes(row.type)) {
      for (const move of row.movements ?? []) {
        const moveKey = (hashKey(row) || row.id) + ':' + addressKey(chainOf(row), row.walletOwner ?? '') + ':' + move.token + ':' + move.direction
        if (seenMoves.has(moveKey)) continue
        seenMoves.add(moveKey)
        if (internalMove(row, move)) continue
        add(move.direction === 'in' ? received : sent, row, move.asset, move.quantity, move.token)
      }
    }
  }
  // shortcut: 仅排除可确认的同链内部转移；未提供对方地址或完整两侧明细时保留收付，补全来源后再扩展。
  // 非 USDT/USDC 结算的资金费不并入合计，只计数提示。
  const funding = fundingCount > missingFunding
    ? { income: fundingIncome.toFixed(), expense: fundingExpense.toFixed(), net: fundingIncome.minus(fundingExpense).toFixed(), missing: missingFunding }
    : { income: null, expense: null, net: null, missing: missingFunding }
  return { pnl: amounts(pnl), fees: amounts(fees), feeRefunds: amounts(feeRefunds), deposits: amounts(deposits), received: amounts(received), withdrawals: amounts(withdrawals), sent: amounts(sent), rewards: amounts(rewards), funding, missingPnl, missingFees }
}

export function summarizeCashflow(totals: Pick<ReturnType<typeof summarizeTransactions>, 'deposits' | 'received' | 'withdrawals' | 'sent'>, quotes: readonly FeePrice[], now = Date.now()) {
  const incoming = [...totals.deposits, ...totals.received], outgoing = [...totals.withdrawals, ...totals.sent]
  const income = feesInUsdt(incoming, quotes, now), expense = feesInUsdt(outgoing, quotes, now)
  const missing = income.missing + expense.missing
  if ((!incoming.length && !outgoing.length) || missing) return { income: null, expense: null, net: null, missing }
  const received = income.amounts[0]?.quantity ?? '0', paid = expense.amounts[0]?.quantity ?? '0'
  return { income: received, expense: paid, net: new Money(received).minus(paid).toFixed(), missing: 0 }
}

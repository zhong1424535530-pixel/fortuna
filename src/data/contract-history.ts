import { feeInUnit } from './fee-valuation.ts'
import { isTransactionReward } from './transaction-rewards.ts'
import { Decimal } from 'decimal.js'
import type { PositionSide, Transaction, TransactionState, TransactionSync } from './transactions.ts'

const Money = Decimal.clone({ precision: 80 })
export type ContractFill = { row: Transaction; action: '开仓 / 加仓' | '平仓'; quantity: string; fees: Transaction['fees']; realizedPnl: string | null }
export type ContractRound = {
  id: string; connectionId: string; connectionName: string; identity: string; symbol: string; asset: string; pnlAsset: string
  direction: '做多' | '做空'; status: '已平仓' | '持仓中' | '资料不全'
  openedAt: number | null; closedAt: number | null; lastAt: number
  openPrice: string | null; closePrice: string | null; closedQuantity: string; maxQuantity: string | null
  realizedPnl: string | null; netPnl: string | null; roi: null; fees: Transaction['fees']; fundingPnl: string | null; feePnl?: string | null
  warnings: string[]; fills: ContractFill[]; fundingManual?: true; netManual?: true
}
type WorkingRound = { fixed?: boolean; result: ContractRound; start: number; end: number; openQuantity: Decimal; openValue: Decimal; closeQuantity: Decimal; closeValue: Decimal; gross: Decimal; grossKnown: boolean; feeMap: Map<string, Decimal>; feeCost: Decimal; feesKnown: boolean; funding: Decimal; fundingKnown: boolean; peak: Decimal }
const tradesOnly = (row: Transaction) => row.scope === 'usdm' && ['买入', '卖出'].includes(row.type)
const signedQuantity = (row: Transaction) => new Money(row.quantity).mul(row.type === '买入' ? 1 : -1)
const compareFills = (a: Transaction, b: Transaction) => a.time - b.time || (BigInt(a.id.split(':').at(-1)!) < BigInt(b.id.split(':').at(-1)!) ? -1 : 1)
const syncWindows = (syncs: TransactionSync[]) => syncs.flatMap(item => [...(item.checkpoints ?? []).map(checkpoint => ({ ...item, coverage: checkpoint.coverage, positionCheck: checkpoint.positionCheck })), item])
const warning = (round: WorkingRound, message: string) => { if (!round.result.warnings.includes(message)) round.result.warnings.push(message) }

// fundingFixes / netFixes：用户手动补录的整轮资金费、整轮净盈亏（按轮次 id），只用于交易所读取范围补不到的那几轮。
export function buildContractHistory(state: TransactionState, fundingFixes: Record<string, string> = {}, netFixes: Record<string, string> = {}): { rounds: ContractRound[]; warnings: string[] } {
  const groups = new Map<string, Transaction[]>(), rounds: ContractRound[] = [], warnings: string[] = []
  for (const row of state.records.filter(tradesOnly)) {
    const key = row.identity + ':' + row.symbol
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  for (const trades of groups.values()) {
    const sample = trades[0], label = sample.connectionName + ' · ' + sample.symbol
    const candidates = syncWindows(state.syncs).filter(item => item.identity === sample.identity && item.key === 'usdm:' + sample.symbol && item.positionCheck && item.coverage).sort((a, b) => b.positionCheck!.at - a.positionCheck!.at)
    const windows: TransactionSync[] = []
    for (const candidate of candidates) if (!windows.some(item => item.coverage!.from <= candidate.coverage!.to && item.coverage!.to >= candidate.coverage!.from)) windows.push(candidate)
    if (!windows.length) { warnings.push(label + '：需要再次同步最近7天，补齐仓位与成交的核对资料。'); continue }
    for (const sync of windows) {
      const coverage = sync.coverage!
      const covered = trades.filter(row => row.time >= coverage.from && row.time <= coverage.to)
      if (covered.length !== coverage.count || covered.some(row => !row.positionSide || row.price === null || !new Money(row.price).gt(0) || !new Money(row.quantity).gt(0))) {
        warnings.push(label + '：成交资料不齐，暂不合并；原始流水仍可查看。'); continue
      }
      const work: WorkingRound[] = []
      let invalid = false
      for (const side of ['LONG', 'SHORT', 'BOTH'] as PositionSide[]) {
        const fills = covered.filter(row => row.positionSide === side).sort(compareFills)
        const endQuantity = new Money(sync.positionCheck!.positions.find(position => position.side === side)!.quantity)
        let quantity = fills.reduce((current, row) => current.minus(signedQuantity(row)), endQuantity)
        if (side === 'LONG' && quantity.lt(0) || side === 'SHORT' && quantity.gt(0)) { invalid = true; break }
        let active: WorkingRound | null = null
        const begin = (row: Transaction, sign: number, known: boolean) => {
          const result: ContractRound = { id: row.id + ':' + side + ':' + work.length, connectionId: sync.connectionId, connectionName: sync.connectionName, identity: sample.identity, symbol: sample.symbol, asset: sample.asset, pnlAsset: row.pnlAsset,
            direction: sign > 0 ? '做多' : '做空', status: known ? '持仓中' : '资料不全', openedAt: known ? row.time : null, closedAt: null, lastAt: row.time,
            openPrice: null, closePrice: null, closedQuantity: '0', maxQuantity: null, realizedPnl: null, netPnl: null, roi: null, fees: [], fundingPnl: null, warnings: [], fills: [] }
          const current: WorkingRound = { result, start: known ? row.time : coverage.from, end: coverage.to, openQuantity: new Money(0), openValue: new Money(0), closeQuantity: new Money(0), closeValue: new Money(0), gross: new Money(0), grossKnown: true, feeMap: new Map(), feeCost: new Money(0), feesKnown: true, funding: new Money(0), fundingKnown: true, peak: quantity.abs() }
          if (!known) warning(current, '开仓早于已读全范围，开仓价、完整费用和最终净盈亏待补齐。')
          work.push(current)
          return current
        }
        if (!quantity.isZero()) active = begin(fills[0] ?? sample, quantity.isPositive() ? 1 : -1, false)
        for (const row of fills) {
          const delta = signedQuantity(row), next = quantity.plus(delta), increasing = quantity.isZero() || quantity.isPositive() === delta.isPositive()
          if (side === 'LONG' && next.lt(0) || side === 'SHORT' && next.gt(0)) { invalid = true; break }
          if (!active) active = begin(row, delta.isPositive() ? 1 : -1, true)
          const add = (current: WorkingRound, size: Decimal, opening: boolean, fees: Transaction['fees'], pnl: string | null) => {
            const result = current.result
            result.fills.push({ row, action: opening ? '开仓 / 加仓' : '平仓', quantity: size.toFixed(), fees, realizedPnl: pnl })
            result.lastAt = row.time
            if (row.pnlAsset !== result.pnlAsset || row.asset !== result.asset || row.quoteAsset !== result.pnlAsset) warning(current, '结算币种无法统一核对。')
            for (const fee of fees) {
              current.feeMap.set(fee.asset, (current.feeMap.get(fee.asset) ?? new Money(0)).plus(fee.quantity))
              const value = feeInUnit(row, fee, result.pnlAsset)
              if (value === null) current.feesKnown = false
              else current.feeCost = current.feeCost.plus(value)
            }
            if (!row.fees.length) { current.feesKnown = false; warning(current, '部分成交没有手续费资料。') }
            if (pnl === null) current.grossKnown = false
            else current.gross = current.gross.plus(pnl)
            if (opening) {
              current.openQuantity = current.openQuantity.plus(size); current.openValue = current.openValue.plus(size.mul(row.price!))
              if (pnl !== null && !new Money(pnl).isZero()) warning(current, '开仓成交出现平仓盈亏，需在平台核对。')
            } else { current.closeQuantity = current.closeQuantity.plus(size); current.closeValue = current.closeValue.plus(size.mul(row.price!)) }
          }
          if (increasing) {
            add(active, delta.abs(), true, row.fees, row.realizedPnl)
            active.peak = Money.max(active.peak, next.abs())
          } else {
            const closed = Money.min(quantity.abs(), delta.abs()), flipped = delta.abs().gt(quantity.abs())
            const closeFees = row.fees.map(fee => ({ asset: fee.asset, quantity: flipped ? new Money(fee.quantity).mul(closed).div(delta.abs()).toFixed() : fee.quantity }))
            add(active, closed, false, closeFees, row.realizedPnl)
            if (next.isZero() || flipped) {
              active.result.closedAt = row.time; active.end = row.time
              if (active.result.openedAt !== null) active.result.status = '已平仓'
              active = null
            }
            if (flipped) {
              active = begin(row, next.isPositive() ? 1 : -1, true)
              const openFees = row.fees.map((fee, i) => ({ asset: fee.asset, quantity: new Money(fee.quantity).minus(closeFees[i].quantity).toFixed() }))
              add(active, next.abs(), true, openFees, '0'); active.peak = next.abs()
            }
          }
          quantity = next
        }
        if (invalid) break
        if (!quantity.eq(endQuantity)) { invalid = true; break }
      }
      if (invalid) { warnings.push(label + '：仓位数量与成交对不上，暂不合并。'); continue }
      const incomes = syncWindows(state.syncs).filter(item => item.identity === sample.identity && item.key === 'income' && item.coverage)
      const fundingRows = state.records.filter(row => row.identity === sample.identity && row.scope === 'usdm' && row.type === '资金费')
      const fullIncomes = incomes.filter(income => fundingRows.filter(row => row.time >= income.coverage!.from && row.time <= income.coverage!.to).length === income.coverage!.count)
      for (const current of work) {
        const fix = fundingFixes[current.result.id]
        if (fix !== undefined) { current.fixed = true; current.funding = new Money(fix); current.result.fundingManual = true }
        else if (!fullIncomes.some(income => income.coverage!.from <= current.start && income.coverage!.to >= current.end)) { current.fundingKnown = false; warning(current, '资金费读取范围不完整，最终净盈亏待核对。') }
      }
      for (const row of fundingRows.filter(row => row.symbol === sample.symbol && row.time >= coverage.from && row.time <= coverage.to)) {
        const owners = work.filter(current => row.time >= current.start && row.time <= current.end)
        if (owners.some(current => current.fixed)) continue
        if (owners.length === 1 && row.time > owners[0].start && row.time < owners[0].end && row.asset === owners[0].result.pnlAsset) owners[0].funding = owners[0].funding.plus(row.quantity)
        else for (const current of owners.length ? owners : work) { current.fundingKnown = false; warning(current, '资金费可能涉及同时持有的多空仓位或开平仓同一时刻，无法准确分摊。') }
      }
      const unmatched = state.records.filter(row => row.identity === sample.identity && row.scope === 'usdm' && row.symbol === sample.symbol && !isTransactionReward(row) && ['手续费', '已实现盈亏', '其他收支'].includes(row.type))
      for (const current of work) {
        const result = current.result
        if (!result.fills.length) continue
        if (result.closedAt === null && windows.some(item => item.coverage!.to > coverage.to)) { result.status = '资料不全'; warning(current, '此后有未读取的时段，当前是否平仓尚未确认。') }
        result.fees = [...current.feeMap].map(([asset, quantity]) => ({ asset, quantity: quantity.toFixed() }))
        if (!current.feesKnown && result.fees.some(fee => fee.asset !== result.pnlAsset && !new Money(fee.quantity).isZero())) warning(current, '含其他币种手续费，未折算成结算币，最终净盈亏待核对。')
        if (unmatched.some(row => row.time >= current.start && row.time <= current.end)) warning(current, '该时段还有未与成交核对的合约收支，最终净盈亏待核对。')
        if (!current.grossKnown) warning(current, '部分成交未提供平仓盈亏。')
        result.realizedPnl = current.grossKnown ? current.gross.toFixed() : null
        result.feePnl = current.feesKnown ? current.feeCost.negated().toFixed() : null
        result.fundingPnl = current.fundingKnown ? current.funding.toFixed() : null
        result.closedQuantity = current.closeQuantity.toFixed()
        result.openPrice = result.openedAt !== null && current.openQuantity.gt(0) ? current.openValue.div(current.openQuantity).toFixed() : null
        result.closePrice = current.closeQuantity.gt(0) ? current.closeValue.div(current.closeQuantity).toFixed() : null
        result.maxQuantity = result.openedAt !== null ? current.peak.toFixed() : null
        if (result.status === '已平仓' && !result.warnings.length) result.netPnl = current.gross.minus(current.feeCost).plus(current.funding).toFixed()
        const netFix = netFixes[result.id]
        if (netFix !== undefined && result.closedAt !== null) { result.status = '已平仓'; result.warnings = []; result.netPnl = netFix; result.netManual = true }
        // shortcut: 成交接口没有历史保证金；有可核对的历史保证金来源后再计算回报率。
        rounds.push(result)
      }
    }
    if (trades.some(row => !windows.some(item => row.time >= item.coverage!.from && row.time <= item.coverage!.to))) warnings.push(label + '：部分流水缺少完整核对资料，可在“全部流水”查看。')
  }
  return { rounds: rounds.sort((a, b) => (b.closedAt ?? b.lastAt) - (a.closedAt ?? a.lastAt) || a.id.localeCompare(b.id)), warnings }
}

// 整轮手续费：已折成结算币的用 feePnl（与整轮净收益同口径），否则保留原币。
export const roundFees = (round: ContractRound) => round.feePnl != null ? [{ asset: round.pnlAsset, quantity: new Money(round.feePnl).negated().plus(0).toFixed() }] : round.fees

export function contractAmount(value: string, places = 2): string {
  const number = new Money(value)
  const rounded = number.toDecimalPlaces(places)
  return !number.isZero() && rounded.isZero() ? number.toSignificantDigits(4).toFixed() : rounded.toFixed()
}

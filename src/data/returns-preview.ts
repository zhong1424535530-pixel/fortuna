import { Decimal } from 'decimal.js'
import type { ContractPosition } from './portfolio.ts'
import type { Transaction, TransactionState } from './transactions.ts'
import type { PeriodTrade } from './returns-period.ts'
import { periodSpotPnl, valueRecordedEntries } from './returns-period.ts'
import { buildReturnEntries, returnTotal } from './returns-analysis.ts'
import type { periodOverview, comparisonPeriods } from './returns-comparison.ts'
import { returnCurveDays } from './returns-curve.ts'
import type { ReturnCurve } from './returns-curve.ts'

// 仅供收益页临时预览；不接入保存、同步或真实账户。
export const previewSource = 'live-00000000-0000-4000-8000-000000000001'
const connectionId = previewSource.slice(5), identity = 'returns-preview'
const Money = Decimal.clone({ precision: 80 })
type Bounds = { start: number; end: number }

export function createReturnsPreview(periods: ReturnType<typeof comparisonPeriods>) {
  const state: TransactionState = { records: [], syncs: [] }
  const overviews: ReturnType<typeof periodOverview>[] = []
  const curves: ReturnCurve[] = []
  let sequence = 0
  for (const [periodIndex, period] of [periods.current, ...(periods.previous ? [periods.previous] : [])].entries()) {
    const bounds: Bounds = { start: period.start || period.end - 30 * 86400000, end: period.end }
    const scale = periodIndex ? '0.72' : '1'
    const amount = (value: string | number) => new Money(value).mul(scale).toFixed()
    const at = (fraction: number) => Math.round(bounds.start + (bounds.end - bounds.start) * fraction)
    const record = (values: Partial<Transaction>): Transaction => {
      const row: Transaction = {
        id: `preview:${periodIndex}:${++sequence}`, connectionId, connectionName: '演示投资账户', identity,
        account: '演示投资账户', scope: 'usdm', type: '资金费', time: at(0.5), asset: 'USDT', quantity: '0',
        symbol: '', quoteAsset: 'USDT', quoteQuantity: null, price: null, fees: [], realizedPnl: null,
        pnlAsset: 'USDT', status: '已完成', orderId: '', txHash: '', network: '', address: '',
        note: '模拟数据', relatedTradeId: '', ...values,
      }
      state.records.push(row)
      return row
    }
    const trades = [
      { symbol: 'BTCUSDT', price: 62000, quantity: '0.1', pnl: 320, short: false },
      { symbol: 'ETHUSDT', price: 2800, quantity: '1', pnl: -145, short: true },
      { symbol: 'SOLUSDT', price: 150, quantity: '10', pnl: 180, short: false },
      { symbol: 'BTCUSDT', price: 65000, quantity: '0.05', pnl: -78, short: true },
      { symbol: 'ETHUSDT', price: 3000, quantity: '2', pnl: 210, short: false },
      { symbol: 'BNBUSDT', price: 600, quantity: '2', pnl: -62, short: false },
    ]
    const dailyContracts = returnCurveDays(bounds.start, bounds.end) === 30
    const scheduledTrades = dailyContracts ? Array.from({ length: 30 }, (_, index) => trades[index % trades.length]) : trades
    scheduledTrades.forEach((trade, dayIndex) => {
      const index = dayIndex % trades.length
      // 30天示例把原有六轮各拆为五轮，总收益与其他预览卡片保持一致。
      const tradeAmount = (value: string | number) => new Money(amount(value)).div(dailyContracts ? 5 : 1).toFixed()
      const dayStart = bounds.start + dayIndex * 86400000, dayEnd = Math.min(dayStart + 86400000 - 1, bounds.end)
      const tradeAt = (fraction: number) => dailyContracts ? Math.round(dayStart + (dayEnd - dayStart) * fraction) : at((index + fraction) / 7)
      const openPrice = new Money(trade.price), pnl = tradeAmount(trade.pnl)
      const closePrice = openPrice.plus(new Money(pnl).div(trade.quantity).mul(trade.short ? -1 : 1))
      const fill = { symbol: trade.symbol, asset: trade.symbol.slice(0, -4), quantity: trade.quantity, positionSide: trade.short ? 'SHORT' as const : 'LONG' as const }
      record({ ...fill, type: trade.short ? '卖出' : '买入', time: tradeAt(0.15), price: openPrice.toFixed(), quoteQuantity: openPrice.mul(trade.quantity).toFixed(), realizedPnl: '0', fees: [{ asset: 'USDT', quantity: tradeAmount(new Money('2.4').plus(new Money(index).mul('0.3')).toFixed()) }] })
      record({ type: '资金费', symbol: trade.symbol, time: tradeAt(0.4), quantity: tradeAmount(index % 2 ? -3.6 - index : 2.8 + index) })
      record({ ...fill, type: trade.short ? '买入' : '卖出', time: tradeAt(0.7), price: closePrice.toFixed(), quoteQuantity: closePrice.mul(trade.quantity).toFixed(), realizedPnl: pnl, fees: [{ asset: 'USDT', quantity: tradeAmount(new Money('2.6').plus(new Money(index).mul('0.3')).toFixed()) }] })
    })
    record({ type: '手续费', scope: 'spot', asset: 'BNB', quantity: amount('-0.005'), price: '600', time: at(0.2) })
    record({ type: '手续费', scope: 'spot', quantity: amount('1.2'), time: at(0.6), note: '手续费退回（模拟）' })
    record({ type: '奖励', quantity: amount('168.4'), time: at(0.3), note: 'COMMISSION_REBATE' })
    const rewardTime = at(0.55), ethReward = amount('0.04')
    record({ type: '奖励', asset: 'ETH', quantity: ethReward, time: rewardTime, note: 'COMMISSION_REBATE', rewardValuation: { price: '3000', usdtQuantity: new Money(ethReward).mul(3000).toFixed(), at: Math.floor(rewardTime / 60000) * 60000, pair: 'ETHUSDT', basis: 'minute-open' } })
    record({ type: '奖励', quantity: amount('25'), time: at(0.85), note: 'CONTEST_REWARD' })

    const periodRecords = state.records.filter(row => row.time >= bounds.start && row.time <= bounds.end)
    for (const symbol of new Set(trades.map(trade => trade.symbol))) {
      state.syncs.push({ connectionId, connectionName: '演示投资账户', identity, key: 'usdm:' + symbol, label: symbol + ' 模拟成交', status: 'ok', from: bounds.start, to: bounds.end, at: bounds.end, lastSuccess: bounds.end, warning: '', coverage: { from: bounds.start, to: bounds.end, count: periodRecords.filter(row => row.symbol === symbol && ['买入', '卖出'].includes(row.type)).length }, positionCheck: { at: bounds.end, positions: [{ side: 'LONG', quantity: '0' }, { side: 'SHORT', quantity: '0' }, { side: 'BOTH', quantity: '0' }] } })
    }
    state.syncs.push({ connectionId, connectionName: '演示投资账户', identity, key: 'income', label: '模拟资金费', status: 'ok', from: bounds.start, to: bounds.end, at: bounds.end, lastSuccess: bounds.end, warning: '', coverage: { from: bounds.start, to: bounds.end, count: periodRecords.filter(row => row.type === '资金费').length } })

    const spot: PeriodTrade[] = [
      { label: '比特币 BTC', market: 'crypto', opening: 12000, closing: 14120, buys: 3000, sells: 1800 },
      { label: '以太坊 ETH', market: 'crypto', opening: 6400, closing: 5680, buys: 1200, sells: 1600 },
      { label: 'Solana SOL', market: 'crypto', opening: 2100, closing: 2850, buys: 500, sells: 0 },
      { label: '英伟达 NVDA', market: 'us', opening: 4800, closing: 6150, buys: 1000, sells: 400 },
      { label: '苹果 AAPL', market: 'us', opening: 3600, closing: 3120, buys: 800, sells: 1000 },
      { label: '特斯拉 TSLA', market: 'us', opening: 2200, closing: 2480, buys: 600, sells: 300 },
      { label: '黄金', market: 'other', opening: 3000, closing: 3260, buys: 0, sells: 0 },
    ].map((item, index) => {
      const components = { opening: amount(item.opening), closing: amount(item.closing), buys: amount(item.buys), sells: amount(item.sells), incoming: '0', outgoing: '0', fees: '0', rewards: '0' }
      return { id: `preview-spot-${index}`, label: item.label, market: item.market, account: '演示投资账户', count: 4 + index, reason: '模拟：期末价值 − 期初价值 + 卖出 − 买入', amount: periodSpotPnl(components), components }
    })
    const native = buildReturnEntries(periodRecords), valued = valueRecordedEntries(native, 'USDT')
    const net = returnTotal([...valued.entries, ...spot.map(row => ({ asset: 'USDT', amount: row.amount! }))])!
    overviews.push({ net, comparable: net, rate: new Money(net).div(50000).mul(100).toFixed(), rateReason: '', reasons: [], native, valued, spot, spotStart: null })
    // 虚构的每日持仓盈亏，末日与上面的现货盈亏及已实现收支相符；真实曲线不使用这些数值。
    const marks = periodIndex ? [0, 40, 120, 90, 210, 160, 340, 290, 410, 380, 570, 510, 740, 660, 840, 790, 960, 900, 1140, 1090, 1250, 1350, 1560] : [0, -80, 50, 140, 90, 310, 260, 470, 420, 680, 610, 780, 710, 950, 860, 1080, 1010, 1230, 1170, 1360, 1280, 1410, 1560]
    const days = returnCurveDays(bounds.start, bounds.end), samples = Math.min(days, 366)
    curves.push({ days, points: Array.from({ length: samples }, (_, index) => {
      const day = samples === 1 ? days : 1 + Math.round(index * (days - 1) / (samples - 1))
      const time = Math.min(bounds.start + day * 86400000 - 1, bounds.end)
      const mark = marks[days === 1 ? marks.length - 1 : Math.round((day - 1) / (days - 1) * (marks.length - 1))]
      const cash = valued.entries.filter(entry => entry.time <= time).reduce((value, entry) => value.plus(entry.amount), new Money(0))
      return { day, time, amount: cash.plus(amount(mark)).toFixed() }
    }) })
  }
  return { state, overview: overviews[0], previous: overviews[1] ?? null, curves: { current: curves[0], previous: curves[1] ?? null } }
}

export const previewContracts: ContractPosition[] = [
  { id: 'preview-btc', symbol: 'BTCUSDT', name: '比特币', icon: '/icons/btc.png', accountId: 'preview-contracts', direction: '做多', quantity: 0.1, baseAsset: 'BTC', entryPriceUsd: 62000, markPriceUsd: 65400, leverage: 3, marginMode: '逐仓', marginCents: 206667, liquidationPriceUsd: 42000, unrealizedPnlCents: 34000 },
  { id: 'preview-eth', symbol: 'ETHUSDT', name: '以太坊', icon: '/icons/eth.png', accountId: 'preview-contracts', direction: '做空', quantity: 1, baseAsset: 'ETH', entryPriceUsd: 2800, markPriceUsd: 2920, leverage: 2, marginMode: '逐仓', marginCents: 140000, liquidationPriceUsd: 4100, unrealizedPnlCents: -12000 },
]

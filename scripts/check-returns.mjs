// 仅使用虚构记录；用户同意模拟测试后再运行。
import assert from 'node:assert/strict'
import { Decimal } from 'decimal.js'
import { buildReturnEntries, filterReturnEntries, returnDays, returnTotal, closedReturnStats, closedReturnDays, closedFundingBreakdown } from '../src/data/returns-analysis.ts'
import { periodSpotPnl, spotPeriodRows, tradingRanking, valueRecordedEntries } from '../src/data/returns-period.ts'
import { appendEquityPoint, validEquityPoint } from '../src/data/equity-history.ts'

// 期中卖一半、下旬加仓，按本期起点算，不能带入更早买入成本。
assert.equal(periodSpotPnl({ opening: '1000', closing: '1040', buys: '330', sells: '600', incoming: '0', outgoing: '0', fees: '0', rewards: '0' }), '310')
assert.equal(periodSpotPnl({ opening: '1000', closing: '1100', buys: '0', sells: '0', incoming: '100', outgoing: '0', fees: '0', rewards: '0' }), '0', '转入本金不是盈利')
assert.equal(periodSpotPnl({ opening: '1000', closing: '1090', buys: '0', sells: '0', incoming: '0', outgoing: '0', fees: '10', rewards: '0' }), '100', '持仓已扣的费用还原后再单列扣一次')
assert.equal(periodSpotPnl({ opening: '1000', closing: '1100', buys: '0', sells: '0', incoming: '0', outgoing: '0', fees: '0', rewards: '100' }), '0', '收到奖励不冒充价格上涨')
assert.equal(periodSpotPnl({ opening: null, closing: '1040', buys: '330', sells: '600', incoming: '0', outgoing: '0', fees: '0', rewards: '0' }), null)

const row = (extra = {}) => ({ id: 'trade', connectionId: 'source', connectionName: '账户', identity: 'owner', account: '合约', scope: 'usdm', type: '卖出', time: Date.parse('2026-10-20T12:00:00+08:00'), asset: 'BTC', quantity: '1', symbol: 'BTCUSDT', quoteAsset: 'USDT', quoteQuantity: '10', price: '10', fees: [{ asset: 'USDT', quantity: '0.1' }], realizedPnl: '2', pnlAsset: 'USDT', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: '', relatedTradeId: '', ...extra })
const trade = row()
const entries = buildReturnEntries([
  trade, trade,
  row({ id: 'income', type: '已实现盈亏', asset: 'USDT', quantity: '2', fees: [], relatedTradeId: trade.id }),
  row({ id: 'fee', type: '手续费', asset: 'USDT', quantity: '-0.1', fees: [], relatedTradeId: trade.id }),
  row({ id: 'transfer', type: '账户间转账', quantity: '1000', fees: [], realizedPnl: null }),
  row({ id: 'reward', type: '奖励', asset: 'USDC', quantity: '5', fees: [], realizedPnl: null }),
  row({ id: 'funding', type: '资金费', asset: 'USDT', quantity: '-0.2', fees: [], realizedPnl: null }),
  row({ id: 'failed', type: '卖出', status: '失败', realizedPnl: '500', fees: [] }),
  row({ id: 'gas', scope: 'wallet:eth', type: '转出', status: '失败', fees: [{ asset: 'ETH', quantity: '0.001' }], realizedPnl: null }),
  row({ id: 'spot', scope: 'spot', type: '卖出', quoteQuantity: '9999', realizedPnl: null, fees: [] }),
])
assert.equal(returnTotal(entries.filter(item => item.asset === 'USDT')), '1.7')
assert.equal(returnTotal(entries.filter(item => item.asset === 'USDC')), '5')
assert.equal(returnTotal(entries.filter(item => item.asset === 'ETH')), '-0.001')
assert.equal(returnTotal(entries), null, '不同币种不能合并')
assert.equal(returnTotal([]), null, '没有记录不冒充零')
assert.equal(entries.some(item => item.row.id === 'transfer' || item.row.id === 'spot' || item.row.id === 'failed'), false)
const bounds = { start: trade.time, end: trade.time }
const periodStart = trade.time - 86400000
const investmentAccount = ['live-source-spot', 'live-source', '测试现货账户', '现货', 'ok']
const point = (time, quantity, cents) => ({ t: time / 1000, net: cents ?? 0, gross: cents ?? 0, rows: [], prices: [['binance:USDT', 1]], contracts: [], accounts: [], investmentPositions: [['binance:BTC', 'BTC', 'crypto', investmentAccount[0], quantity, cents]], investmentAccounts: [investmentAccount] })
const openingPoint = point(periodStart, '10', 100000), closingPoint = point(trade.time, '8', 104000)
assert(validEquityPoint(openingPoint, trade.time / 1000), '新持仓资料可保存')
assert(validEquityPoint(point(trade.time, '8', null), trade.time / 1000), '未知市值用null保存，不能改成0')
const monthEdge = Date.parse('2026-10-01T00:01:00+08:00') / 1000
const compressed = appendEquityPoint([point((monthEdge - 1860) * 1000, '10', 100000), point(monthEdge * 1000, '10', 100000), point((monthEdge + 1740) * 1000, '10', 100000)], closingPoint, trade.time / 1000)
assert(compressed.some(item => item.t === monthEdge), '整理历史不能删掉已有月初估值')
const spotTrades = [row({ id: 'spot-sell', scope: 'spot', type: '卖出', time: periodStart + 3600000, quantity: '5', price: '120', quoteQuantity: '600', fees: [], realizedPnl: null }), row({ id: 'spot-buy', scope: 'spot', type: '买入', time: periodStart + 7200000, quantity: '3', price: '110', quoteQuantity: '330', fees: [], realizedPnl: null })]
const spotSync = { connectionId: 'source', identity: 'owner', key: 'spot:BTCUSDT', status: 'ok', from: trade.time - 600000, to: trade.time, coverage: { from: periodStart, to: trade.time, count: 2 } }
const spotState = { records: spotTrades, syncs: [spotSync] }
const spotFilter = { start: periodStart, end: trade.time, source: '', unit: 'USDT' }
const periodRows = spotPeriodRows(spotState, [openingPoint, closingPoint], spotFilter, [], [investmentAccount])
assert.equal(periodRows[0].amount, '310', '增量请求起点不覆盖累计完整范围')
assert.equal(periodRows[0].partial, true, '数量相等也不能证明其他交易对没有漏读')
assert.equal(spotPeriodRows(spotState, [openingPoint, point(trade.time, '8', null)], spotFilter, [], [investmentAccount])[0].amount, null, '缺价格不能记录为市值零')
assert.equal(spotPeriodRows(spotState, [{ ...openingPoint, investmentPositions: undefined }, closingPoint], spotFilter, [], [investmentAccount])[0].amount, null, '旧快照不能假装可核对完整持仓')
assert.equal(spotPeriodRows({ ...spotState, syncs: [{ ...spotSync, coverage: { ...spotSync.coverage, count: 3 } }] }, [openingPoint, closingPoint], spotFilter, [], [investmentAccount])[0].amount, null, '缺流水条数必须阻止计算')
assert.equal(tradingRanking(entries.filter(item => item.asset === 'USDT')).some(item => item.label === 'BTCUSDT' && item.amount !== '2'), false, '排行只算价格盈亏')
assert.equal(tradingRanking(entries.filter(item => item.category === '奖励收入')).length, 0, '返佣绝不进入交易盈亏排行')
const nativeFees = buildReturnEntries([row({ id: 'bnb-fee', fees: [{ asset: 'BNB', quantity: '0.001' }], realizedPnl: null })])
assert.equal(valueRecordedEntries(nativeFees, 'USDT').missing.length, 1, '未能折算的手续费仍保留原记录')
assert.equal(valueRecordedEntries(nativeFees, 'USDT').entries.length, 0, '不按现价猜测历史费用')
const valuedReward = buildReturnEntries([row({ id: 'bnb-reward', type: '奖励', asset: 'BNB', quantity: '0.1', fees: [], realizedPnl: null, rewardValuation: { price: '500', usdtQuantity: '50', at: trade.time, pair: 'BNBUSDT', basis: 'minute-open' } })])
assert.equal(valueRecordedEntries(valuedReward, 'USDT').entries[0].amount, '50')
assert.equal(valueRecordedEntries(buildReturnEntries([row({ id: 'usdc', type: '资金费', asset: 'USDC', quantity: '1', fees: [], realizedPnl: null })]), 'USDT').missing.length, 1, '资金费不同币种不能当作相同币种')
assert.equal(filterReturnEntries(entries, { ...bounds, asset: 'USDT', source: 'live-source', market: 'contracts' }).length, 3)
assert.equal(filterReturnEntries(entries, { ...bounds, start: trade.time + 1, asset: 'USDT', source: '', market: 'all' }).length, 0)
assert.equal(returnDays(entries.filter(item => item.asset === 'USDT'))[0].cumulative, '1.7')
assert.equal(returnDays([]).length, 0)
const round = (extra = {}) => ({ id: 'round', connectionId: 'source', connectionName: '账户', identity: 'owner', symbol: 'BTCUSDT', asset: 'BTC', pnlAsset: 'USDT', direction: '做多', status: '已平仓', openedAt: trade.time - 86400000, closedAt: trade.time, lastAt: trade.time, openPrice: '1', closePrice: '2', closedQuantity: '1', maxQuantity: '1', realizedPnl: '2', netPnl: '1.8', roi: null, fees: [{ asset: 'USDT', quantity: '0.1' }], fundingPnl: '-0.1', warnings: [], fills: [], ...extra })
const stats = closedReturnStats([round(), round({ id: 'loss', netPnl: '-0.6' }), round({ id: 'zero', netPnl: '0' }), round({ id: 'unknown', netPnl: null }), round({ id: 'open', status: '持仓中', closedAt: null })])
assert.equal(stats.net, '1.2')
assert.equal(stats.confirmed.length, 3)
assert.equal(stats.longCount, 4, '多空笔数独立按已平仓交易统计，不被未换算手续费挡住')
assert.equal(stats.shortCount, 0)
const directions = closedReturnStats([round(), round({ id: 'short-loss', direction: '做空', netPnl: '-100' }), round({ id: 'short-zero', direction: '做空', netPnl: '0' }), round({ id: 'short-open', direction: '做空', status: '持仓中', closedAt: null }), round({ id: 'short-unknown', direction: '做空', netPnl: null }), round({ id: 'short-warning', direction: '做空', warnings: ['待核对'] })])
assert.equal(directions.longCount, 1)
assert.equal(directions.shortCount, 4, '按全部已平仓交易笔数比较方向，不依赖净收益核对结果')
assert.equal(directions.longCount + directions.shortCount, directions.closed.length)
assert.equal(closedReturnStats([]).longCount + closedReturnStats([]).shortCount, 0, '无已平仓交易时不能补造多空比例')
assert.equal(stats.closed.length, 4)
assert.ok(Math.abs(stats.winRate - 100 / 3) < 1e-12)
assert.equal(stats.payoff, '3')
assert.equal(stats.averageWin, '1.8')
assert.equal(stats.averageLoss, '0.6', '平均亏损取绝对值，与平均盈利按同一尺度比较')
assert.equal(closedReturnStats([]).averageWin, null)
assert.equal(closedReturnStats([round()]).averageLoss, null, '没有亏损交易时不能补造平均亏损为零')
assert.equal(closedReturnStats([round({ netPnl: '-2' })]).averageWin, null)
const averages = closedReturnStats([round({ netPnl: '10' }), round({ netPnl: '30' }), round({ netPnl: '-5' }), round({ netPnl: '0' }), round({ netPnl: null })])
assert.equal(averages.averageWin, '20', '只在盈利交易中计算平均盈利，不混入持平或未核对交易')
assert.equal(averages.averageLoss, '5')
assert.equal(averages.payoff, '4')
assert.equal(closedReturnStats([round(), round({ pnlAsset: 'USDC' })]).averageWin, null, '不同币种不能直接计算平均金额')
assert.equal(closedReturnStats([]).net, null)
assert.equal(closedReturnStats([]).winRate, null)
assert.equal(closedReturnStats([round({ netPnl: null })]).winRate, null)
assert.equal(closedReturnStats([round(), round({ id: 'usdc', pnlAsset: 'USDC' })]).net, null)
assert.equal(closedReturnStats([round({ warnings: ['资料不全'] })]).confirmed.length, 0)
const zeroForeignFee = closedReturnStats([round({ fees: [{ asset: 'USDT', quantity: '0.1' }, { asset: 'BNB', quantity: '0' }] })])
assert.equal(zeroForeignFee.fees, '-0.1')
assert.equal(new Decimal(zeroForeignFee.gross).plus(zeroForeignFee.fees).plus(zeroForeignFee.funding).toFixed(), zeroForeignFee.net)
assert.deepEqual(closedReturnDays([round()]), [{ label: '2026-10-20', amount: '1.8', cumulative: '1.8' }], '整轮净收益归平仓日，不回填开仓日')
const fundingEntries = buildReturnEntries([row({ id: 'received', type: '资金费', time: trade.time - 3600000, asset: 'USDT', quantity: '0.2', fees: [], realizedPnl: null }), row({ id: 'paid', type: '资金费', time: trade.time - 1800000, asset: 'USDT', quantity: '-0.3', fees: [], realizedPnl: null })])
assert.deepEqual(closedFundingBreakdown([round()], fundingEntries), { income: '0.2', expense: '-0.3' })
assert.deepEqual(closedFundingBreakdown([round()], []), { income: null, expense: null }, '缺少资金费明细时不伪造收支各为零')
assert.deepEqual(closedFundingBreakdown([], []), { income: null, expense: null })
assert.equal(returnTotal(buildReturnEntries([row({ fees: [{ asset: 'USDT', quantity: '-0.1' }], realizedPnl: '0' })])), '0.1')
assert.equal(returnTotal(buildReturnEntries([row({ realizedPnl: '0.00000001', fees: [] }), row({ id: 'tiny', realizedPnl: '0.00000002', fees: [] })])), '0.00000003')
console.log('收益分析自检通过：原币种、重复记账、转账、费用、时间与已平仓样本。')

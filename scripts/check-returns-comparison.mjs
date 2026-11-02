// 用户单独同意后运行；纯假资料、固定时钟，不连接服务、账户或钥匙串。
import assert from 'node:assert/strict'
import { compareReturnAmounts, comparisonCategoryAmounts, comparisonDifference, comparisonPeriods, periodOverview } from '../src/data/returns-comparison.ts'
import { spotPeriodRows } from '../src/data/returns-period.ts'

const at = date => Date.parse(date + '+08:00')
const month = comparisonPeriods({ period: '自定义', start: '2026-10-01', end: '2026-10-23' }, 'month', at('2026-10-23T17:21:13.123'))
assert.equal(month.previous.start, at('2026-09-01T00:00:00'))
assert.equal(month.previous.end, at('2026-09-23T17:21:13.123'), '未结束的月份按相同日、相同时刻比较')
const short = comparisonPeriods({ period: '30天' }, 'month', at('2026-03-31T18:00:00'))
assert.equal(short.previous.end, at('2026-02-28T18:00:00'), '短月截止到真实月末，不能溢出回三月')
const leap = comparisonPeriods({ period: '1年' }, 'year', at('2024-02-29T10:30:00'))
assert.equal(leap.previous.start, at('2023-01-01T00:00:00'))
assert.equal(leap.previous.end, at('2023-02-28T10:30:00'))
const january = comparisonPeriods({ period: '7天' }, 'month', at('2026-01-23T18:00:00'))
assert.equal(january.previous.start, at('2025-12-01T00:00:00'))
for (const period of ['7天', '30天', '1天', '1年']) {
  const result = comparisonPeriods({ period }, null, at('2026-10-23T17:21:00'))
  const days = period === '7天' ? 7 : period === '30天' ? 30 : period === '1天' ? 1 : 365
  assert.equal(result.current.start - result.previous.start, days * 86400000)
  assert.equal(result.current.end - result.previous.end, days * 86400000)
  assert.equal(result.current.end - result.current.start, result.previous.end - result.previous.start)
}
const custom = comparisonPeriods({ period: '自定义', start: '2026-10-10', end: '2026-10-16' }, null, at('2026-10-23T17:21:00'))
assert.equal(custom.previous.start, at('2026-10-03T00:00:00'))
assert.equal(custom.previous.end, at('2026-10-09T23:59:59.999'))
const customMonth = comparisonPeriods({ period: '自定义', start: '2026-10-01', end: '2026-10-23' }, null, at('2026-10-23T17:21:00'))
assert.equal(customMonth.label, '较上一期', '手动选出的本月日期仍按自选区间比较')
assert.equal(comparisonPeriods({ period: '全部时间' }, null).previous, null)
assert.equal(comparisonDifference('500', '300'), '200')
assert.equal(comparisonDifference('-20', '-50'), '30', '亏损减少仍是改善，不按负数基数算增长率')
assert.equal(comparisonDifference('0', '0'), '0')
assert.equal(comparisonDifference(null, '0'), null, '缺失不能当实际零')
assert.equal(comparisonDifference('5', '3'), '2', '收益率5%减3%为2个百分点')

const growth = compareReturnAmounts('2165.70', '1559.30')
assert.equal(growth.difference, '606.4')
assert.equal(Number(growth.percent).toFixed(2), '38.89', '按收益金额的涨幅计算，不用收益率相减')
assert.equal(compareReturnAmounts('75', '100').percent, '-25')
assert.equal(compareReturnAmounts('-20', '-50').label, '比上期少亏')
assert.equal(compareReturnAmounts('-80', '-50').label, '比上期多亏')
assert.equal(compareReturnAmounts('-20', '-50').percent, null, '上期亏损不套用负数基数涨幅')
assert.equal(compareReturnAmounts('20', '-50').label, '扭亏为盈 · 增加')
assert.equal(compareReturnAmounts('-20', '50').label, '由盈转亏 · 减少')
assert.equal(compareReturnAmounts('-20', '50').percent, '-140', '正数基数下由盈转亏，金额降幅可以超过100%')
assert.equal(compareReturnAmounts('0', '-50').label, '亏损归零 · 少亏')
assert.equal(compareReturnAmounts('10', '0').percent, null)
assert.equal(compareReturnAmounts('0', '0').label, '与上期持平')
for (const values of [[null, '0'], ['0', null], [null, null]]) {
  assert.equal(compareReturnAmounts(...values).difference, null)
  assert.equal(compareReturnAmounts(...values).percent, null)
}
assert.equal(compareReturnAmounts('0.00000001', '0.00000002').percent, '-50', '保留原始金额精度，不先四舍五入到零')
const spending = compareReturnAmounts('-15', '-10', 'cashflow')
assert.equal(spending.percent, '50')
assert.equal(spending.percentLabel, '净支出增加')
assert.equal(spending.tone, 'negative', '支出增加不能显示成收益改善')
const savings = compareReturnAmounts('-5', '-10', 'cashflow')
assert.equal(savings.percent, '-50')
assert.equal(savings.percentLabel, '净支出减少')
assert.equal(savings.tone, 'positive')
assert.equal(compareReturnAmounts('5', '-10', 'cashflow').percent, null)
assert.equal(compareReturnAmounts('-5', '10', 'cashflow').percent, null)
assert.equal(compareReturnAmounts('-5', '0', 'cashflow').percent, null)
assert.equal(compareReturnAmounts('15', '10', 'cashflow').percent, '50')
assert.deepEqual(comparisonCategoryAmounts(null), { spot: null, contracts: null, fees: null, funding: null, rewards: null })


const start = at('2026-10-21T00:00:00'), end = at('2026-10-21T23:59:59.999'), connectionId = '12345678-1234-1234-1234-123456789abc'
const filter = { start, end, source: 'live-' + connectionId, unit: 'USDT' }
const account = 'live-' + connectionId + '-spot', futures = 'live-' + connectionId + '-usdm'
const accounts = [[account, filter.source, '假账户', '现货', 'ok'], [futures, filter.source, '假账户', '合约', 'ok']]
const point = t => ({ t: Math.floor(t / 1000), net: 200000, gross: 200000, rows: [], prices: [['binance:USDT', 1]], contracts: [], accounts: [[account, 100000], [futures, 100000]], investmentAccounts: accounts, investmentPositions: [['binance:USDT', 'USDT', 'cash', account, '1000', 100000]] })
const points = [point(start), point(end)]
const keys = ['deposits', 'withdrawals', 'income', 'income:other', 'rewards:spot', 'coverage:spot', 'coverage:usdm']
const syncs = keys.map(key => ({ connectionId, connectionName: '假账户', identity: 'fake', key, label: key, status: 'ok', from: start - 1, to: end, at: end, lastSuccess: end, warning: '' }))
const empty = periodOverview({ records: [], syncs }, points, filter, [], accounts)
assert.deepEqual(empty.reasons, [])
assert.equal(empty.comparable, '0', '完整且实际没有收益时才可确认零')
assert.equal(empty.rate, '0')
assert.deepEqual(comparisonCategoryAmounts(empty), { spot: '0', contracts: '0', fees: '0', funding: '0', rewards: '0' }, '完整范围内没有记录才能按真实零比较')
const spotOnlyPoints = points.map(point => ({ ...point, accounts: point.accounts.filter(row => row[0] === account), investmentAccounts: [accounts[0]] }))
assert.equal(periodOverview({ records: [], syncs }, spotOnlyPoints, filter, [], [accounts[0]]).net, '0', '已完整确认的零必须同时用于大金额和对比')
const reward = { id: 'reward:1', connectionId, connectionName: '假账户', identity: 'fake', account: '合约', scope: 'usdm', type: '奖励', time: start + 120000, asset: 'USDT', quantity: '10', symbol: '', quoteAsset: '', quoteQuantity: null, price: null, fees: [], realizedPnl: null, pnlAsset: '', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: 'COMMISSION_REBATE', relatedTradeId: '' }
const valued = periodOverview({ records: [reward], syncs }, points, filter, [], accounts)
assert.equal(valued.comparable, '10')
assert.equal(comparisonCategoryAmounts(valued).rewards, '10')
assert.equal(valued.rate, '0.5')
const shifted = periodOverview({ records: [reward], syncs }, [point(start + 240000), point(end - 60000)], filter, [], accounts)
assert.equal(shifted.comparable, null, '持仓估值边界与完整日期不一致，不得计算对比')
assert.equal(shifted.rate, null)
const shortScopes = syncs.map(scope => ({ ...scope, to: end - 240000 }))
const shortCoverage = periodOverview({ records: [reward], syncs: shortScopes }, points, filter, [], accounts)
assert.equal(shortCoverage.comparable, null, '快照完整但流水少最后4分钟，仍不能比较')
assert.equal(shortCoverage.rate, null, '缺口期间可能有充值提现，不能冒称无资金进出')
const missing = periodOverview({ records: [reward], syncs: [] }, points, filter, [], accounts)
assert.equal(missing.net, '10', '已记录部分可以显示，但不能冒称完整收益')
assert.equal(missing.comparable, null)
assert.deepEqual(comparisonCategoryAmounts(missing), { spot: null, contracts: null, fees: null, funding: null, rewards: null }, '资料不齐时所有分类都保留未知，不把缺失当零算涨幅')
assert.equal(comparisonDifference(valued.comparable, missing.comparable), null)
assert.equal(periodOverview({ records: [reward], syncs }, [], filter, [], accounts).comparable, null)
const foreignFee = { ...reward, id: 'fee:1', type: '手续费', asset: 'BNB', quantity: '-0.01', note: '' }
assert.equal(periodOverview({ records: [reward, foreignFee], syncs }, points, filter, [], accounts).comparable, null, '原币费用缺价不能比较偏高的净收益')
const deposit = { ...reward, id: 'deposit:1', type: '充值', quantity: '100', note: '' }
const cashflow = periodOverview({ records: [reward, deposit], syncs }, points, filter, [], accounts)
assert.equal(cashflow.comparable, '10', '充值不算收益')
assert.equal(cashflow.rate, null, '期间有资金进出不能直接用期初本金算收益率')
const manual = ['manual', 'manual', '房产账户', '手动', 'pending']
const manualPosition = ['manual-home', 'HOME', 'other', 'manual', '1', 100000]
const manualRows = spotPeriodRows({ records: [], syncs: [] }, [], { ...filter, source: '' }, [manualPosition], [manual])
assert.equal(manualRows.length, 1, '手动其他资产也进入排行候选')
assert.equal(manualRows[0].market, 'other')
assert.equal(manualRows[0].amount, null, '没有投入取出记录不把修改估值当收益')
assert.equal(spotPeriodRows({ records: [], syncs: [] }, [], filter, [manualPosition], [manual]).length, 0, '来源筛选不串入手动资产')
for (const market of ['crypto', 'other']) {
  const attached = ['manual-attached', 'BTC', market, account, '1', 100000]
  const candidate = spotPeriodRows({ records: [], syncs: [] }, points, filter, [attached], accounts)
  assert.equal(candidate.length, 1, '手动资产挂现货账户仍进入排行')
  assert.equal(candidate[0].amount, null)
  assert(candidate[0].reason.includes('手动'), '按资产来源识别，不能用账户类型代替')
}
const manualCash = ['manual-cash', 'USDT', 'cash', account, '500', 50000]
const cashPoints = points.map(point => ({ ...point, investmentPositions: [...point.investmentPositions, manualCash] }))
const editedCash = periodOverview({ records: [reward], syncs }, cashPoints, filter, [manualCash], accounts)
assert.equal(editedCash.comparable, null, '手动现金改余额不能绕过完整收益校验')
assert.equal(editedCash.rate, null)
console.log('收益周期对比隔离检查通过：同期、等长区间、闰日、全部、真实零与缺失、资金进出、收益率、收益金额涨跌幅、亏损与支出方向及手动资产。')

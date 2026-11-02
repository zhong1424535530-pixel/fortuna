// 用户单独同意后运行；只使用内存中的假资料，不读账户、不发请求、不写账本。
import assert from 'node:assert/strict'
import { spotGroupDays, spotWindow } from '../src/data/returns-period.ts'
import { periodReturnCurve, returnCurveDays, returnCurveEnd } from '../src/data/returns-curve.ts'
import { buildReturnEntries } from '../src/data/returns-analysis.ts'
import { periodOverview, comparisonPeriods } from '../src/data/returns-comparison.ts'
import { createReturnsPreview } from '../src/data/returns-preview.ts'

const at = value => Date.parse(value + '+08:00')
const start = at('2026-10-01T00:00:00'), end = at('2026-10-04T23:59:59.999')
const connectionId = '12345678-1234-1234-1234-123456789abc', source = 'live-' + connectionId
const spot = source + '-spot', futures = source + '-usdm'
const accounts = [[spot, source, '假账户', '现货', 'ok'], [futures, source, '假账户', '合约', 'ok']]
const filter = { start, end, source, unit: 'USDT' }
const syncs = ['deposits', 'withdrawals', 'income', 'income:other', 'rewards:spot', 'coverage:spot', 'coverage:usdm'].map(key => ({ connectionId, connectionName: '假账户', identity: 'fake', key, label: key, status: 'ok', from: start, to: end, at: end, lastSuccess: end, warning: '' }))
const row = (id, type, time, quantity) => ({ id, type, time, quantity, connectionId, connectionName: '假账户', identity: 'fake', account: '合约', scope: 'usdm', asset: 'USDT', symbol: 'BTCUSDT', quoteAsset: '', quoteQuantity: null, price: null, fees: [], realizedPnl: null, pnlAsset: 'USDT', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: '', relatedTradeId: '' })
const state = { syncs, records: [row('reward:1', '奖励', at('2026-10-01T12:00:00'), '10'), row('funding:1', '资金费', at('2026-10-03T12:00:00'), '-2'), row('deposit:1', '充值', at('2026-10-02T12:00:00'), '1000')] }
const point = (time, pnl) => ({ t: Math.floor(time / 1000), net: 200000 + pnl, gross: 200000 + pnl, rows: [], prices: [['binance:USDT', 1]], contracts: [['contract', futures, 62000, pnl]], accounts: [[spot, 100000], [futures, 100000 + pnl]], investmentAccounts: accounts, investmentPositions: [['binance:USDT', 'USDT', 'cash', spot, '1000', 100000]] })
const points = [point(start, 0), point(at('2026-10-01T23:59:59'), 500), point(at('2026-10-03T23:59:59'), -1000), point(end, 2500)]
const build = (data = state, history = points, selected = accounts, scope = filter) => periodReturnCurve(data, history, scope, selected, buildReturnEntries(data.records))
const original = JSON.stringify({ state, points })
const curve = build()
assert.equal(curve.days, 4)
assert.equal(curve.points.find(point => point.day === 1).amount, '10', '累计值只含已实现收支，不含持仓浮盈变化')
assert.equal(curve.points.find(point => point.day === 2).amount, null, '缺日保留断点，不能补零或补平线')
assert.equal(curve.points.find(point => point.day === 3).amount, '8')
assert.equal(curve.points.at(-1).amount, '8', '充值1000不能变成收益')
const overview = periodOverview(state, points, filter, points.at(-1).investmentPositions, accounts)
assert.equal(curve.points.at(-1).amount, overview.comparable, '完整期末曲线与总览金额一致')
assert.equal(JSON.stringify({ state, points }), original, '不修改输入账目与估值记录')
const ended = returnCurveEnd(curve, end, null)
assert.equal(ended.points.at(-1).amount, null, '总览无法确认时，不能沿用旧的期末值')
assert.equal(curve.points.at(-1).amount, '8', '替换末端不修改缓存曲线')

const foreign = { ...row('foreign:1', '奖励', at('2026-10-03T11:00:00'), '5'), asset: 'USDC' }
const missingPrice = build({ ...state, records: [...state.records, foreign] })
assert.equal(missingPrice.points.find(point => point.day === 1).amount, '10')
assert.equal(missingPrice.points.find(point => point.day === 3).amount, '8', '缺历史换算价的USDC不计入已记录部分，也不按USDT硬加')
assert.equal(build({ ...state, syncs: [] }).points.at(-1).amount, periodOverview({ ...state, syncs: [] }, points, filter, points.at(-1).investmentPositions, accounts).net, '读取范围没有记录时，曲线只显示已记录部分，与总览一致')
const old = points.map(({ investmentPositions, investmentAccounts, ...point }) => point)
assert.equal(build(state, old).points.every(point => point.amount === null), true, '旧估值没有数量与账户状态时不能造历史')
assert.equal(build(state, points.map((point, index) => index === 0 ? { ...point, t: point.t + 60 } : point)).points.find(point => point.day === 1).amount, '10', '起点没有快照时从范围内最早的快照起算，不向前倒推')
const lateSnapshot = [...points, point(at('2026-10-02T12:00:00'), 90000)].sort((a, b) => a.t - b.t)
const noon = build(state, lateSnapshot).points.find(point => point.day === 2)
assert.equal(noon.time, at('2026-10-02T12:00:00'), '没有日末快照时取当天最后一份，并标注它的实际时间')
const otherSource = { ...row('other:1', '奖励', at('2026-10-03T11:00:00'), '999'), connectionId: '99999999-1234-1234-1234-123456789abc' }
assert.equal(build({ ...state, records: [...state.records, otherSource] }).points.at(-1).amount, '8', '不混入其他来源')
const afterSnapshot = row('late:1', '奖励', at('2026-10-01T23:59:59.500'), '100')
assert.equal(build({ ...state, records: [...state.records, afterSnapshot] }).points[0].amount, '10', '估值之后的收支不能塞进较早的曲线点')

const spotPoints = points.map((point, index) => ({ ...point, contracts: [], investmentAccounts: [accounts[0]], investmentPositions: [...point.investmentPositions, ['binance:BTC', 'BTC', 'crypto', spot, '0.1', [100000, 110000, 130000, 140000][index]]] }))
const spotState = { records: [], syncs: [...syncs, { ...syncs[0], key: 'spot:BTCUSDT', coverage: { from: start, to: end, count: 0 } }] }
assert.equal(build(spotState, spotPoints, [accounts[0]]).points[0].amount, '100', '现货从期初持仓价值起算')
assert.equal(build(spotState, spotPoints, [accounts[0]]).points.at(-1).amount, '400')
const spotCurrent = spotPoints.at(-1).investmentPositions
const spotDays = spotGroupDays(spotState, spotPoints, filter, spotCurrent, [accounts[0]], 'crypto')
assert.deepEqual(spotDays.map(day => [day.label, day.amount, day.cumulative]), [['2026-10-01', '100', '100'], ['2026-10-03', '200', '300'], ['2026-10-04', '100', '400']], '现货曲线逐日累计，缺日留空不补零')
assert.equal(spotGroupDays(spotState, spotPoints, filter, spotCurrent, [accounts[0]], 'stocks').length, 0, '没有股票持仓时股票曲线为空')
const lateOpening = spotPoints.map((point, index) => index === 0 ? { ...point, t: point.t + 3600 } : point)
assert.equal(spotWindow(lateOpening, filter).start - filter.start, 3600000, '起点没有快照时从范围内最早的快照起算')
assert.equal(spotWindow(spotPoints, filter).start, filter.start, '起点有快照时仍按范围起点')
const stockPoints = spotPoints.map(point => ({ ...point, investmentPositions: point.investmentPositions.map(position => position[1] === 'BTC' ? ['stock', 'NVDA', 'us', spot, '1', position[5]] : position) }))
assert.equal(build(spotState, stockPoints, [accounts[0]]).points.every(point => point.amount === null), true, '未接入的股票交易不能假装算出了完整净收益')

const now = at('2026-10-23T12:00:00')
for (const [range, calendar] of [[{ period: '7天' }, null], [{ period: '30天' }, null], [{ period: '1天' }, null], [{ period: '1年' }, 'month'], [{ period: '1年' }, 'year']]) {
  const periods = comparisonPeriods(range, calendar, now), preview = createReturnsPreview(periods)
  assert.equal(preview.curves.current.points.at(-1).amount, preview.overview.comparable)
  assert.equal(preview.curves.previous.points.at(-1).amount, preview.previous.comparable)
  assert.equal(preview.curves.current.days, returnCurveDays(periods.current.start, periods.current.end))
  assert.ok(preview.curves.current.points.every(point => point.time >= periods.current.start && point.time <= periods.current.end))
  assert.ok(preview.curves.previous.points.every(point => point.time >= periods.previous.start && point.time <= periods.previous.end))
}
assert.equal(returnCurveDays(at('2026-02-01T00:00:00'), at('2026-02-28T12:00:00')), 28)
assert.equal(returnCurveDays(at('2026-03-01T00:00:00'), at('2026-03-31T12:00:00')), 31, '较短的上期不延长到本期日数')
console.log('两期累计净收益曲线检查通过：缺日、日界、充值、来源、现货、旧记录、缺价与模拟期末一致。')

// 用户单独同意后运行；只使用内存中的假交易，不读取账户、不发请求、不写账本。
import assert from 'node:assert/strict'
import { closedReturnCalendarDays, closedReturnDays, closedReturnStats, returnDaySlots } from '../src/data/returns-analysis.ts'
import { buildContractHistory } from '../src/data/contract-history.ts'
import { createReturnsPreview } from '../src/data/returns-preview.ts'
import { comparisonPeriods } from '../src/data/returns-comparison.ts'

const round = (id, closedAt, netPnl, extra = {}) => ({
  id, connectionId: 'fake', connectionName: '假账户', identity: 'fake', symbol: 'BTCUSDT', asset: 'BTC', pnlAsset: 'USDT',
  direction: '做多', status: '已平仓', openedAt: Date.parse('2026-09-28T12:00:00+08:00'),
  closedAt: closedAt === null ? null : Date.parse(closedAt), lastAt: Date.parse('2026-10-04T12:00:00+08:00'),
  openPrice: '100', closePrice: '200', closedQuantity: '1', maxQuantity: '1',
  realizedPnl: '100', netPnl, roi: null, fees: [{ asset: 'USDT', quantity: '3' }], fundingPnl: '-2', warnings: [], fills: [], ...extra,
})
const confirmed = [
  round('win', '2026-10-01T15:59:59Z', '95'),
  round('loss', '2026-10-01T12:00:00+08:00', '-50'),
  round('zero', '2026-10-01T16:00:00Z', '0'),
  round('decimal-a', '2026-10-04T12:00:00+08:00', '0.1'),
  round('decimal-b', '2026-10-04T13:00:00+08:00', '0.2'),
]
const before = JSON.stringify(confirmed)
assert.deepEqual(closedReturnCalendarDays(confirmed), [
  { date: '2026-10-01', count: 2, pending: 0, amount: '45' },
  { date: '2026-10-02', count: 1, pending: 0, amount: '0' },
  { date: '2026-10-04', count: 2, pending: 0, amount: '0.3' },
], '按北京平仓日期合计整轮净收益，不能再扣一次手续费或资金费')
assert.deepEqual(closedReturnCalendarDays(confirmed).map(day => [day.date, day.amount]), closedReturnDays(confirmed).map(day => [day.label, day.amount]), '日历与现有净收益曲线金额一致')
assert.equal(closedReturnStats(confirmed).net, '45.3')
assert.equal(JSON.stringify(confirmed), before, '不修改原始交易')
assert.deepEqual(closedReturnCalendarDays([]), [], '空白日期不能补造零收益')
assert.deepEqual(closedReturnCalendarDays([round('open', null, null, { status: '持仓中' })]), [], '未平仓交易不能归到最后更新日')
const pending = [
  round('known', '2026-10-03T12:00:00+08:00', '10'),
  round('missing', '2026-10-03T13:00:00+08:00', null, { status: '资料不全', warnings: ['费用待补'] }),
]
assert.deepEqual(closedReturnCalendarDays(pending), [{ date: '2026-10-03', count: 2, pending: 1, amount: null }], '同日资料未齐时不能把已知部分冒充完整净收益')
assert.equal(closedReturnCalendarDays([round('warning', '2026-10-03T12:00:00+08:00', '10', { warnings: ['待核对'] })])[0].amount, null)
assert.equal(closedReturnCalendarDays([confirmed[0], { ...confirmed[0], id: 'other-coin', pnlAsset: 'USDC' }])[0].amount, null, '不同统计币种不能硬加')
const at = text => Date.parse(text + '+08:00')
const slots = returnDaySlots(closedReturnDays(confirmed), at('2026-10-01T00:00:00'), at('2026-10-30T23:59:59'))
assert.equal(slots.length, 30, '30天日期要完整保留')
assert.equal(slots[1].amount, '0', '已记录的零仍显示为零')
assert.equal(slots[2].amount, null, '无平仓记录的日期留空，不能补零')
assert.equal(slots.at(-1).label, '2026-10-30')
assert.deepEqual(returnDaySlots([], at('2026-10-01T00:00:00'), at('2026-10-01T00:00:00')), [{ label: '2026-10-01', amount: null, cumulative: null }])
const periods = comparisonPeriods({ period: '30天' }, null, at('2026-10-24T00:05:00'))
const preview = createReturnsPreview(periods)
const previewRounds = buildContractHistory(preview.state).rounds.filter(round => round.closedAt >= periods.current.start && round.closedAt <= periods.current.end)
const previewDays = closedReturnCalendarDays(previewRounds)
assert.equal(previewRounds.length, 30)
assert.equal(previewDays.length, 30, '即使今天刚过零点，也要在所选范围内展示30个不同日期')
assert.equal(previewDays.every(day => day.amount !== null && day.count === 1 && day.pending === 0), true)
assert.equal(closedReturnStats(previewRounds).net, '380.6', '增加预览笔数不改变原示例的净收益总额')
assert.equal(preview.overview.net, '2252.2')
console.log('合约盈亏日历检查通过：北京日期、整轮净收益、零值、待核对及币种边界。')

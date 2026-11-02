import assert from 'node:assert/strict'
import { createReturnsPreview } from '../src/data/returns-preview.ts'
import { buildContractHistory } from '../src/data/contract-history.ts'
import { buildReturnEntries, closedReturnStats, rankShares, returnDays } from '../src/data/returns-analysis.ts'
import { comparisonPeriods } from '../src/data/returns-comparison.ts'
import { returnCurveDays } from '../src/data/returns-curve.ts'

// 只检查内存中的示例，不读取账户、不发请求、不写文件。
const now = Date.parse('2026-10-23T12:00:00+08:00')
for (const [range, calendar] of [
  [{ period: '自定义', start: '2026-10-01', end: '2026-10-23' }, 'month'],
  [{ period: '7天' }, null], [{ period: '30天' }, null],
  [{ period: '自定义', start: '2026-01-01', end: '2026-10-23' }, 'year'],
  [{ period: '全部时间' }, null],
]) {
  const periods = comparisonPeriods(range, calendar, now)
  const { state, overview, previous } = createReturnsPreview(periods)
  assert.equal(overview.net, '2252.2')
  assert.equal(overview.comparable, overview.net)
  assert.deepEqual(overview.reasons, [])
  assert.equal(overview.valued.missing.length, 0)
  assert.ok(overview.spot.every(row => row.amount !== null && row.components))
  assert.equal(previous !== null, periods.previous !== null)
  if (previous) assert.notEqual(previous.rate, overview.rate)
  for (const category of ['合约交易盈亏', '交易手续费', '资金费', '奖励收入']) {
    assert.ok(returnDays(overview.valued.entries.filter(entry => entry.category === category)).length > 0)
  }
  const history = buildContractHistory(state)
  assert.deepEqual(history.warnings, [])
  const rounds = history.rounds.filter(round => round.closedAt >= periods.current.start && round.closedAt <= periods.current.end)
  const stats = closedReturnStats(rounds)
  const expectedRounds = returnCurveDays(periods.current.start || periods.current.end - 30 * 86400000, periods.current.end) === 30 ? 30 : 6
  assert.equal(stats.confirmed.length, expectedRounds)
  assert.equal(stats.net, '380.6')
  assert.ok(stats.wins > 0 && stats.losses > 0)
  assert.equal(buildReturnEntries(state.records).some(entry => entry.id.startsWith('preview:')), true)
}
console.log('模拟数据检查通过：各分类完整、两期可比、合约可核对，未接触真实数据。')

const gainsOnly = rankShares(['66.45', '21.62'])
assert(!gainsOnly.diverging && Math.abs(gainsOnly.bars[0].percent + gainsOnly.bars[1].percent - 100) < 1e-9, '只有盈利时合计 100%')
const lossesOnly = rankShares(['-30', '-10'])
assert(!lossesOnly.diverging && lossesOnly.bars[0].percent === 75 && lossesOnly.bars[0].width === 75, '只有亏损时各占亏损合计')
const mixed = rankShares(['-50', '21.62', '-50', '0', null])
assert(mixed.diverging && mixed.bars[0].percent === 50 && mixed.bars[0].width === 25 && mixed.bars[1].percent === 100 && mixed.bars[1].width === 50, '盈亏并存时各算各的，每侧最长占半宽')
assert(mixed.bars[3].percent === 0 && mixed.bars[4].percent === 0, '零和缺失不占比')
assert.deepEqual(rankShares(['0', '0']).bars.map(bar => bar.percent), [0, 0], '全为零不除以零')

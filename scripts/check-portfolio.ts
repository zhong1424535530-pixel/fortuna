// 仅经用户单独同意后运行；不访问网络、系统钥匙串或本人资料。
import assert from 'node:assert/strict'
import { refreshPortfolio, accounts, holdings, contracts, totalValueCents, historyFor, sourceHistoryFor, formatPrice, formatQuantity, assertWorkspacePortfolio, personalBalance, positionCostBasis, assetAccountGroups, filterHoldings, filterContracts, holdingQuantity, holdingValueCents, holdingCostSummary } from '../src/data/portfolio.ts'
import type { Account, ContractPosition, Holding } from '../src/data/portfolio.ts'
import type { Connection } from '../src/data/live-types.ts'
import { removeRetiredDemoData } from '../src/data/workspace-schema.ts'
import { emptyWorkspace, setWorkspaceData, workspace } from '../src/data/workspace.ts'
import { setCnQuotes } from '../src/data/cn-quotes.ts'
import type { WorkspaceData } from '../src/data/workspace-schema.ts'
import { calendarToday, returnRangeDates, returnRangeLabel, validateReturnDates, calendarMonthGrid, shiftCalendarMonth, selectRangeDate } from '../src/data/return-range.ts'
import { heldTodayPnl, todayPriceChange } from '../src/data/daily-pnl.ts'
import { visibleHoldings } from '../src/data/holding-visibility.ts'
import { mergeHoldingRows, overviewHoldings, overviewSources } from '../src/data/overview.ts'
import { initializeLiveData, liveState, marketError, refreshMarketData, startLiveUpdates } from '../src/data/live.ts'
import { appendEquityPoint, projectEquity, validEquityPoint } from '../src/data/equity-history.ts'
import type { EquityPoint } from '../src/data/equity-history.ts'
import { listEquityHistory, saveEquityPoint } from '../server/equity-history.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
assert.equal(calendarToday(new Date('2026-10-20T16:01:00Z')), '2026-10-21')
// 仅准备，用户另行同意模拟后执行；交易日期复用总览日历，按北京时间包含首尾日期。
const transactionDateNow = new Date('2026-10-22T16:01:00Z')
assert.deepEqual(returnRangeDates({ period: '7天' }, transactionDateNow), { start: '2026-10-17', end: '2026-10-23' })
assert.deepEqual(returnRangeDates({ period: '1天' }, transactionDateNow), { start: '2026-10-23', end: '2026-10-23' })
assert.deepEqual(returnRangeDates({ period: '30天' }, transactionDateNow), { start: '2026-09-24', end: '2026-10-23' })
assert.deepEqual(returnRangeDates({ period: '全部时间' }, transactionDateNow), { start: '', end: '' }, '全部时间必须清掉起止日期')
assert.deepEqual(returnRangeDates({ period: '自定义', start: '2026-10-15', end: '2026-10-23' }, transactionDateNow), { start: '2026-10-15', end: '2026-10-23' })
assert.equal(returnRangeLabel({ period: '30天' }), '近30天')
assert.equal(returnRangeLabel({ period: '全部时间' }), '全部')
assert.equal(returnRangeLabel({ period: '自定义', start: '2023-01-01', end: '2026-10-20' }), '2023-01-01 至 2026-10-20')
assert.equal(validateReturnDates('2023-01-01', '2026-10-20', '2026-10-20'), '')
assert.equal(validateReturnDates('2026-10-20', '2026-10-20', '2026-10-20'), '')
assert.notEqual(validateReturnDates('', '2026-10-20', '2026-10-20'), '')
assert.notEqual(validateReturnDates('2026-10-20', '2026-10-19', '2026-10-20'), '')
assert.notEqual(validateReturnDates('2026-10-20', '2026-10-21', '2026-10-20'), '')
assert.notEqual(validateReturnDates('2025-02-29', '2026-10-20', '2026-10-20'), '')
assert.equal(validateReturnDates('2024-02-29', '2026-10-20', '2026-10-20'), '')
const february = calendarMonthGrid('2024-02')
assert.equal(february.length % 7, 0)
assert.equal(february[0], '2024-01-29')
assert.ok(february.includes('2024-02-29'))
assert.equal(shiftCalendarMonth('2026-01', -1), '2025-12')
assert.equal(shiftCalendarMonth('2026-12', 1), '2027-01')
assert.deepEqual(selectRangeDate('', '', '2026-10-12'), { start: '2026-10-12', end: '' })
assert.deepEqual(selectRangeDate('2026-10-12', '', '2026-10-10'), { start: '2026-10-10', end: '2026-10-12' })
assert.deepEqual(selectRangeDate('2026-10-12', '', '2026-10-12'), { start: '2026-10-12', end: '2026-10-12' })
assert.deepEqual(selectRangeDate('2026-10-10', '2026-10-12', '2026-10-15'), { start: '2026-10-15', end: '' })
assert.equal(accounts.length, 0)
assert.equal(holdings.length, 0)
assert.equal(contracts.length, 0)
assert.equal(totalValueCents, 0)
assert.deepEqual(historyFor('30天'), [])
assert.deepEqual(sourceHistoryFor('binance', '30天'), [])
assert.equal(formatPrice(.00001, 'USD'), '$0.00001')
assert.equal(formatQuantity(.00000001), '0.00000001')
const stamp = '2026-10-19T00:00:00Z'
const cost = { averagePrice: 1, currency: 'USD' as const, quantity: 2, feeIncluded: false, updatedAt: stamp }
const data: WorkspaceData = { manualAssets: [{ id: 'manual-example', symbol: 'EX', name: '隔离断言', market: 'crypto', accountId: 'manual', quantity: 2, price: 10, currency: 'USD', icon: '', updatedAt: stamp }], customizations: {}, snapshots: [], changes: [], costs: { 'manual-example': { manual: cost }, bitcoin: { binance: cost } } }
const cleaned = removeRetiredDemoData(data)
assert.deepEqual(cleaned.costs, { 'manual-example': { manual: cost } })
assert.deepEqual(cleaned.manualAssets, data.manualAssets)
assertWorkspacePortfolio(cleaned)
// 删除手动资产：成本一并清掉才能通过校验，只删资产会被拒绝。
assert.throws(() => assertWorkspacePortfolio({ ...cleaned, manualAssets: [] }))
assertWorkspacePortfolio({ ...cleaned, manualAssets: [], costs: {} })
assert.equal(positionCostBasis({ id: 'manual-example' } as Parameters<typeof positionCostBasis>[0], { accountId: 'manual', quantity: 2 }, cleaned), cost)
const liabilities = [{ id: 'liability-check', name: '隔离房贷', kind: '房贷' as const, amount: 712000, currency: 'CNY' as const, settled: false, note: '', updatedAt: stamp }]
assertWorkspacePortfolio({ ...cleaned, liabilities })
assert.equal(personalBalance({ ...cleaned, liabilities }, 2000, 0, 8).netCents, -8898000)
// 仅在内存中构造分组资料，不读取或修改本人账户。
const connection = (id: string, type: 'binance' | 'wallet', name: string, address?: string): Connection => ({ id, type, name, address, hasCredential: false, status: 'ok', updatedAt: null, warning: '' })
const groupedConnections = [connection('main', 'binance', '币安主账户'), connection('other', 'binance', '币安主账户'), connection('wallet', 'wallet', '我的钱包', '0xabcdef'), connection('repeat', 'wallet', '重复接入', '0xABCDEF'), connection('different', 'wallet', '我的钱包', '0x123456')]
const account = (id: string, source: string, kind = '交易所'): Account => ({ id, sourceId: 'live-' + source, name: id, kind, icon: '', color: '' })
const groupedAccounts = [account('spot', 'main'), account('usdm', 'main'), account('other-spot', 'other'), account('eth', 'wallet', '钱包'), account('bsc', 'wallet', '钱包'), account('arb', 'repeat', '钱包'), account('different-eth', 'different', '钱包'), account('manual', 'manual', '手动账户')]
const groups = assetAccountGroups(groupedAccounts, groupedConnections)
assert.equal(groups.length, 5)
assert.deepEqual(groups.find(group => group.id === 'live-main')?.accountIds, ['spot', 'usdm'])
const walletGroup = groups.find(group => group.name === '我的钱包')!
assert.deepEqual(walletGroup.accountIds, ['eth', 'bsc', 'arb'])
assert.equal(groups.filter(group => group.name === '币安主账户').length, 2)
assert.equal(groups.filter(group => group.name === '我的钱包').length, 2)
assert.equal(assetAccountGroups([account('unknown-a', 'a', '钱包'), account('unknown-b', 'b', '钱包')], []).length, 2)
const groupedHolding: Holding = { id: 'group-check', symbol: 'EX', name: '分组筛选', category: '加密资产', market: 'crypto', usdPrice: 10, change24h: null, icon: '', color: '', source: '', description: '', positions: [{ accountId: 'spot', quantity: 1, valueCents: 1000 }, { accountId: 'usdm', quantity: 2, valueCents: 2000 }, { accountId: 'eth', quantity: 3, valueCents: 3000 }] }
// 总览断言只使用隔离资料，修改阶段不运行。
const overviewAsset = (id: string, symbol: string, price: number | null, quantity: number): Holding => ({ ...groupedHolding, id, symbol, usdPrice: price, positions: [{ accountId: 'spot', quantity }] })
const overviewMerged = overviewHoldings([
  overviewAsset('binance:BTC', 'BTC', 10, 2), overviewAsset('bitcoin:native', 'BTC', 12, 1),
  overviewAsset('evm:1:0x0000000000000000000000000000000000000001', 'BTC', 5, 1),
  overviewAsset('manual-btc', 'BTC', 6, 1),
  overviewAsset('evm:1:native', 'ETH', 1, 2), overviewAsset('evm:8453:native', 'ETH', 1, 1),
])
assert.equal(overviewMerged.length, 4)
assert.equal(overviewMerged[0].id, 'coin:bitcoin')
assert.equal(overviewMerged[0].valueCents, 3200)
assert.equal(overviewMerged[0].assets.length, 2)
assert.equal(overviewMerged.find(group => group.id === 'coin:ethereum')?.valueCents, 300)
assert.equal(overviewMerged.reduce((sum, group) => sum + group.valueCents, 0), 4600)
assert.equal(overviewHoldings([overviewAsset('binance:BTC', 'BTC', .6, 1), overviewAsset('bitcoin:native', 'BTC', .6, 1)]).length, 1)
assert.equal(overviewHoldings([overviewAsset('binance:BTC', 'BTC', .499, 1), overviewAsset('bitcoin:native', 'BTC', .5, 1)]).length, 0)
assert.equal(overviewHoldings([overviewAsset('binance:BTC', 'BTC', 1, 1)]).length, 1)
const overviewUnknown = overviewHoldings([overviewAsset('binance:BTC', 'BTC', 10, 1), overviewAsset('bitcoin:native', 'BTC', null, 1)])[0]
assert.equal(overviewUnknown.missingPrices, 1)
assert.equal(overviewUnknown.valueCents, 1000)
const overviewBalances = groupedAccounts.map((entry, index) => ({ ...entry, updatedAt: stamp, assetsCents: (index + 1) * 100, pnlCents: -50, pnlIncomplete: false, valueCents: (index + 1) * 100 - 50 }))
const overviewFunds = overviewSources(groups, overviewBalances)
assert.equal(overviewFunds.find(source => source.id === 'live-main')?.valueCents, 300)
assert.equal(overviewFunds.find(source => source.id === 'wallet:0xabcdef')?.valueCents, 1500)
assert.equal(overviewFunds.reduce((sum, source) => sum + source.valueCents, 0), overviewBalances.reduce((sum, entry) => sum + entry.assetsCents, 0))
assert.equal(overviewSources([groups[0]], []).at(0)?.unread, true)
// 仅准备小额隐藏断言；不得在未获用户同意时运行模拟测试。
const dust = (id: string, price: number | null, quantity = 1): Holding => ({ ...groupedHolding, id, usdPrice: price, positions: [{ accountId: 'spot', quantity }] })
const dustRows = [dust('below', .99), dust('equal', 1), dust('above', 1.01), dust('rounding', .9999), dust('cheap', .01, 200), dust('unknown', null), dust('zero', 0)]
const dustBefore = JSON.stringify(dustRows), dustTotal = dustRows.reduce((sum, asset) => sum + holdingValueCents(asset), 0)
assert.deepEqual(visibleHoldings(dustRows).map(asset => asset.id), ['equal', 'above', 'cheap', 'unknown'])
assert.equal(JSON.stringify(dustRows), dustBefore, '隐藏不能修改或删除原余额')
assert.equal(dustRows.reduce((sum, asset) => sum + holdingValueCents(asset), 0), dustTotal, '总资产仍计入零钱')
assert.equal(visibleHoldings([dust('combined', .6), { ...dust('combined', .6), positions: [{ accountId: 'usdm', quantity: 1 }] }]).length, 2, '同一资产跨账户先合计')
assert.equal(visibleHoldings([{ ...dust('combined', .6), positions: [{ accountId: 'spot', quantity: 1 }, { accountId: 'usdm', quantity: 1 }] }]).length, 1)
assert.equal(visibleHoldings([{ ...dust('precision', 1), positions: [{ accountId: 'spot', quantity: 1, quantityText: '0.99999999999999999999', valueCents: 100 }] }]).length, 0, '按未舍入数量判断')
assert.equal(visibleHoldings([dust('unknown-part', .2), dust('unknown-part', null)]).length, 2, '部分缺价不当小额')
assert.equal(visibleHoldings([{ ...dust('invalid', 1), positions: [{ accountId: 'spot', quantity: 1, quantityText: '错误' }] }]).length, 1)
const pnlAccounts = groupedHolding.positions.map(position => ({ id: position.accountId, status: 'ok' as const, updatedAt: '2026-10-20T04:00:00Z' }))
const dayHolding = { ...groupedHolding, dayOpen: { date: '2026-10-20', usdPrice: 8, at: Date.parse('2026-10-20T00:00:00+08:00') / 1000 } }
assert.equal(heldTodayPnl([dayHolding], pnlAccounts, '2026-10-20').pnlCents, 1200)
assert.equal(heldTodayPnl([{ ...dayHolding, positions: [{ accountId: 'spot', quantity: 2 }] }], pnlAccounts, '2026-10-20').pnlCents, 400)
assert.equal(heldTodayPnl([{ ...dayHolding, positions: [] }], pnlAccounts, '2026-10-20').pnlCents, 0)
assert.equal(heldTodayPnl([{ ...dayHolding, usdPrice: 7 }], pnlAccounts, '2026-10-20').pnlCents, -600)
assert.equal(heldTodayPnl([groupedHolding], pnlAccounts, '2026-10-20').pnlCents, 0)
assert.equal(heldTodayPnl([dayHolding], pnlAccounts, '2026-10-21').pnlCents, 0)
assert.equal(heldTodayPnl([dayHolding], pnlAccounts.map(account => ({ ...account, status: 'error' as const })), '2026-10-20').pnlCents, 0)
assert.equal(heldTodayPnl([{ ...dayHolding, usdPrice: null }], pnlAccounts, '2026-10-20').pnlCents, 0)
// 今日涨跌与今日盈亏用同一份日初价；仅准备，用户同意后再运行。
assert.equal(todayPriceChange({ ...dayHolding, change24h: -50 }, pnlAccounts, '2026-10-20'), 25)
assert.equal(todayPriceChange({ ...dayHolding, usdPrice: 7 }, pnlAccounts, '2026-10-20'), -12.5)
assert.equal(todayPriceChange({ ...dayHolding, usdPrice: 8 }, pnlAccounts, '2026-10-20'), 0)
assert.equal(todayPriceChange(groupedHolding, pnlAccounts, '2026-10-20'), null)
assert.equal(todayPriceChange(dayHolding, pnlAccounts, '2026-10-21'), null)
assert.equal(todayPriceChange(dayHolding, pnlAccounts.map(account => ({ ...account, status: 'error' as const })), '2026-10-20'), null)
assert.equal(todayPriceChange({ ...dayHolding, usdPrice: null }, pnlAccounts, '2026-10-20'), null)
assert.equal(todayPriceChange({ ...dayHolding, manualPrice: true }, pnlAccounts, '2026-10-20'), null)
const freshQuote = { ...dayHolding, priceUpdatedAt: '2026-10-20T04:00:00Z' }
const oldBalanceAccounts = pnlAccounts.map(account => ({ ...account, updatedAt: '2026-10-19T04:00:00Z' }))
assert.equal(todayPriceChange(freshQuote, oldBalanceAccounts, '2026-10-20'), 25, '独立行情可更新，不能冒充余额已刷新')
assert.equal(heldTodayPnl([freshQuote], oldBalanceAccounts, '2026-10-20').pnlCents, 1200)
// 合并展示只汇总原始持仓，原始成本与日初价各自保留；用户同意后再运行。
const usdcExchange: Holding = { ...dayHolding, id: 'binance:USDC', symbol: 'USDC', usdPrice: 1.01, dayOpen: { ...dayHolding.dayOpen, usdPrice: 1 }, positions: [{ accountId: 'spot', quantity: 2, quantityText: '2' }] }
const usdcBase: Holding = { ...dayHolding, id: 'evm:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', usdPrice: .99, dayOpen: { ...dayHolding.dayOpen, usdPrice: 1.02 }, positions: [{ accountId: 'eth', quantity: 3, quantityText: '3' }] }
const rawUsdc = JSON.stringify([usdcExchange, usdcBase])
const mergedUsdc = mergeHoldingRows([usdcExchange, usdcBase])
assert.equal(mergedUsdc.length, 1)
assert.equal(mergedUsdc[0].members?.length, 2)
assert.equal(holdingQuantity(mergedUsdc[0]), 5)
assert.equal(holdingValueCents(mergedUsdc[0]), 499)
assert.equal(mergedUsdc[0].usdPrice, .998)
assert.equal(JSON.stringify([usdcExchange, usdcBase]), rawUsdc)
assert.equal(heldTodayPnl(mergedUsdc, pnlAccounts, '2026-10-20').pnlCents, -7)
assert.ok(Math.abs(todayPriceChange(mergedUsdc[0], pnlAccounts, '2026-10-20')! - (-.07 / 5.06 * 100)) < 1e-10)
const mergedCosts: WorkspaceData = { ...cleaned, costs: {
  [usdcExchange.id]: { spot: { ...cost, averagePrice: .8, quantity: 2, feeIncluded: true } },
  [usdcBase.id]: { eth: { ...cost, averagePrice: .9, quantity: 3 } },
} }
const mergedCostSummary = holdingCostSummary(mergedUsdc[0], mergedCosts)
assert.equal(mergedCostSummary.costCents, 430)
assert.equal(mergedCostSummary.averageUsdPrice, .86)
assert.equal(mergedCostSummary.pnlCents, 69)
assert.equal(mergedCostSummary.feeIncluded, false)
assert.equal(holdingCostSummary(mergedUsdc[0], { ...mergedCosts, costs: { [usdcExchange.id]: mergedCosts.costs![usdcExchange.id] } }).costCents, null)
assert.equal(mergeHoldingRows([usdcExchange])[0].id, usdcExchange.id)
assert.equal(mergeHoldingRows([{ ...usdcBase, usdPrice: null }, usdcExchange])[0].usdPrice, null)
const groupedContract: ContractPosition = { id: 'group-contract', symbol: 'EXUSDT', name: '分组筛选', icon: '', accountId: 'usdm', direction: '做多', quantity: 1, baseAsset: 'EX', entryPriceUsd: 8, markPriceUsd: 10, leverage: 2, marginMode: '全仓', marginCents: 500, liquidationPriceUsd: null, unrealizedPnlCents: 200 }
holdings.push(groupedHolding)
contracts.push(groupedContract)
try {
  const selection = groups.find(group => group.id === 'live-main')!.accountIds
  const selected = filterHoldings('', '全部', selection)[0]
  assert.equal(holdingQuantity(selected), 3)
  assert.equal(holdingValueCents(selected), 3000)
  assert.equal(holdingQuantity(filterHoldings('', '全部', walletGroup.accountIds)[0]), 3)
  assert.equal(filterContracts('', selection).length, 1)
  assert.equal(filterContracts('', selection, '做空').length, 0)
  assert.equal(filterContracts('', walletGroup.accountIds).length, 0)
  assert.equal(filterHoldings('', '全部', []).length, 0)
  assert.equal(filterContracts('', []).length, 0)
  assert.equal(holdingQuantity(filterHoldings('', '全部', 'spot')[0]), 1)
  assert.equal(holdingQuantity(filterHoldings('', '全部')[0]), 6)
  assert.equal(filterHoldings('', '股票', selection).length, 0)
  assert.equal(filterHoldings('不存在', '全部', selection).length, 0)
  const selectedCosts: WorkspaceData = { ...data, costs: { 'group-check': { spot: { ...cost, quantity: 1, averagePrice: 4 }, usdm: { ...cost, quantity: 2, averagePrice: 7 } } } }
  assert.equal(holdingCostSummary(selected, selectedCosts).averageUsdPrice, 6)
  assert.equal(holdingCostSummary(selected, selectedCosts).pnlCents, 1200)
  assert.equal(groupedHolding.positions.length, 3)
} finally {
  holdings.pop()
  contracts.pop()
}
const sample = (t: number, net: number): EquityPoint => ({ t, net, gross: net, rows: [['asset', 'account', net, 'crypto', '加密资产']], prices: [['asset', 2]], contracts: [['contract', 'account', 3, net > 1000 ? 100 : -100]], accounts: [['account', net]] })
const opened = sample(1_700_000_000, 1000)
const later = sample(opened.t + 10 * 86400, 1800)
const carried = projectEquity([opened, later], { mode: 'net', start: opened.t + 5 * 86400, end: later.t + 86400 }, null)
assert.equal(carried[0].valueCents, 1000, '区间左侧沿用已有快照，不回填成最新价')
assert.equal(carried.at(-1)?.valueCents, 1800)
const fresh = projectEquity([], { mode: 'net', start: opened.t, end: opened.t + 86400 }, sample(opened.t + 86400, 500))
assert.ok(fresh.length >= 2 && fresh.every(point => point.valueCents === 500), '只有当前估值时画平线')
assert.equal(appendEquityPoint([opened], { ...later, t: opened.t + 20 }, opened.t + 20).length, 1)
assert.equal(validEquityPoint({ ...opened, net: 1.5 }), false)
const equityFolder = mkdtempSync(join(tmpdir(), 'equity-history-'))
try {
  assert.equal((await saveEquityPoint(equityFolder, opened)).length, 1)
  assert.equal(listEquityHistory(equityFolder)[0].net, 1000)
  await saveEquityPoint(equityFolder, { ...opened, net: 1.5 })
  assert.equal(listEquityHistory(equityFolder)[0].net, 1000, '无效快照不覆盖曲线')
} finally { rmSync(equityFolder, { recursive: true, force: true }) }
// 合约页曲线与当前筛选合约一致；仅准备，待用户批准模拟测试后运行。
const contractCurvePoint: EquityPoint = { ...opened, contracts: [['long-btc', 'spot', 100, 250], ['short-eth', 'usdm', 50, -80], ['other-account', 'eth', 30, 40]] }
const contractCurveQuery = { mode: 'pnl' as const, start: opened.t, end: opened.t + 60 }
assert.equal(projectEquity([contractCurvePoint], { ...contractCurveQuery, contractIds: ['long-btc', 'short-eth'] }, null).at(-1)?.valueCents, 170)
assert.equal(projectEquity([contractCurvePoint], { ...contractCurveQuery, contractIds: ['long-btc', 'short-eth'], accountIds: ['usdm'] }, null).at(-1)?.valueCents, -80)
assert.equal(projectEquity([contractCurvePoint], { ...contractCurveQuery, contractIds: [] }, null).at(-1)?.valueCents, 0)
assert.equal(projectEquity([contractCurvePoint], { ...contractCurveQuery, contractIds: ['long-btc'], contractDirection: '做多' }, null).length, 0, '旧快照没有方向，不能按今天方向猜过去')
const contractDirectionPoint: EquityPoint = { ...contractCurvePoint, contractDirections: [['long-btc', '做多'], ['short-eth', '做空'], ['other-account', '做多']] }
assert.equal(projectEquity([contractDirectionPoint], { ...contractCurveQuery, contractDirection: '做空' }, null).at(-1)?.valueCents, -80)
assert.equal(projectEquity([{ ...contractDirectionPoint, contractDirections: [['long-btc', '做空'], ['short-eth', '做空'], ['other-account', '做多']] }], { ...contractCurveQuery, contractIds: ['long-btc'], contractDirection: '做多' }, null).at(-1)?.valueCents, 0, '同编号单向仓反手后，历史方向仍以当时记录为准')
assert.equal(validEquityPoint({ ...contractDirectionPoint, contractDirections: [['long-btc', '错误']] }), false)
assert.equal(projectEquity([{ ...contractCurvePoint, contracts: [['long-btc', 'spot', 100, null], ['short-eth', 'usdm', 50, -80]] }], { ...contractCurveQuery, contractIds: ['long-btc', 'short-eth'] }, null).length, 0, '缺少一笔浮盈不能画成完整合计')
assert.equal(projectEquity([{ ...contractCurvePoint, contracts: [['long-btc', 'spot', 100, null], ['short-eth', 'usdm', 50, -80]] }], { ...contractCurveQuery, contractIds: ['short-eth'] }, null).at(-1)?.valueCents, -80, '未选合约缺值不影响所选曲线')
// 计时器和网络均用本机假对象；仅在用户另行同意后运行。
const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalDocument = globalThis.document
let intervalWork: (() => void) | undefined, intervalMs = 0, cleared = false, marketCalls = 0, failMarket = false
let releaseFirst: (() => void) | undefined
const marketEvents: string[] = []
const fakeLive = { connections: [], snapshot: { accounts: [], holdings: [groupedHolding], contracts: [] } }
try {
  globalThis.window = {
    setInterval: (callback: () => void, ms: number) => { if (ms === 60000) { intervalWork = callback; intervalMs = ms }; return ms },
    clearInterval: () => { cleared = true },
    dispatchEvent: (event: CustomEvent<string>) => { marketEvents.push(event.detail); return true },
  } as unknown as Window & typeof globalThis
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document
  globalThis.fetch = async path => {
    if (String(path) === '/api/connections') return new Response(JSON.stringify(fakeLive))
    assert.equal(String(path), '/api/market/refresh')
    marketCalls++
    if (marketCalls === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
    if (failMarket) throw new Error('假行情断网')
    return new Response(JSON.stringify({ ...fakeLive, snapshot: { ...fakeLive.snapshot, holdings: [{ ...groupedHolding, usdPrice: 12 }] } }))
  }
  await initializeLiveData()
  const stop = startLiveUpdates()
  assert.equal(intervalMs, 60000)
  assert.equal(marketCalls, 1, '启动后先更新一次')
  intervalWork!()
  assert.equal(marketCalls, 1, '上次未完成时不叠加请求')
  releaseFirst!()
  await refreshMarketData()
  assert.equal(liveState.snapshot.holdings[0].usdPrice, 12)
  assert.deepEqual(marketEvents, ['market'])
  intervalWork!()
  await refreshMarketData()
  assert.equal(marketCalls, 2)
  failMarket = true
  intervalWork!()
  await refreshMarketData()
  assert.equal(liveState.snapshot.holdings[0].usdPrice, 12, '失败保留旧价格')
  assert.ok(marketError)
  assert.equal(marketEvents.at(-1), 'market-status')
  stop()
  assert.equal(cleared, true)
} finally {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else globalThis.window = originalWindow
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
  else globalThis.document = originalDocument
}
// 手动美股取自动行情（取不到时用填写价）；手动加密资产没填价格时跟随已接入账户的同代码币种
{
  const priorWorkspace = workspace
  const connected = holdings.find(asset => !asset.manual && asset.market === 'crypto' && asset.usdPrice !== null)
  const manual = (id: string, symbol: string, market: 'us' | 'crypto', price: number | null) => ({ id, symbol, name: symbol, market, accountId: 'manual', quantity: 100, price, currency: 'USD' as const, icon: '', updatedAt: stamp })
  setWorkspaceData({ ...emptyWorkspace(), manualAssets: [manual('manual-tsla', 'tsla', 'us', null), manual('manual-aapl', 'AAPL', 'us', 300), ...(connected ? [manual('manual-follow', connected.symbol.toLowerCase(), 'crypto', null)] : [])] })
  setCnQuotes({ 'us:TSLA': { name: '特斯拉', price: 404.22, prevClose: 407.46, at: Date.parse('2026-10-28T20:00:01Z') } })
  refreshPortfolio()
  const tsla = holdings.find(asset => asset.id === 'manual-tsla')!
  assert.equal(tsla.usdPrice, 404.22)
  assert.equal(tsla.priceUpdatedAt, '2026-10-28T20:00:01.000Z')
  assert.equal(tsla.name, 'tsla', '美股沿用自己填写的名称')
  assert.equal(holdings.find(asset => asset.id === 'manual-aapl')!.usdPrice, 300, '没有行情时用填写价')
  if (connected) assert.equal(holdings.find(asset => asset.id === 'manual-follow')!.usdPrice, connected.usdPrice)
  // A股和美股一样：默认自动行情，手动改价后以手动价为准
  const cn = { ...manual('manual-cn', '001309', 'us', null), market: 'cn' as const, currency: 'CNY' as const }
  setWorkspaceData({ ...emptyWorkspace(), manualAssets: [cn], customizations: { 'manual-cn': { mode: 'manual', price: 100, currency: 'USD', updatedAt: '2026-10-30T00:00:00.000Z' } } })
  setCnQuotes({ '001309': { name: '德明利', price: 215.4, prevClose: 230.56, at: Date.parse('2026-10-29T07:34:00Z') } })
  refreshPortfolio()
  assert.equal(holdings.find(asset => asset.id === 'manual-cn')!.usdPrice, 100)
  assert.equal(holdings.find(asset => asset.id === 'manual-cn')!.manualPrice, true)
  setWorkspaceData({ ...emptyWorkspace(), manualAssets: [cn], customizations: { 'manual-cn': { mode: 'manual', price: 36.32, currency: 'USD', updatedAt: '2026-10-26T15:52:25.000Z' } } }); refreshPortfolio()
  assert.ok(!holdings.find(asset => asset.id === 'manual-cn')!.manualPrice, '放开前遗留的旧手动价不生效')
  setWorkspaceData({ ...emptyWorkspace(), manualAssets: [cn] }); refreshPortfolio()
  assert.ok(!holdings.find(asset => asset.id === 'manual-cn')!.manualPrice && holdings.find(asset => asset.id === 'manual-cn')!.priceUpdatedAt === '2026-10-29T07:34:00.000Z')
  setWorkspaceData(priorWorkspace); setCnQuotes({}); refreshPortfolio()
}

console.log('资产计算、筛选、日期及全局60秒行情隔离断言通过。')

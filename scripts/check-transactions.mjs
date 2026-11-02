// 仅在用户单独同意模拟测试后运行；临时目录、假请求与假密钥，不访问真实账户和系统钥匙串。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { validTransactionState, filterTransactions } from '../src/data/transactions.ts'
import { createTransactionStore, mergeTransactions } from '../server/transaction-store.mjs'
import { readTradeWindow, readRebateWindow, readBinanceTransactions, fundingHistoryWindows } from '../server/binance-transactions.mjs'
import { parseResponseJson } from '../server/connection-http.mjs'
import { createBinanceClient } from '../server/binance-reader.mjs'
import { createConnectionService } from '../server/connection-service.mjs'
import { valueRewards } from '../server/reward-valuation.mjs'

const connection = { id: '12345678-1234-1234-1234-123456789abc', name: '隔离账户', type: 'binance' }
const now = Date.parse('2026-10-21T04:00:00Z')
const exactIds = parseResponseJson('{"tranId":9223372036854775807,"tradeId":9223372036854775806,"time":1792555200000,"income":"-0.00000001"}')
assert.equal(exactIds.tranId, '9223372036854775807', '不能从已经舍入的数字补造流水编号')
assert.equal(exactIds.tradeId, '9223372036854775806')
assert.equal(typeof exactIds.time, 'number')
assert.equal(exactIds.income, '-0.00000001')
assert.equal(parseResponseJson('{"tranId":7}').tranId, 7)
const historyPlan = fundingHistoryWindows(now)
assert.equal(new Date(historyPlan.start).toISOString(), '2026-07-21T04:00:00.000Z')
assert(historyPlan.windows.every(window => window.end - window.start < 7 * 86400000))
assert.equal(historyPlan.windows[0].end, now - 7 * 86400000 - 1)
assert.equal(historyPlan.windows.at(-1).start, historyPlan.start)
assert.equal(fundingHistoryWindows(now, { status: 'ok', from: historyPlan.start, to: now }).windows.length, 0, '已读全的历史不反复扫描')
const gapPlan = fundingHistoryWindows(now, { status: 'ok', from: historyPlan.start, to: now - 14 * 86400000 })
assert(gapPlan.windows.every(window => window.start > now - 14 * 86400000), '只补上次完整范围之后的空缺')
assert.equal(new Date(fundingHistoryWindows(Date.parse('2026-05-31T04:00:00Z')).start).toISOString(), '2026-02-28T04:00:00.000Z')
const record = { id: 'binance:test:spot:BTCUSDT:1', connectionId: connection.id, connectionName: connection.name, identity: 'test', account: '现货', scope: 'spot', type: '买入', time: now - 1000, asset: 'BTC', quantity: '0.000000000000000001', symbol: 'BTCUSDT', quoteAsset: 'USDT', quoteQuantity: '0.00000000000006', price: '60000', fees: [{ asset: 'BNB', quantity: '0.000001' }], realizedPnl: null, pnlAsset: '', status: '已完成', orderId: '5', txHash: '', network: '', address: '', note: '', relatedTradeId: '' }
assert(validTransactionState({ records: [record], syncs: [] }))
const rawReward = { ...record, id: 'binance:test:spot-rebate:arb', type: '奖励', scope: 'spot-rebate', note: 'SPOT_COMMISSION_REBATE', asset: 'ARB', quantity: '10', price: null, quoteQuantity: null, fees: [], status: '已记录' }
const valuationCalls = []
const fakeHistoryPrice = async (url, options) => {
  const query = new URL(url)
  assert.equal(query.pathname, '/api/v3/klines')
  assert(!options?.headers, '公开价格不得携带账户凭证')
  assert.equal(query.searchParams.get('interval'), '1m')
  assert.equal(query.searchParams.get('limit'), '1')
  const minute = Math.floor(rawReward.time / 60000) * 60000
  assert.equal(Number(query.searchParams.get('startTime')), minute)
  assert.equal(Number(query.searchParams.get('endTime')), minute + 59999)
  valuationCalls.push(query)
  return [[minute, '0.3', '0.31', '0.29', '0.305', '100', minute + 59999, '30', 10, '0', '0', '0']]
}
const valued = await valueRewards([rawReward, { ...rawReward, id: rawReward.id + ':2', quantity: '2' }], [], fakeHistoryPrice)
assert.equal(valued.records[0].rewardValuation.usdtQuantity, '3')
assert.equal(valued.records[1].rewardValuation.usdtQuantity, '0.6')
assert.equal(valuationCalls.length, 1, '同币同分钟的价格只读一次')
assert.equal(valued.records[0].quantity, '10', '折算不改原币数量')
assert.equal(valued.records[0].status, '已记录', '折算不冒充平台到账成功')
assert(validTransactionState({ records: valued.records, syncs: [] }), '折算资料允许保存')
assert.equal(valued.missing, 0)
const cachedValue = await valueRewards([rawReward], valued.records, async () => assert.fail('应复用已保存价格'))
assert.equal(cachedValue.records[0].rewardValuation.usdtQuantity, '3')
const changedReward = await valueRewards([{ ...rawReward, quantity: '20' }], valued.records, async () => assert.fail('可复用同币同时点价格，但必须重新乘数量'))
assert.equal(changedReward.records[0].rewardValuation.usdtQuantity, '6')
const parityValue = await valueRewards([{ ...rawReward, asset: 'USDC', quantity: '2.5' }, { ...rawReward, id: rawReward.id + ':usdt', asset: 'USDT', quantity: '-0.1' }], [], async () => assert.fail('稳定币按指定1:1，无需请求价格'))
assert.deepEqual(parityValue.records.map(item => item.rewardValuation.usdtQuantity), ['2.5', '-0.1'])
const noPrice = await valueRewards([rawReward], [], async () => [])
assert.equal(noPrice.missing, 1)
assert(!noPrice.records[0].rewardValuation, '无价格不填零，不冒充已完成换算')
const wrongMinute = await valueRewards([rawReward], [], async () => [[0, '0.3', '0.3', '0.3', '0.3', '10', 59999, '3', 1, '0', '0', '0']])
assert.equal(wrongMinute.missing, 1, '不能用其他时间的行情代替')
const usdcFallback = await valueRewards([rawReward], [], async url => new URL(url).searchParams.get('symbol') === 'ARBUSDC' ? fakeHistoryPrice(url) : [])
assert.equal(usdcFallback.records[0].rewardValuation.usdtQuantity, '3')
assert.equal(usdcFallback.records[0].rewardValuation.pair, 'ARBUSDC', '没有USDT交易对时可按指定1:1使用USDC交易对')
const noTrades = await valueRewards([rawReward], [], async url => { const candle = (await fakeHistoryPrice(url))[0]; candle[8] = 0; return [candle] })
assert.equal(noTrades.missing, 1, '该分钟无成交时不把填充价格当成可用行情')
const negativeValue = await valueRewards([{ ...rawReward, quantity: '-10' }], valued.records, async () => assert.fail('沿用同分钟历史价格'))
assert.equal(negativeValue.records[0].rewardValuation.usdtQuantity, '-3', '扣回奖励保留负数')
const budgetCalls = []
const cappedRewards = Array.from({ length: 20 }, (_, index) => ({ ...rawReward, identity: 'quote-rotation', id: rawReward.id + ':cap:' + index, time: rawReward.time - index * 60000 }))
const cappedValue = await valueRewards(cappedRewards, [], async url => { budgetCalls.push(url); return [] })
assert.equal(budgetCalls.length, 64, '历史价查询达到本轮上限即停止')
assert.equal(cappedValue.missing, 20, '本轮缺价全部保留原记录')
const laterMinute = Math.floor(cappedRewards[19].time / 60000) * 60000
const nextBatch = await valueRewards(cappedRewards, [], async url => {
  const minute = Number(new URL(url).searchParams.get('startTime'))
  return minute === laterMinute ? [[minute, '0.3', '0.3', '0.3', '0.3', '100', minute + 59999, '30', 10, '0', '0', '0']] : []
})
assert.equal(nextBatch.records[19].rewardValuation.usdtQuantity, '3', '持续缺价的新记录不能挡住后面的可报价记录')
assert.deepEqual(nextBatch.records.map(item => item.id), cappedRewards.map(item => item.id), '轮换补价不改变记录顺序')
const failedValue = await valueRewards([{ ...rawReward, status: '失败' }, { ...rawReward, id: rawReward.id + ':bonus', note: 'WELCOME_BONUS' }], [], async () => assert.fail('失败记录和受限新人奖励不折算'))
assert(failedValue.records.every(item => !item.rewardValuation))
assert(!validTransactionState({ records: [{ ...valued.records[0], rewardValuation: { ...valued.records[0].rewardValuation, usdtQuantity: '999' } }], syncs: [] }), '保存时核对数量乘价格')
assert(!validTransactionState({ records: [{ ...valued.records[0], rewardValuation: { ...valued.records[0].rewardValuation, at: now + 60000 } }], syncs: [] }), '不接受不属于原记录时点的行情')
assert(!validTransactionState({ records: [{ ...record, quantity: 'NaN' }], syncs: [] }))
assert.equal(mergeTransactions([record], [record]).length, 1)
assert.equal(mergeTransactions([{ ...record, status: '处理中' }], [record])[0].status, '已完成')
assert.equal(filterTransactions([record], { query: 'btcusdt', type: '', account: '', source: '', start: '', end: '' }).length, 1)
assert.equal(filterTransactions([record], { query: '', type: '', account: '', source: '', start: '2026-10-22', end: '' }).length, 0)
const trade = { ...record, id: 'binance:test:usdm:BTCUSDT:1', scope: 'usdm', realizedPnl: '2', pnlAsset: 'USDT' }
const commission = { ...record, id: 'income-1', type: '手续费', asset: 'BNB', quantity: '-0.000001', relatedTradeId: trade.id }
assert.equal(mergeTransactions([commission], [trade]).length, 1, '费用从独立收支并回成交，不能扣两次')
assert.equal(mergeTransactions([{ ...commission, quantity: '-1' }], [trade]).length, 2, '金额不一致不能乱合并')
const pages = [], many = Array.from({ length: 1002 }, (_, id) => ({ id, time: id < 500 ? 1 : 2 }))
await readTradeWindow(async params => many.filter(row => row.time >= Number(params.startTime) && row.time <= Number(params.endTime)).slice(0, 1000), 0, 3, rows => pages.push(...rows))
assert.equal(new Set(pages.map(row => row.id)).size, 1002, '分页不能跳过同一毫秒中的成交')
await assert.rejects(readTradeWindow(async () => Array.from({ length: 1000 }, (_, id) => ({ id, time: 1 })), 1, 1, () => {}), /同一毫秒/)
const retainedTimes = []
await assert.rejects(readTradeWindow(async () => [{ id: 'good', time: 1 }, { id: 'bad', time: 'bad' }], 0, 3, rows => retainedTimes.push(...rows)), /交易时间/)
assert.deepEqual(retainedTimes.map(row => row.id), ['good'], '时间错误不丢弃同批可确认的记录，也不冒充完整')
await readRebateWindow(async () => ({ status: 'OK', code: '000000000', data: { page: 1, totalRecords: 0, totalPageNum: 0, data: [] } }), () => assert.fail('空范围不应生成奖励'))
await assert.rejects(readRebateWindow(async () => ({ status: 'OK', code: '000000000', data: { page: 1, totalRecords: 1, totalPageNum: 1, data: [] } }), () => {}), /未读全/)
await assert.rejects(readRebateWindow(async params => ({ status: 'OK', code: '000000000', data: { page: Number(params.page), totalRecords: Number(params.page) === 1 ? 2 : 3, totalPageNum: 2, data: [{}] } }), () => {}), /未读全/, '读取途中总量变化不能假装完整')
await assert.rejects(readRebateWindow(async params => ({ status: 'OK', code: '000000000', data: { page: Number(params.page), totalRecords: 11, totalPageNum: 11, data: [{}] } }), () => {}), /10页/, '大账户按预算保留部分结果')
await assert.rejects(readRebateWindow(async () => ({ status: 'ERROR', code: '000000000', data: { page: 1, totalRecords: 0, totalPageNum: 0, data: [] } }), () => {}), /未读全/)
const folder = mkdtempSync(join(tmpdir(), 'investment-transactions-'))
try {
  const store = createTransactionStore(folder)
  store.save([record], [])
  assert.equal(createTransactionStore(folder).list().records[0].quantity, record.quantity)
  const before = readFileSync(join(folder, 'transactions.json'), 'utf8')
  assert.throws(() => store.save([{ ...record, quantity: 'bad' }], []))
  assert.equal(readFileSync(join(folder, 'transactions.json'), 'utf8'), before)
  writeFileSync(join(folder, 'transactions.json'), '{broken')
  assert.throws(() => store.list(), /无法读取/)
} finally { rmSync(folder, { recursive: true, force: true }) }
const urls = []
const fetchJson = async url => {
  urls.push(url)
  const path = new URL(url).pathname
  if (path.endsWith('/time')) return { serverTime: Date.now() }
  if (path.endsWith('/apiRestrictions')) return { enableReading: true }
  throw new Error('unexpected')
}
const signed = await createBinanceClient({ apiKey: 'fake', apiSecret: 'fake' }, fetchJson)
await assert.rejects(signed('https://evil.example', '/api/v3/myTrades'), /不允许/)
await assert.rejects(signed('https://api.binance.com', '/api/v3/order'), /不允许/)
assert.equal(urls.length, 2)
await assert.rejects(readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot: { accounts: [] }, records: [], previous: [], spotPairs: [], now, fetchJson: async url => {
  const path = new URL(url).pathname
  if (path.endsWith('/time')) return { serverTime: Date.now() }
  if (path.endsWith('/apiRestrictions')) return { enableReading: true }
  if (path.endsWith('/account')) return { uid: '12345', balances: [] }
  throw new Error('不应继续查询')
} }), /先.*账户/)

const identity = createHash('sha256').update('12345').digest('hex')
const snapshot = { accounts: [{ id: 'live-' + connection.id + '-spot', sourceId: 'live-' + connection.id, identity }], contracts: [] }
const calls = []
let failDeposit = false, depositDone = false, apiNow = now, futureClockCalls = 0, failPosition = false, recentFill = false, failRebates = false, badOtherIncome = false, badFunding = false, unnamedFunding = false
let historyCalls = 0, failHistoryAfter = Infinity
let rebateCalls = 0
const fakeApi = async (url, options) => {
  const parsed = new URL(url), path = parsed.pathname, params = parsed.searchParams
  calls.push(parsed)
  if (path === '/fapi/v1/time') return { serverTime: apiNow + ++futureClockCalls }
  assert(!options?.method || options.method === 'GET', '平台只读查询')
  if (path.endsWith('/time')) return { serverTime: Date.now() }
  if (path.endsWith('/apiRestrictions')) return { enableReading: true }
  if (path === '/api/v3/account') return { uid: '12345', balances: [{ asset: 'BTC', free: '1', locked: '0' }] }
  if (path.endsWith('/deposit/hisrec')) {
    if (failDeposit) throw new Error('充值服务故意失败')
    return [{ id: 'd1', insertTime: now - 1000, coin: 'BTC', amount: '0.1', status: depositDone ? 1 : 0, network: 'BTC', txId: 'fakehash', address: 'fakeaddress', walletType: 0 }]
  }
  if (path.endsWith('/withdraw/history')) return []
  if (path.endsWith('/asset/transfer')) return { total: 0, rows: [] }
  if (path === '/sapi/v1/rebate/taxQuery') {
    rebateCalls++
    if (failRebates) throw new Error('模拟现货返佣失败')
    const page = Number(params.get('page'))
    const reward = { asset: 'USDC', type: 1, amount: '0.26456995', updateTime: now - 2000 }
    return { status: 'OK', code: '000000000', type: 'GENERAL', data: { page, totalRecords: 3, totalPageNum: 2, data: page === 1 ? [reward, reward] : [{ ...reward, type: 2, amount: '0.01' }] } }
  }
  if (path === '/fapi/v3/positionRisk') { if (failPosition) throw new Error('模拟仓位未取得'); return [] }
  if (path === '/fapi/v1/income') {
    if (params.get('incomeType') === 'FUNDING_FEE' && Number(params.get('startTime')) < apiNow - 7 * 86400000 && ++historyCalls > failHistoryAfter) throw new Error('模拟历史读取中断')
    return [
    { tranId: '9223372036854775807', time: now - 1000, incomeType: 'FUNDING_FEE', symbol: 'BTCUSDT', asset: 'USDT', income: '-0.01', tradeId: '' },
    ...(badFunding ? [{ tranId: '9223372036854775806', time: now - 999, incomeType: 'FUNDING_FEE', symbol: '', asset: 'USDT', income: 'broken', tradeId: '' }] : []),
    ...(unnamedFunding ? [{ tranId: '9223372036854775805', time: now - 998, incomeType: 'FUNDING_FEE', symbol: '', asset: 'USDT', income: '-0.02', tradeId: '' }] : []),
    { tranId: badOtherIncome ? 2.5 : 2, time: now - 1000, incomeType: 'COMMISSION', symbol: 'BTCUSDT', asset: 'USDT', income: '-0.1', tradeId: '7' },
    { tranId: 3, time: now - 1000, incomeType: 'REALIZED_PNL', symbol: 'BTCUSDT', asset: 'USDT', income: '2', tradeId: '7' },
    { tranId: 4, time: now - 1000, incomeType: 'COMMISSION_REBATE', symbol: 'BTCUSDT', asset: 'USDT', income: '1.5', tradeId: '' },
    { tranId: 5, time: now - 1000, incomeType: 'WELCOME_BONUS', symbol: '', asset: 'USDT', income: '3', tradeId: '' },
    ...['API_REBATE', 'CONTEST_REWARD', 'BFUSD_REWARD', 'REFERRAL_KICKBACK'].map((incomeType, index) => ({ tranId: 6 + index, time: now - 1000, incomeType, symbol: '', asset: 'USDT', income: '0.5', tradeId: '' })),
  ].filter(row => (!params.get('incomeType') || row.incomeType === params.get('incomeType')) && row.time >= Number(params.get('startTime')) && row.time <= Number(params.get('endTime')))
  }
  if (path.endsWith('/exchangeInfo')) return { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', isSpotTradingAllowed: true }] }
  if (path.endsWith('/myTrades') || path.endsWith('/userTrades')) {
    if (path.endsWith('/userTrades') && params.get('limit') === '1' && recentFill) return [{ time: Number(params.get('startTime')) }]
    const at = now - 1000
    if (at < Number(params.get('startTime')) || at > Number(params.get('endTime'))) return []
    return [{ id: 7, orderId: 8, symbol: 'BTCUSDT', time: at, qty: '0.1', price: '60000', quoteQty: '6000', commission: '0.1', commissionAsset: 'USDT', isBuyer: true, side: 'BUY', positionSide: 'LONG', realizedPnl: '2', marginAsset: 'USDT' }]
  }
  throw new Error('不允许的假请求：' + path)
}
const first = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: [], previous: [], spotPairs: [], now, fetchJson: fakeApi })
assert(validTransactionState(first), '读取结果必须可保存')
const merged = mergeTransactions([], first.records)
assert.equal(merged.filter(row => row.type === '买入').length, 2, '现货与合约不得互相去重')
assert.equal(merged.filter(row => row.type === '手续费' || row.type === '已实现盈亏').length, 0, '合约收支与成交对上时不重复记录')
assert.equal(merged.find(row => row.type === '资金费').quantity, '-0.01')
assert.equal(first.syncs.find(item => item.key === 'coverage:spot').status, 'partial')
assert(calls.every(url => !url.searchParams.has('startTime') || url.pathname === '/fapi/v1/income' && url.searchParams.get('incomeType') === 'FUNDING_FEE' || Number(url.searchParams.get('startTime')) >= now - 7 * 86400000))
assert(calls.some(url => url.pathname === '/fapi/v1/income' && url.searchParams.get('incomeType') === 'FUNDING_FEE'), '资金费独立查询')
assert.equal(first.syncs.find(item => item.key === 'income').coverage.from, fundingHistoryWindows(first.syncs.find(item => item.key === 'income').to).start)
assert.equal(first.syncs.find(item => item.key === 'income').from, first.syncs.find(item => item.key === 'income').coverage.from, '页面显示实际已核对范围')
assert(calls.some(url => url.pathname === '/fapi/v1/userTrades'), '已平仓品种也从收支发现并查询')
assert.equal(first.records.filter(row => row.type === '奖励').length, 9, '现货返佣及合约官方奖励都要保留')
assert.equal(rebateCalls, 2, '读取完整两页现货奖励')
assert.equal(new Set(first.records.filter(row => row.scope === 'spot-rebate').map(row => row.id)).size, 3, '相同时间金额的两笔奖励不能丢一笔')
assert(first.records.filter(row => row.scope === 'spot-rebate').every(row => row.status === '已记录'), '检索成功不冒充已到账')
assert.equal(first.records.find(row => row.scope === 'usdm' && row.type === '买入').positionSide, 'LONG')
assert.equal(first.syncs.find(item => item.key === 'usdm:BTCUSDT').positionCheck.at, first.syncs.find(item => item.key === 'usdm:BTCUSDT').to)
depositDone = true
apiNow = now + 10000
const second = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, spotPairs: [], now: now + 10000, fetchJson: fakeApi })
assert.equal(mergeTransactions(merged, second.records).find(row => row.type === '充值').status, '已完成')
assert.equal(second.syncs.find(item => item.key === 'usdm:BTCUSDT').coverage.from, first.syncs.find(item => item.key === 'usdm:BTCUSDT').coverage.from)
assert.equal(second.syncs.find(item => item.key === 'spot:BTCUSDT').coverage.from, first.syncs.find(item => item.key === 'spot:BTCUSDT').coverage.from, '现货增量读取必须保留连续历史起点')
assert(validTransactionState(second), '带现货连续覆盖范围的记录仍可保存')
assert.equal(rebateCalls, 2, '现货重查询一小时内不重复')
const dormantPrior = Array.from({ length: 15 }, (_, index) => ({ ...first.syncs.find(item => item.key === 'usdm:BTCUSDT'), key: 'usdm:OLD' + index + 'USDT', lastSuccess: now - 86400000 * 3 - index, at: now - 86400000 * 3 - index }))
calls.length = 0
const lane = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: [...first.syncs, ...dormantPrior], spotPairs: [], now: now + 10000, fetchJson: fakeApi })
const tradeSymbols = calls.filter(url => url.pathname === '/fapi/v1/userTrades' && url.searchParams.get('limit') !== '1').map(url => url.searchParams.get('symbol'))
assert.equal(tradeSymbols[0], 'BTCUSDT', '近期有收支的品种先读')
assert.equal(tradeSymbols.filter(symbol => symbol.startsWith('OLD')).length, 10, '久未交易的品种每轮只补10个')
assert.deepEqual(lane.syncs.find(item => item.key === 'usdm:OLD0USDT'), dormantPrior[0], '本轮没读的旧品种沿用上次结果，不报错')
assert.equal(lane.syncs.find(item => item.key === 'usdm:BTCUSDT').status, 'ok')
failPosition = true
const anchorFailure = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, spotPairs: [], fetchJson: fakeApi })
assert.deepEqual(anchorFailure.syncs.find(item => item.key === 'usdm:BTCUSDT').positionCheck, first.syncs.find(item => item.key === 'usdm:BTCUSDT').positionCheck)
failPosition = false; recentFill = true
const changedDuringRead = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, spotPairs: [], fetchJson: fakeApi })
assert.equal(changedDuringRead.syncs.find(item => item.key === 'usdm:BTCUSDT').status, 'partial')
recentFill = false
failDeposit = true
const failedPart = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, spotPairs: [], now: now + 10000, fetchJson: fakeApi })
assert.equal(failedPart.syncs.find(item => item.key === 'deposits').status, 'error')
assert(failedPart.records.some(row => row.type === '买入'), '单个范围失败不阻断其他范围')
assert(mergeTransactions(merged, failedPart.records).some(row => row.type === '充值'), '失败保留旧记录')
badOtherIncome = true
const badOther = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, fetchJson: fakeApi })
assert.equal(badOther.syncs.find(item => item.key === 'income').status, 'ok', '其他收支失败不阻断资金费')
assert.equal(badOther.syncs.find(item => item.key === 'income:other').status, 'partial')
assert.match(badOther.syncs.find(item => item.key === 'income:other').warning, /流水编号/)
assert(badOther.records.some(row => row.type === '资金费' && row.quantity === '-0.01'))
badOtherIncome = false; badFunding = true
const badFund = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, fetchJson: fakeApi })
assert.equal(badFund.syncs.find(item => item.key === 'income').status, 'partial')
assert.match(badFund.syncs.find(item => item.key === 'income').warning, /资金费金额/)
assert.deepEqual(badFund.syncs.find(item => item.key === 'income').coverage, first.syncs.find(item => item.key === 'income').coverage, '失败保留旧核对范围')
assert(badFund.records.some(row => row.type === '资金费' && row.quantity === '-0.01'), '坏记录不丢弃同批合法资金费')
badFunding = false
unnamedFunding = true
const unnamed = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: [], previous: [], fetchJson: fakeApi })
assert.equal(unnamed.syncs.find(item => item.key === 'income').status, 'partial')
assert.equal(unnamed.syncs.find(item => item.key === 'income').coverage, undefined, '未分配品种的资金费不冒充完整仓位核对')
assert(unnamed.records.some(row => row.type === '资金费' && row.symbol === '' && row.quantity === '-0.02'), '账户级资金费金额仍保留')
unnamedFunding = false; historyCalls = 0; failHistoryAfter = 2
const historyInterrupted = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: [], previous: [], fetchJson: fakeApi })
const progress = historyInterrupted.syncs.find(item => item.key === 'income').coverage
assert(progress.from < progress.to - 7 * 86400000, '中断前完整读完的日期仍保留核对进度')
assert.notEqual(historyInterrupted.syncs.find(item => item.key === 'income:history').status, 'ok')
assert.equal(fundingHistoryWindows(progress.to, { status: 'ok', ...progress }).windows[0].end, progress.from - 1, '重试从尚未读完的历史继续')
failHistoryAfter = Infinity
apiNow = now + 3600000
const beforeRewardRefresh = rebateCalls
const rewardsAgain = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: first.syncs, fetchJson: fakeApi })
assert.equal(rebateCalls - beforeRewardRefresh, 2, '到期后重新读取两页奖励')
const repeatIds = first.records.filter(row => row.scope === 'spot-rebate').map(row => row.id)
assert.deepEqual(rewardsAgain.records.filter(row => row.scope === 'spot-rebate').map(row => row.id), repeatIds, '奖励重复读取编号保持稳定')
assert.equal(mergeTransactions(merged, rewardsAgain.records).filter(row => row.scope === 'spot-rebate').length, 3, '两次读取同一批奖励不会重复列入')
failRebates = true; apiNow += 3600000
const rewardsFailed = await readBinanceTransactions(connection, { apiKey: 'fake', apiSecret: 'fake' }, { snapshot, records: merged, previous: rewardsAgain.syncs, fetchJson: fakeApi })
assert.equal(rewardsFailed.syncs.find(item => item.key === 'rewards:spot').status, 'error')
assert(mergeTransactions(merged, rewardsFailed.records).some(row => row.scope === 'spot-rebate'), '返佣失败不清空奖励历史')
const serviceFolder = mkdtempSync(join(tmpdir(), 'investment-transactions-service-'))
try {
  const vaultValues = new Map()
  let release
  const hold = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const service = createConnectionService(serviceFolder, {
    vault: { get: async id => vaultValues.get(id), set: async (id, value) => { vaultValues.set(id, value) }, remove: async id => { vaultValues.delete(id) } },
    dailyPrices: async parts => parts,
    readers: { binance: async input => [{ account: { id: 'live-' + input.id + '-spot', sourceId: 'live-' + input.id, identity, uid: '12345', name: input.name, status: 'ok', updatedAt: new Date(now).toISOString(), warning: '', pnlCents: 0 }, holdings: [], contracts: [] }] },
    transactionReader: async () => { entered(); await hold; return { records: [], syncs: [] } },
  })
  const connected = await service.upsert({ type: 'binance', name: '隔离账户', apiKey: 'A'.repeat(32), apiSecret: 'B'.repeat(32) })
  const id = connected.connections[0].id
  const saving = service.syncTransactions(id, { spotPairs: [] })
  await started
  await assert.rejects(service.remove(id), /正在处理/)
  release(); await saving
  assert.deepEqual(service.list().snapshot, connected.snapshot, '流水同步不改资产余额')
} finally { rmSync(serviceFolder, { recursive: true, force: true }) }
console.log('交易记录隔离检查通过（未连接真实账户）')

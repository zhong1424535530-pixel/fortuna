// 用户另行同意模拟测试后运行；纯内存假资料，不读取账户或密钥。
import assert from 'node:assert/strict'
import { queryTransactionPage } from '../server/transaction-query.mjs'
import { validTransactionState } from '../src/data/transactions.ts'

const connectionId = '12345678-1234-1234-1234-123456789abc', end = Date.parse('2026-10-22T12:00:00+08:00'), start = end - 3 * 86400000
const base = { connectionId, connectionName: '模拟账户', identity: 'query-test', account: 'U本位合约', scope: 'usdm', asset: 'USDT', symbol: '', quoteAsset: '', quoteQuantity: null, price: null, fees: [], realizedPnl: null, pnlAsset: '', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: 'COMMISSION_REBATE', relatedTradeId: '' }
const rewards = Array.from({ length: 26 }, (_, index) => ({ ...base, id: `binance:query-test:usdm:income:reward:${index}`, time: end - index * 1000, type: '奖励', quantity: '1' }))
const trade = (id, type, at, price, pnl) => ({ ...base, id: `binance:query-test:usdm:BTCUSDT:${id}`, time: at, asset: 'BTC', symbol: 'BTCUSDT', type, quantity: '1', quoteAsset: 'USDT', quoteQuantity: price, price, realizedPnl: pnl, pnlAsset: 'USDT', note: '', orderId: String(id), fees: [{ asset: 'USDT', quantity: '0.01' }], positionSide: 'LONG' })
const records = [...rewards, trade(1, '买入', start + 1000, '100', '0'), trade(2, '卖出', end - 50000, '110', '10')]
const common = { connectionId, connectionName: base.connectionName, identity: base.identity, label: '模拟覆盖', status: 'ok', from: start, to: end, at: end, lastSuccess: end, warning: '' }
const state = { records, syncs: [{ ...common, key: 'usdm:BTCUSDT', coverage: { from: start, to: end, count: 2 }, positionCheck: { at: end, positions: ['LONG', 'SHORT', 'BOTH'].map(side => ({ side, quantity: '0' })) } }, { ...common, key: 'income', coverage: { from: start, to: end, count: 0 } }] }
assert(validTransactionState(state))
const query = new URLSearchParams({ category: '奖励', start: '2026-10-22', end: '2026-10-22', page: '2' })
const page = queryTransactionPage(state, [], query)
assert.equal(page.total, 1, '同天同类奖励合成一张卡')
assert.equal(page.page, 1, '超出页数时回到最后一页')
assert.equal(page.entries[0].kind, 'rewards')
assert.equal(page.entries[0].rows.length, 26)
assert.equal(page.entries[0].quantity, '26')
assert.equal(page.totals.rewards[0].quantity, '26', '汇总依然覆盖全部筛选日期')
assert.equal(queryTransactionPage({ ...state, records: [rewards[0], ...records.slice(26)] }, [], query).entries[0].kind, 'transaction', '只有一笔奖励时保持原卡片')
query.set('query', '不存在')
assert.equal(queryTransactionPage(state, [], query).entries.length, 0)
assert.equal(queryTransactionPage(state, [], query).totals.rewards[0].quantity, '26', '搜索不改变汇总')
const contracts = queryTransactionPage(state, [], new URLSearchParams({ category: '合约', start: '2026-10-22', end: '2026-10-22' }))
assert.equal(contracts.total, 1, '早于开始日期的开仓仍参与完整平仓整理')
assert.equal(contracts.entries[0].round.openPrice, '100')
assert.equal(contracts.totals.pnl[0].quantity, '10')
assert.throws(() => queryTransactionPage(state, [], new URLSearchParams({ page: '-1' })))
assert.throws(() => queryTransactionPage(state, [], new URLSearchParams({ start: '2026-10-23', end: '2026-10-22' })))
console.log('资料库分页及跨期合约模拟检查通过（未连接真实账户）')

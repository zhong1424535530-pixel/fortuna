// 仅在用户同意模拟测试后运行；只用假响应，不读取密钥或连接真实账户。
import assert from 'node:assert/strict'
import { parseBinanceExitOrders, readBinanceExitOrders } from '../server/binance-protection.mjs'
import { createBinanceClient } from '../server/binance-reader.mjs'
import { validateState } from '../server/connection-service.mjs'
import { exitOrdersReadState, validExitOrders } from '../src/data/contract-protection.ts'
import { formatPrice } from '../src/data/portfolio.ts'

const position = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.3' }
const order = (overrides = {}) => ({ algoId: '1', algoType: 'CONDITIONAL', orderType: 'TAKE_PROFIT_MARKET', algoStatus: 'NEW', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', triggerPrice: '70000.12345678', quantity: '0.1', closePosition: false, reduceOnly: true, workingType: 'MARK_PRICE', ...overrides })
const parse = (rows, rawPosition = position, quote = '1') => parseBinanceExitOrders(rows, rawPosition, quote)

assert.deepEqual(parse([order()]), [{ id: '1', kind: '止盈', triggerPriceUsd: 70000.12345678, quantity: 0.1, triggerBasis: '标记价' }])
assert.deepEqual(parse([]), [])
assert.equal(parse(null), null)
assert.equal(parse({ orders: [] }), null)
assert.equal(parse([null]), null)
assert.equal(parse([order({ algoId: Number.MAX_SAFE_INTEGER + 1 })]), null)
assert.equal(parse([order({ algoId: 'not-an-id' })]), null)
assert.equal(parse([order({ quantity: '0' })]), null)
assert.equal(parse([order({ quantity: '-1' })]), null)
assert.equal(parse([order({ triggerPrice: '0' })]), null)
assert.equal(parse([order({ triggerPrice: 'NaN' })]), null)
assert.equal(parse([order({ triggerPrice: '1e40' })]), null)
assert.equal(parse([order({ reduceOnly: 'yes' })]), null)
assert.equal(parse([order({ closePosition: true, reduceOnly: true })]), null)
assert.equal(parse([order({ orderType: 'STOP', closePosition: true, reduceOnly: false })]), null)
assert.equal(parse([order(), order()]), null)
assert.equal(parse([order({ algoStatus: 'TRIGGERED' })]), null)
assert.equal(parse([order({ orderType: 'UNKNOWN' })]), null)
assert.equal(parse([order()], { ...position, positionAmt: '0' }), null)
assert.equal(parse([order()], { ...position, positionSide: 'LONG', positionAmt: '-1' }), null)
assert.equal(parse([order()], { ...position, positionSide: 'SHORT' }), null)
assert.equal(parse([order()], position, '0'), null)
assert.equal(parse([order()], position, null)[0].triggerPriceUsd, null)
assert.equal(parse([order()], position, '.999')[0].triggerPriceUsd, 69930.12333332322)

assert.deepEqual(parse([order({ side: 'BUY', reduceOnly: false })]), []) // 开仓方向不能认作平仓。
assert.deepEqual(parse([order({ symbol: 'ETHUSDT' })]), [])
assert.equal(parse([order({ reduceOnly: false })]), null) // 可能反手开仓，不能宣称未设置。
const closeAll = parse([order({ orderType: 'STOP_MARKET', triggerPrice: '59000', closePosition: 'true', reduceOnly: false, quantity: '0' })])[0]
assert.equal(closeAll.kind, '止损')
assert.equal(closeAll.quantity, null)
assert.equal(closeAll.triggerPriceUsd, 59000)
assert.equal(parse([order({ reduceOnly: 'true' })])[0].quantity, .1)
const multiple = parse([order(), order({ algoId: '2', triggerPrice: '71000', quantity: '.2' }), order({ algoId: '3', orderType: 'STOP', triggerPrice: '59000' })])
assert.equal(multiple.length, 3)
assert.equal(multiple.filter(row => row.kind === '止盈').length, 2)
assert.equal(exitOrdersReadState(multiple, 'error'), 'cached', '账户读取失败不能隐藏完整保存的止盈止损')
assert.equal(exitOrdersReadState(multiple, 'pending'), 'cached')
assert.equal(exitOrdersReadState(multiple, 'ok'), 'ready')
assert.equal(exitOrdersReadState([], 'error'), 'cached', '上次没有委托也只是上次记录')
assert.equal(exitOrdersReadState([], 'ok'), 'ready')
assert.equal(exitOrdersReadState(null, 'ok'), 'missing', '单独委托查询失败不能冒充成功')
assert.equal(exitOrdersReadState(undefined, 'error'), 'missing', '没有旧资料不能造出旧价格')
const trailing = parse([order({ orderType: 'TRAILING_STOP_MARKET', triggerPrice: '0', activatePrice: '71000', workingType: 'CONTRACT_PRICE' })])[0]
assert.equal(trailing.kind, '移动止损')
assert.equal(trailing.triggerPriceUsd, null)
assert.equal(trailing.triggerBasis, '最新价')
const short = { ...position, positionAmt: '-.2' }
assert.equal(parse([order({ side: 'BUY', orderType: 'STOP_MARKET' })], short)[0].kind, '止损')
assert.deepEqual(parse([order()], short), [])
const hedgeOrders = [order({ positionSide: 'LONG', reduceOnly: false }), order({ algoId: '2', positionSide: 'SHORT', side: 'BUY', reduceOnly: false }), order({ algoId: '3', positionSide: 'LONG', side: 'BUY', reduceOnly: false })]
assert.deepEqual(parse(hedgeOrders, { ...position, positionSide: 'LONG' }).map(row => row.id), ['1'])
assert.deepEqual(parse(hedgeOrders, { ...short, positionSide: 'SHORT' }).map(row => row.id), ['2'])

const usd = new Map([['USDT', '1'], ['USDC', '.99']])
let calls = []
const results = await readBinanceExitOrders([{ ...position, positionSide: 'LONG' }, { ...short, positionSide: 'SHORT' }, { ...position, symbol: 'ETHUSDT' }, { ...position, symbol: 'SOLUSDC' }], async symbol => {
  calls.push(symbol)
  if (symbol === 'ETHUSDT') throw new Error('fake network failure')
  return symbol === 'BTCUSDT' ? hedgeOrders : [order({ symbol, triggerPrice: '10' })]
}, usd)
assert.deepEqual(calls, ['BTCUSDT', 'ETHUSDT', 'SOLUSDC'])
assert.deepEqual(results.map(rows => rows?.length ?? null), [1, 1, null, 1])
assert.equal(results[3][0].triggerPriceUsd, 9.9)
calls = []
assert.deepEqual(await readBinanceExitOrders([], async symbol => { calls.push(symbol); return [] }, usd), [])
assert.deepEqual(calls, [])
let active = 0, maximum = 0
await readBinanceExitOrders(Array.from({ length: 9 }, (_, i) => ({ ...position, symbol: `COIN${i}USDT` })), async () => {
  active++; maximum = Math.max(maximum, active)
  await Promise.resolve()
  active--; return []
}, usd)
assert.equal(maximum, 4)

assert.equal(validExitOrders(undefined), true)
assert.equal(validExitOrders(null), true)
assert.equal(validExitOrders([]), true)
assert.equal(validExitOrders(multiple), true)
assert.equal(validExitOrders([{ ...multiple[0], triggerPriceUsd: Infinity }]), false)
assert.equal(validExitOrders([{ ...multiple[0], kind: '移动止损' }]), false)
assert.equal(validExitOrders([{ ...multiple[0], quantity: NaN }]), false)
assert.equal(validExitOrders(Array(1001).fill(multiple[0])), false)
const connectionId = '12345678-1234-1234-1234-123456789abc'
const accountId = `live-${connectionId}-usdm`
const contract = { id: 'contract', symbol: 'BTCUSDT', name: 'BTCUSDT', icon: '', accountId, direction: '做多', quantity: .3, baseAsset: 'BTC', entryPriceUsd: 60000, markPriceUsd: 61000, leverage: 10, marginMode: '全仓', marginCents: 180000, liquidationPriceUsd: null, unrealizedPnlCents: 30000 }
const state = {
  connections: [{ id: connectionId, type: 'binance', name: '假账户', status: 'ok', updatedAt: '2026-10-25T00:00:00Z', warning: '', hasCredential: true }],
  snapshot: { accounts: [{ id: accountId, sourceId: `live-${connectionId}`, name: '假账户', status: 'ok', pnlCents: 30000, updatedAt: '2026-10-25T00:00:00Z', warning: '' }], holdings: [], contracts: [contract] },
}
assert.doesNotThrow(() => validateState(state)) // 旧资料仍可打开。
for (const exitOrders of [null, [], multiple]) assert.doesNotThrow(() => validateState({ ...state, snapshot: { ...state.snapshot, contracts: [{ ...contract, exitOrders }] } }))
assert.throws(() => validateState({ ...state, snapshot: { ...state.snapshot, contracts: [{ ...contract, exitOrders: [{ ...multiple[0], triggerPriceUsd: -1 }] }] } }))
for (const [price, expected] of [[80559.187, '80,559.19'], [143.258751, '143.26'], [10, '10.00'], [1.23456, '1.23'], [1, '1.00'], [.12345678, '0.1235'], [.999051, '0.9991'], [.023456, '0.0235'], [.0000123456, '0.00001235'], [.000000123456, '0.0000001235'], [0, '0.00']]) {
  assert.ok(formatPrice(price, 'USD').endsWith(expected), `${price} -> ${formatPrice(price, 'USD')}`)
}
assert.equal(formatPrice(12.345678, 'USD', true), '••••••')
assert.equal(formatPrice(null, 'USD'), '待补价格')
assert.match(formatPrice(12.345678, 'USD'), /12\.35/)

const requested = []
const signed = await createBinanceClient({ apiKey: 'fake-key', apiSecret: 'fake-secret' }, async (url, options) => {
  requested.push(url)
  assert.ok(!options?.method || options.method === 'GET')
  if (url.includes('/time')) return { serverTime: Date.now() }
  if (url.includes('/apiRestrictions')) return { enableReading: true }
  if (url.includes('/openAlgoOrders?')) return []
  throw new Error('unexpected fake request')
})
assert.deepEqual(await signed('https://fapi.binance.com', '/fapi/v1/openAlgoOrders', { symbol: 'BTCUSDT', algoType: 'CONDITIONAL' }), [])
assert.ok(requested.at(-1).includes('symbol=BTCUSDT&algoType=CONDITIONAL'))
assert.ok(requested.at(-1).includes('signature='))
await assert.rejects(signed('https://fapi.binance.com', '/fapi/v1/algoOrder'), /不允许/)
await assert.rejects(signed('https://api.binance.com', '/fapi/v1/openAlgoOrders'), /不允许/)
console.log('合约止盈止损隔离检查通过；未连接真实平台。')

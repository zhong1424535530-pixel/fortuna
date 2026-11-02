// 只用假行情和假时钟，不联网。
import assert from 'node:assert/strict'
import { cnExchange, createCnQuoteService, parseEastmoney, parseTencent, parseTencentUs, usSymbol } from '../server/cn-quotes.mjs'

assert.deepEqual(cnExchange('600519'), { em: '1.600519', qq: 'sh600519' })
assert.deepEqual(cnExchange('688981'), { em: '1.688981', qq: 'sh688981' })
assert.deepEqual(cnExchange('001309'), { em: '0.001309', qq: 'sz001309' })
assert.deepEqual(cnExchange('300750'), { em: '0.300750', qq: 'sz300750' })
assert.deepEqual(cnExchange('830799'), { em: '0.830799', qq: 'bj830799' })
for (const bad of ['', '00130', '0013090', 'abcdef', null]) assert.equal(cnExchange(bad), null)

const em = { data: { f43: 24252, f57: '001309', f58: '德明利', f59: 2, f60: 25100, f86: 1793000055 } }
assert.deepEqual(parseEastmoney(em, '001309'), { name: '德明利', price: 242.52, prevClose: 251, at: 1793000055000 })
assert.equal(parseEastmoney(em, '600519'), null, '代码对不上不采用')
assert.equal(parseEastmoney({ data: { ...em.data, f43: '-' } }, '001309'), null, '停牌或无价不当作零')

const line = 'v_sz001309="51~德明利~001309~242.52~251.00~248.49~280117~' + '~'.repeat(23) + '20261026161415~-8.48"'
assert.deepEqual(parseTencent(line, '001309'), { name: '德明利', price: 242.52, prevClose: 251, at: Date.parse('2026-10-26T16:14:15+08:00') })
assert.equal(parseTencent(line, '600519'), null)

// 东方财富失败时用腾讯；5分钟内重复查询走缓存；两边都失败时不返回假价格
let clock = 0, emCalls = 0, qqCalls = 0
const service = createCnQuoteService({
  now: () => clock,
  fetchJson: async () => { emCalls++; throw new Error('down') },
  fetchText: async () => { qqCalls++; return line + ';\n' },
})
assert.deepEqual(Object.keys(await service.read(['001309', 'bad'])), ['001309'])
assert.equal((await service.read(['001309']))['001309'].price, 242.52)
assert.deepEqual([emCalls, qqCalls], [1, 1], '缓存期内不重复请求')
clock = 301000
await service.read(['001309'])
assert.deepEqual([emCalls, qqCalls], [2, 2])
const down = createCnQuoteService({ fetchJson: async () => { throw new Error('down') }, fetchText: async () => { throw new Error('down') } })
assert.deepEqual(await down.read(['001309']), {})

// 美股：键写成 us:代码，腾讯行情时间是美东时间（夏令时 UTC-4，冬令时 UTC-5）
assert.equal(usSymbol('us:TSLA'), 'TSLA')
assert.equal(usSymbol('us:BRK.B'), 'BRK.B')
for (const bad of ['TSLA', 'us:tsla', 'us:TOOLONG', 'us:', 'us:A.BC', null]) assert.equal(usSymbol(bad), null)
const usLine = (time, price = '404.22') => 'v_usTSLA="200~特斯拉~TSLA.OQ~' + price + '~407.46~410.16~' + '~'.repeat(24) + time + '~-3.24"'
assert.deepEqual(parseTencentUs(usLine('2026-10-28 16:00:01'), 'TSLA'), { name: '特斯拉', price: 404.22, prevClose: 407.46, at: Date.parse('2026-10-28T20:00:01Z') })
assert.equal(parseTencentUs(usLine('2026-12-15 09:30:00'), 'TSLA').at, Date.parse('2026-12-15T14:30:00Z'), '冬令时')
assert.equal(parseTencentUs(usLine('2026-10-28 16:00:01'), 'AAPL'), null, '代码对不上不采用')
assert.equal(parseTencentUs(usLine('2026-10-28 16:00:01', '0'), 'TSLA'), null, '无价不当作零')
assert.equal(parseTencentUs(usLine('not a time'), 'TSLA'), null)
const usService = createCnQuoteService({ now: () => 0, fetchJson: async () => { throw new Error('should not be used') }, fetchText: async url => { assert.match(url, /q=usTSLA$/); return usLine('2026-10-28 16:00:01') + ';\n' } })
assert.deepEqual(Object.keys(await usService.read(['us:TSLA', 'us:tsla', 'TSLA'])), ['us:TSLA'])

console.log('A股和美股行情解析、交易所判断、备用来源和缓存检查通过。')

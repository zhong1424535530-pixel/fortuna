// 页面读取走势：打开时读全部，之后只补最近的新点，避免几年后每 5 分钟重复下载整份历史。
import assert from 'node:assert/strict'
import { savedEquityPoints, syncEquityHistory } from '../src/data/equity-history.ts'

const now = Math.floor(Date.now() / 1000)
const point = (t, net) => ({ t, net, gross: net, rows: [], prices: [], contracts: [], accounts: [] })
let server = [point(now - 86400, 100), point(now - 7000, 200), point(now - 60, 300)]
const urls = []
globalThis.fetch = async url => { urls.push(url); const start = Number(new URL(url, 'http://x').searchParams.get('start') ?? 0); return { ok: true, json: async () => ({ points: server.filter(item => item.t >= start) }) } }

await syncEquityHistory()
assert.equal(urls[0], '/api/equity-history', '第一次读全部')
assert.equal(savedEquityPoints().length, 3)

server = [...server, point(now, 400)]
server[1] = point(now - 7000, 250) // 服务器整理后同一时段的点发生变化，页面应以服务器为准
await syncEquityHistory()
assert.equal(urls[1], `/api/equity-history?start=${now - 60 - 7200}`, '之后只读最近 2 小时')
assert.deepEqual(savedEquityPoints().map(item => item.net), [100, 250, 300, 400], '旧点保留、重叠时段被替换、新点追加')

const before = savedEquityPoints().length
globalThis.fetch = async () => { throw new Error('offline') }
await syncEquityHistory()
assert.equal(savedEquityPoints().length, before, '读取失败时保留已有数据')
console.log('走势读取检查通过：首次全量、之后增量、重叠替换、失败保留。')

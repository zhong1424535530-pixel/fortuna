// 长期运行的稳定性检查：只用临时目录和假服务，不联网、不碰真实资料。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { createWorkspaceApi } from '../server/workspace-api.mjs'
import { startScheduler } from '../server/scheduler.mjs'
import { createWorkspaceStore } from '../server/workspace-store.mjs'
import { clearStaleWriterLock, closeDatabase, databaseLockPath, databaseWriterLockPath, ensureDatabase, getDatabase, withDatabaseWriter } from '../server/database.mjs'
import { compactHistory, saveEquityPoint } from '../server/equity-history.mjs'
import { assertWorkspacePortfolio } from '../src/data/portfolio.ts'
import { emptyWorkspace } from '../src/data/workspace.ts'

const folders = []
const temp = () => { const folder = mkdtempSync(join(tmpdir(), 'stability-')); folders.push(folder); return folder }
const fx = { refresh: async () => {}, list: () => ({ quote: null }) }
const cnQuotes = { read: async () => ({}) }
const errors = []
const originalError = console.error
console.error = (...args) => errors.push(args.join(' '))
try {
  // 3：接入资料读取抛错时，定时任务不能让进程崩溃，要记录原因并继续后面的步骤。
  {
    const calls = []
    const connections = { list: () => { throw new Error('接入资料损坏') }, refreshMarket: async () => { calls.push('market') }, listTransactions: () => { throw new Error('交易资料损坏') }, syncTransactions: async () => ({ syncs: [] }) }
    const scheduler = startScheduler({ folder: temp(), store: { inspect: () => ({ data: null, error: '损坏' }) }, connections, fx, cnQuotes, tickMs: 3600000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    await scheduler.tick()
    scheduler.stop()
    assert.ok(calls.includes('market'), '账户读取失败后仍要继续更新行情')
    assert.ok(errors.some(line => line.includes('账户读取失败') && line.includes('接入资料损坏')), '失败原因要写入日志')
  }

  // 8：从未手动保存过资料（没有 workspace.json）时，只接账户也要记录走势；资料损坏时不记录。
  for (const damaged of [false, true]) {
    const folder = temp()
    if (damaged) writeFileSync(join(folder, 'workspace.json'), '{broken')
    const account = { id: 'live-00000000-0000-4000-8000-000000000000-eth', sourceId: 'live-00000000-0000-4000-8000-000000000000', name: '钱包', kind: '钱包', icon: '', color: '', status: 'ok', updatedAt: new Date().toISOString(), warning: '', pnlCents: 0 }
    const holding = { id: 'evm:1:native', symbol: 'ETH', name: 'ETH', market: 'crypto', category: '加密资产', usdPrice: 100, change24h: null, icon: '', color: '', source: '', description: '', positions: [{ accountId: account.id, quantity: 1, valueCents: 10000 }] }
    const live = { connections: [{ id: '00000000-0000-4000-8000-000000000000', type: 'wallet', name: '钱包' }], snapshot: { accounts: [account], holdings: [holding], contracts: [] } }
    const connections = { list: () => live, sync: async () => {}, refreshMarket: async () => {}, listTransactions: () => ({ records: [], syncs: [] }), syncTransactions: async () => ({ syncs: [] }) }
    const scheduler = startScheduler({ folder, store: createWorkspaceStore(folder), connections, fx, cnQuotes, tickMs: 3600000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    scheduler.stop()
    assert.equal(existsSync(join(folder, 'equity-history.json')), !damaged, damaged ? '资料损坏时不能写走势点' : '没有手动资料也要记录走势点')
  }

  // 9：任何平台的账户编号后缀（unified、trading 等）都不能让保存检查把整份资料判为损坏。
  for (const suffix of ['spot', 'usdm', 'unified', 'trading', 'funding-stocks']) {
    const data = { ...emptyWorkspace(), costs: { 'okx:BTC': { [`live-00000000-0000-4000-8000-000000000000-${suffix}`]: { averagePrice: 1, currency: 'USD', quantity: 1, feeIncluded: true, updatedAt: new Date().toISOString() } } } }
    assert.doesNotThrow(() => assertWorkspacePortfolio(data, { accounts: [], holdings: [], contracts: [] }), `${suffix} 账户的成本记录应当可以保存`)
  }
  assert.throws(() => assertWorkspacePortfolio({ ...emptyWorkspace(), costs: { 'okx:BTC': { 'not-an-account': { averagePrice: 1, currency: 'USD', quantity: 1, feeIncluded: true, updatedAt: new Date().toISOString() } } } }, { accounts: [], holdings: [], contracts: [] }), '不是账户编号的内容仍要拒绝')

  // 4：上次被强制结束留下的写入锁，启动时清除后可以正常保存；维护锁不能被自动清除。
  {
    const folder = temp()
    mkdirSync(databaseWriterLockPath(folder), { recursive: true })
    assert.throws(() => withDatabaseWriter(folder, () => 1), /仍在进行/, '残留写入锁会挡住保存')
    assert.equal(clearStaleWriterLock(folder), true)
    assert.equal(withDatabaseWriter(folder, () => 7), 7, '清除后可以保存')
    assert.equal(clearStaleWriterLock(folder), false, '没有残留时不做任何事')
    mkdirSync(databaseLockPath(folder), { recursive: true })
    clearStaleWriterLock(folder)
    assert.ok(existsSync(databaseLockPath(folder)), '维护锁需要人工核对，不能自动清除')
  }
  // 全新目录自动建资料库；有旧 JSON 资料的目录不自动迁移。
  {
    const fresh = temp(), legacy = temp()
    writeFileSync(join(legacy, 'workspace.json'), '{}')
    assert.equal(ensureDatabase(fresh), 'created')
    assert.equal(ensureDatabase(fresh), 'ready')
    assert.ok(getDatabase(fresh), '新建的资料库可以打开')
    assert.equal(ensureDatabase(legacy), 'legacy')
    assert.equal(existsSync(join(legacy, 'portfolio.sqlite')), false, '旧资料目录不能被自动建库')
    closeDatabase(fresh)
  }

  // 走势：长期保留。三年每分钟记录会超过 10 GB，所以旧点要逐级变稀；每天的日初日末点和 2 天内的全部点保留，价格依据同步清理。
  {
    const folder = temp()
    ensureDatabase(folder)
    const database = getDatabase(folder), nowSeconds = Math.floor(Date.now() / 1000) - 3600, day = 86400
    const insert = database.prepare('INSERT INTO equity_points(t, payload) VALUES (?, ?)')
    const price = database.prepare("INSERT INTO price_observations(key, at, currency, basis, price) VALUES ('BTC', ?, 'USD', 'equity', '1')")
    const times = []
    // 从 800 天前到现在，每 10 分钟一个点；3 天以前再加每个北京日的 00:00:30 和 23:58:00（最近 3 天不加，避免与整点贴得太近被当作重复点）。
    for (let t = nowSeconds - 800 * day; t <= nowSeconds; t += 600) times.push(t)
    for (let d = nowSeconds - 800 * day; d <= nowSeconds - 3 * day; d += day) { const midnight = Math.floor((d + 8 * 3600) / day) * day - 8 * 3600; times.push(midnight + 30, midnight + 86280) }
    const unique = [...new Set(times.filter(t => t <= nowSeconds))].sort((a, b) => a - b)
    database.exec('BEGIN')
    for (const t of unique) { insert.run(t, JSON.stringify({ t })); price.run(t * 1000) }
    database.exec('COMMIT')
    const removed = compactHistory(database, nowSeconds, true)
    const left = database.prepare('SELECT t FROM equity_points ORDER BY t').all().map(row => row.t)
    assert.ok(removed > 0 && left.length < unique.length / 5, `旧点应大幅变稀：${unique.length} → ${left.length}`)
    assert.equal(left[0], unique[0], '最早的历史点永远保留')
    const keptSet = new Set(left)
    assert.ok(unique.filter(t => t >= nowSeconds - 2 * day && (nowSeconds - t) % 600 === 0).every(t => keptSet.has(t)), '最近 2 天正常间隔的点一个不少')
    const oldDays = new Map()
    for (const t of left.filter(t => t < nowSeconds - 36 * day)) oldDays.set(Math.floor((t + 8 * 3600) / day), (oldDays.get(Math.floor((t + 8 * 3600) / day)) ?? 0) + 1)
    assert.ok(Math.max(...oldDays.values()) <= 4, '35 天以前每天最多保留日初、日末和一个整理点')
    assert.ok(left.length < 5000, `三年量级也只有几千个点：${left.length}`)
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM price_observations WHERE basis = 'equity'").get().n, left.length, '价格依据与保留的点一一对应')
    assert.equal(compactHistory(database, nowSeconds, true), 0, '重复整理不再删除')
    // 系统时钟回拨：比已有记录更早的点不写入。
    const point = t => ({ t, net: 100, gross: 100, rows: [], prices: [], contracts: [], accounts: [] })
    const latest = left.at(-1)
    await saveEquityPoint(folder, point(latest - 3601))
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM equity_points WHERE t = ?').get(latest - 3601).n, 0, '时钟回拨的点被忽略')
    closeDatabase(folder)
  }
  // 交易记录同步卡住时，余额、行情等其他更新照常运行。
  {
    const calls = []
    let release
    const hold = new Promise(resolve => { release = resolve })
    const live = { connections: [{ id: 'ex', type: 'binance', name: '币安' }], snapshot: { accounts: [], holdings: [], contracts: [] } }
    const connections = { list: () => live, sync: async () => { calls.push('sync') }, refreshMarket: async () => { calls.push('market') }, listTransactions: () => ({ records: [], syncs: [] }), syncTransactions: () => { calls.push('tx'); return hold } }
    const scheduler = startScheduler({ folder: temp(), store: { inspect: () => ({ data: null, error: '损坏' }) }, connections, fx, cnQuotes, tickMs: 3600000 })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.ok(calls.includes('tx') && calls.includes('market') && calls.includes('sync'), '交易同步还没结束时，账户和行情更新已经完成')
    release({ syncs: [] })
    await new Promise(resolve => setTimeout(resolve, 20))
    scheduler.stop()
  }

  // 大响应压缩，小响应保持原样；失败的请求写入日志但不带请求内容。
  {
    const folder = temp()
    writeFileSync(join(folder, 'equity-history.json'), JSON.stringify({ points: Array.from({ length: 600 }, (_, i) => ({ t: 1_700_000_000 + i * 60, net: 100, gross: 100, rows: [], prices: [], contracts: [], accounts: [] })) }))
    const api = createWorkspaceApi(folder)
    const server = http.createServer((request, response) => api(request, response))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`, headers = { 'x-investment-app': '1' }
    const plain = await fetch(base + '/api/equity-history', { headers: { ...headers, 'accept-encoding': 'identity' } })
    const rawSize = (await plain.arrayBuffer()).byteLength
    const packed = await new Promise(resolve => http.get(base + '/api/equity-history', { headers: { ...headers, 'accept-encoding': 'gzip' } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ encoding: response.headers['content-encoding'], body: Buffer.concat(chunks) })) }))
    assert.equal(packed.encoding, 'gzip')
    assert.ok(packed.body.length < rawSize / 3, `压缩后应明显变小：${rawSize} → ${packed.body.length}`)
    assert.equal(JSON.parse(gunzipSync(packed.body).toString()).points.length, 600, '解压后内容完整')
    const small = await fetch(base + '/api/forex', { headers })
    assert.equal(small.headers.get('content-encoding'), null, '小响应不压缩')
    await new Promise(resolve => server.close(resolve))
  }
  console.log('稳定性检查通过：定时任务容错与日志、无手动资料时记录走势、账户编号校验、残留写入锁清除、新目录建库、走势长期保留、交易同步不阻塞、响应压缩。')
} finally {
  console.error = originalError
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
}

// 用户另行同意后再运行；仅使用假汇率、假时钟和临时目录，不联网或读取真实账户。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createForexService, parseFxQuote } from '../server/forex.mjs'
import { FX_HOUR, forex, fxNote, refreshForex, startForexUpdates, toUsd, validFxQuote } from '../src/data/forex.ts'
import { assetValueCents, assertWorkspacePortfolio, formatMoney, formatNativePrice, holdings, holdingCostSummary, liabilityValueCents, personalBalance, refreshPortfolio, totalValueCents } from '../src/data/portfolio.ts'
import { workspace } from '../src/data/workspace.ts'
import { buildEquitySample } from '../src/data/equity-history.ts'
import { createWorkspaceStore } from '../server/workspace-store.mjs'

let clock = Date.parse('2026-10-24T04:00:00Z')
const reply = (rate = 7) => ({ result: 'success', base: 'USD', rates: { CNY: rate }, sources: { CNY: 'live' }, market_session: 'open', timestamp: new Date(clock).toISOString(), effective_at: { CNY: new Date(clock - 900000).toISOString() }, stale: { CNY: false } })
const quote = parseFxQuote(reply(), clock)
assert.equal(quote.rate, 7)
assert.equal(quote.quotedAt, clock - 900000, '使用真实报价时间，而不是本次请求时间')
assert.equal(validFxQuote(quote, clock), true)
for (const rate of [0, -1, '7', NaN, Infinity, 101]) assert.throws(() => parseFxQuote(reply(rate), clock))
assert.throws(() => parseFxQuote({ ...reply(), base: 'EUR' }, clock))
assert.throws(() => parseFxQuote({ ...reply(), stale: { CNY: true } }, clock))
assert.throws(() => parseFxQuote({ ...reply(), effective_at: { CNY: new Date(clock + FX_HOUR).toISOString() } }, clock))
assert.throws(() => parseFxQuote({ ...reply(), effective_at: { CNY: new Date(clock - 7 * FX_HOUR).toISOString() } }, clock))
const weekend = { ...reply(), market_session: 'weekend', effective_at: { CNY: new Date(clock - 2 * 86400000).toISOString() } }
assert.equal(parseFxQuote(weekend, clock).session, 'weekend')
assert.equal(parseFxQuote({ ...weekend, sources: { CNY: 'ecb_daily' } }, clock).kind, 'ecb_daily')

const folder = mkdtempSync(join(tmpdir(), 'investment-fx-check-'))
try {
  let calls = 0, fail = false
  const dependencies = { now: () => clock, requestJson: async url => {
    calls++; assert.equal(url, 'https://api.exchangerate.dev/v1/latest/USD?symbols=CNY')
    if (fail) throw new Error('假断网')
    return reply()
  } }
  const service = createForexService(folder, dependencies)
  assert.equal(service.list().quote, null)
  const [first, same] = await Promise.all([service.refresh(), service.refresh()])
  assert.deepEqual(first, same); assert.equal(calls, 1)
  assert.equal(statSync(join(folder, 'forex-cache.json')).mode & 0o777, 0o600)
  clock += FX_HOUR - 1
  await service.refresh(); assert.equal(calls, 1)
  await createForexService(folder, dependencies).refresh(); assert.equal(calls, 1, '重启后共用本机一小时缓存')
  clock++
  fail = true
  const before = readFileSync(join(folder, 'forex-cache.json'), 'utf8')
  const failed = await service.refresh()
  assert.ok(failed.error)
  assert.deepEqual(failed.quote, first.quote)
  assert.equal(readFileSync(join(folder, 'forex-cache.json'), 'utf8'), before, '断网不能覆盖成功缓存')
  await service.refresh(); assert.equal(calls, 2, '失败不能立即反复请求')
  clock += FX_HOUR; fail = false
  assert.equal((await service.refresh()).error, '')
  const oldWorkspace = structuredClone(workspace), oldQuote = forex.quote, oldError = forex.error
  const stamp = new Date(clock).toISOString()
  const original = { manualAssets: [{ id: 'manual-house', name: '假房子', symbol: 'HOUSE', market: 'other', accountId: 'manual', quantity: 1, price: 700000, currency: 'CNY', icon: '', updatedAt: stamp }], liabilities: [{ id: 'liability-home', name: '假房贷', kind: '房贷', amount: 350000, currency: 'CNY', settled: false, note: '', updatedAt: stamp }], customizations: {}, snapshots: [], changes: [] }
  const serialized = JSON.stringify(original)
  try {
    Object.assign(workspace, original)
    forex.quote = null; forex.error = ''
    refreshPortfolio()
    assert.equal(toUsd(70, 'CNY'), null)
    assert.equal(toUsd(0, 'CNY'), 0)
    assert.equal(toUsd(70, 'USD'), 70)
    assert.equal(holdings[0].usdPrice, null)
    assert.equal(holdings[0].fxPending, true)
    assert.equal(liabilityValueCents(original.liabilities[0]), null)
    assert.equal(totalValueCents, null, '未知汇率的房贷和房产不能按零统计净值')
    assert.equal(personalBalance().grossCents, null, '未换算的房产不能按零展示总资产')
    assert.equal(formatMoney(null, 'USD'), '汇率待获取')
    assert.equal(formatMoney(100, 'CNY'), '汇率待获取')
    assert.equal(formatMoney(100, 'CNY', true), '••••••')
    assert.equal(formatNativePrice(70, 'CNY', 'CNY'), '¥70.00', '原币金额不依赖汇率')
    assert.equal(buildEquitySample(Math.floor(clock / 1000)), null, '不保存人民币换算不完整的历史')
    assert.doesNotThrow(() => assertWorkspacePortfolio(original))
    const store = createWorkspaceStore(join(folder, 'workspace'))
    store.save(original, null)
    assert.equal(store.inspect().error, undefined, '汇率缺失不能导致人工资料被误报损坏')

    forex.quote = parseFxQuote(reply(7), clock)
    refreshPortfolio()
    assert.equal(assetValueCents, 10000000)
    assert.equal(personalBalance().liabilitiesCents, 5000000)
    assert.equal(totalValueCents, 5000000)
    assert.equal(formatMoney(10000, 'CNY'), '¥700.00')
    const sample = buildEquitySample(Math.floor(clock / 1000))
    assert.equal(sample.net, 5000000)
    forex.quote = parseFxQuote(reply(8), clock)
    refreshPortfolio()
    assert.equal(assetValueCents, 8750000)
    assert.equal(totalValueCents, 4375000)
    assert.equal(sample.net, 5000000, '新汇率不改写原历史样本')
    assert.equal(JSON.stringify(original), serialized, '原始人民币输入保持原样')
    const costs = { ...original, costs: { 'manual-house': { manual: { averagePrice: 350000, currency: 'CNY', quantity: 1, feeIncluded: false, updatedAt: stamp } } } }
    assert.equal(holdingCostSummary(holdings[0], costs).costCents, 4375000)
    forex.quote = null
    assert.equal(holdingCostSummary(holdings[0], costs).pendingFx, true)
    assert.equal(holdingCostSummary(holdings[0], costs).missingCount, 0, '汇率未知不冒充用户未填成本')

    const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalDocument = globalThis.document, originalNow = Date.now
    const timers = new Map(), listeners = new Map()
    let nextId = 0, requests = 0
    try {
      Date.now = () => clock
      forex.quote = { ...parseFxQuote(reply(), clock), quotedAt: clock - 2700000, fetchedAt: clock - 1800000 }
      globalThis.window = { setTimeout: (work, ms) => { const id = ++nextId; timers.set(id, { work, ms }); return id }, clearTimeout: id => timers.delete(id), dispatchEvent: () => true }
      globalThis.document = { visibilityState: 'visible', addEventListener: (name, work) => listeners.set(name, work), removeEventListener: name => listeners.delete(name) }
      globalThis.fetch = async path => { requests++; assert.equal(path, '/api/forex/refresh'); return new Response(JSON.stringify({ quote: parseFxQuote(reply(), clock), error: '' })) }
      const stop = startForexUpdates()
      assert.equal(requests, 0)
      const [id, scheduled] = [...timers][0]
      assert.equal(scheduled.ms, 1800000, '缓存已有半小时，只等剩余半小时')
      clock += 1800000; timers.delete(id); scheduled.work()
      await refreshForex()
      assert.equal(requests, 1)
      assert.equal([...timers.values()][0].ms, FX_HOUR)
      listeners.get('visibilitychange')()
      assert.equal(requests, 1, '切回页面仍在一小时内不重复查')
      stop(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0)
      assert.ok(fxNote().includes('15分钟'))
    } finally {
      globalThis.fetch = originalFetch; Date.now = originalNow
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else globalThis.window = originalWindow
      if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = originalDocument
    }
  } finally {
    for (const key of Object.keys(workspace)) delete workspace[key]
    Object.assign(workspace, oldWorkspace); forex.quote = oldQuote; forex.error = oldError; refreshPortfolio()
  }
} finally { rmSync(folder, { recursive: true, force: true }) }
console.log('汇率隔离检查通过：币种与时间校验、一小时缓存、失败保留、人民币估值／成本／负债及历史保护。')

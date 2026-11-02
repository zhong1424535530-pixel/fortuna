// 用户另行同意后再运行：只使用临时文件、假时钟、假账户及内存密钥，不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectionService } from '../server/connection-service.mjs'
import { syncTransactions, transactionState, transactionError, loadTransactions } from '../src/data/transaction-client.ts'
import { holding } from '../server/connection-http.mjs'
import { connectionRefreshMs } from '../src/data/live-types.ts'
import { initializeLiveData, liveState, refreshAccountData, refreshTransactionData, startLiveUpdates, syncConnection, removeConnection } from '../src/data/live.ts'

assert.equal(connectionRefreshMs('binance'), 60000)
assert.equal(connectionRefreshMs('bybit'), 60000)
assert.equal(connectionRefreshMs('wallet'), 300000)
const folder = mkdtempSync(join(tmpdir(), 'investment-auto-refresh-'))
let clock = Date.parse('2026-10-21T04:00:00Z'), exchangeReads = 0, walletReads = 0, fail = false
let releaseRead, enterRead, gate
const secrets = new Map()
const dependencies = {
  now: () => clock,
  dailyPrices: async parts => parts,
  vault: { get: async id => secrets.get(id), set: async (id, value) => secrets.set(id, value), remove: async id => secrets.delete(id) },
  readers: {
    binance: async connection => {
      exchangeReads++
      if (gate) { enterRead(); await gate }
      if (fail) throw new Error('假断网')
      const account = { id: 'live-' + connection.id + '-spot', sourceId: 'live-' + connection.id, name: connection.name, kind: '交易所', status: 'ok', updatedAt: new Date(clock).toISOString(), warning: '', icon: '', color: '#91ad9c', pnlCents: 100 }
      return [{ account, holdings: [holding('binance:BTC', account.id, 'BTC', '比特币', String(exchangeReads), '60000', '假余额')], contracts: [{ id: 'test-contract', accountId: account.id, symbol: 'BTCUSDT', name: 'BTCUSDT', icon: '', direction: '做多', quantity: exchangeReads, baseAsset: 'BTC', entryPriceUsd: 60000, markPriceUsd: 61000, leverage: 2, marginMode: '全仓', marginCents: 3000000, liquidationPriceUsd: null, unrealizedPnlCents: 100 }] }]
    },
    wallet: async connection => {
      walletReads++
      const account = { id: 'live-' + connection.id + '-eth', sourceId: 'live-' + connection.id, name: connection.name, kind: '钱包', status: 'ok', updatedAt: new Date(clock).toISOString(), warning: '', icon: '', color: '#91ad9c', pnlCents: 0 }
      const assets = [holding('evm:1:native', account.id, 'ETH', 'ETH', String(walletReads), '2000', '假钱包')]
      if (walletReads > 1) assets.push(holding('evm:1:0x' + '1'.repeat(40), account.id, 'NEW', '新代币', '2', '1', '假钱包'))
      return [{ account, holdings: assets, contracts: [] }]
    },
  },
}
let state, exchangeId, walletId
try {
  const service = createConnectionService(folder, dependencies)
  state = await service.upsert({ type: 'binance', name: '假币安', apiKey: 'a'.repeat(32), apiSecret: 'b'.repeat(32) })
  exchangeId = state.connections[0].id
  state = await service.upsert({ type: 'wallet', name: '假钱包', address: '0x' + '2'.repeat(40), chains: ['eth'], walletFamily: 'evm', provider: 'rpc' })
  walletId = state.connections.find(item => item.type === 'wallet').id
  clock += 59999
  await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, 1)
  clock++
  state = await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, 2)
  assert.equal(state.snapshot.contracts[0].quantity, 2)
  await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, 2, '其他页面不能重复查')
  clock += 239999
  await service.sync(walletId, false, true)
  assert.equal(walletReads, 1)
  clock++
  state = await service.sync(walletId, false, true)
  assert.equal(walletReads, 2)
  assert.ok(state.snapshot.holdings.some(asset => asset.symbol === 'NEW'), '五分钟扫描能发现新币')
  const restarted = createConnectionService(folder, dependencies)
  await restarted.sync(walletId, false, true)
  assert.equal(walletReads, 2, '服务重开也参考保存的余额时间')

  fail = true
  const before = structuredClone(service.list().snapshot)
  state = await service.sync(exchangeId, false, true)
  const failedReads = exchangeReads
  assert.equal(state.connections.find(item => item.id === exchangeId).status, 'error')
  // sync 会把该来源的持仓移到末尾，页面按市值排序，只比内容不比顺序。
  const byId = list => [...list].sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(byId(state.snapshot.holdings), byId(before.holdings), '失败不能清空余额')
  assert.deepEqual(state.snapshot.contracts, before.contracts, '失败不能清空合约')
  clock += 119999
  await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, failedReads, '失败后延长到两分钟')
  clock++
  await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, failedReads + 1)
  clock += 10000
  fail = false
  await service.sync(exchangeId)
  assert.equal(exchangeReads, failedReads + 2, '手动刷新不受自动退让限制')
  clock += 60000
  await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, failedReads + 3, '恢复成功后回到一分钟')

  clock += 60000
  const entered = new Promise(resolve => { enterRead = resolve })
  gate = new Promise(resolve => { releaseRead = resolve })
  const first = service.sync(exchangeId, false, true)
  await entered
  const activeReads = exchangeReads
  await service.sync(exchangeId, false, true)
  assert.equal(exchangeReads, activeReads, '上轮未完成不叠加')
  releaseRead(); await first; gate = undefined
  state = service.list()

  const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalDocument = globalThis.document, originalNow = Date.now
  const intervals = new Map(), listeners = new Map(), events = [], eventTypes = []
  let browserState = structuredClone(state), browserExchangeReads = 0, browserWalletReads = 0
  let browserTransactions = { records: [], syncs: [] }, failTransactions = false, transactionGate, enterTransaction, localReadGate, enterLocalRead
  const transactionReads = new Map()
  const startingAt = clock
  browserState.connections = browserState.connections.map(connection => ({ ...connection, updatedAt: new Date(clock).toISOString() }))
  try {
    Date.now = () => clock
    globalThis.window = {
      dispatchEvent: event => { events.push(event.detail); eventTypes.push(event.type); return true },
      setInterval: (callback, ms) => { intervals.set(ms, callback); return ms },
      clearInterval: id => intervals.delete(id),
    }
    globalThis.document = { visibilityState: 'visible', addEventListener: (name, work) => listeners.set(name, work), removeEventListener: name => listeners.delete(name) }
    globalThis.fetch = async url => {
      const path = String(url)
      assert.ok(path.startsWith('/api/'), '禁止外部网络')
      if (path === '/api/transactions') {
        const snapshot = structuredClone(browserTransactions)
        if (localReadGate) { enterLocalRead(); await localReadGate }
        return new Response(JSON.stringify(snapshot))
      }
      if (path === '/api/connections/' + exchangeId) {
        browserState = { ...browserState, connections: browserState.connections.filter(item => item.id !== exchangeId), snapshot: { accounts: [], holdings: [], contracts: [] } }
        return new Response(JSON.stringify(browserState))
      }
      if (path.startsWith('/api/transactions/')) {
        const connection = browserState.connections.find(item => path === '/api/transactions/' + item.id + '/sync')
        assert.ok(connection, '只读现有来源的交易记录')
        transactionReads.set(connection.id, (transactionReads.get(connection.id) ?? 0) + 1)
        if (transactionGate) { enterTransaction(); await transactionGate }
        if (failTransactions) throw new Error('交易记录假断网')
        const scope = { connectionId: connection.id, connectionName: connection.name, identity: 'fake', key: 'test', label: '模拟读取', status: 'ok', from: clock - 7 * 86400000, to: clock, at: clock, lastSuccess: clock, warning: '' }
        browserTransactions = { ...browserTransactions, syncs: [...browserTransactions.syncs.filter(item => item.connectionId !== connection.id), scope] }
        return new Response(JSON.stringify(browserTransactions))
      }
      if (path.startsWith('/api/connections/') && path.endsWith('/sync')) {
        browserState = { ...browserState, connections: browserState.connections.map(connection => path.includes(connection.id) ? { ...connection, updatedAt: new Date(clock).toISOString() } : connection) }
        return new Response(JSON.stringify(browserState))
      }
      if (path.includes('/sync?automatic=1')) {
        if (path.includes(exchangeId)) browserExchangeReads++
        else if (path.includes(walletId)) browserWalletReads++
        else assert.fail('未知账户')
        browserState = { ...browserState, connections: browserState.connections.map(connection => path.includes(connection.id) ? { ...connection, updatedAt: new Date(clock).toISOString() } : connection) }
      } else assert.ok(['/api/connections', '/api/market/refresh'].includes(path))
      return new Response(JSON.stringify(browserState))
    }
    await initializeLiveData()
    const stop = startLiveUpdates()
    await refreshAccountData()
    await refreshTransactionData()
    assert.equal(transactionReads.get(exchangeId), 1, '启动时无需交易页按钮就读取记录')
    assert.equal(transactionReads.get(walletId), 1)
    await refreshTransactionData()
    assert.equal(transactionReads.get(exchangeId), 1, '不到期不反复读取7天历史')
    assert.deepEqual([...intervals.keys()].sort((a, b) => a - b), [15000, 60000])
    clock = startingAt + 59999
    await refreshAccountData()
    assert.equal(browserExchangeReads, 0)
    clock++
    await Promise.all([refreshAccountData(), refreshAccountData()])
    assert.equal(browserExchangeReads, 1)
    assert.equal(browserWalletReads, 0)
    clock = startingAt + 300000
    await refreshAccountData()
    assert.equal(browserWalletReads, 1)
    await refreshTransactionData()
    assert.equal(transactionReads.get(exchangeId), 2, '币安交易记录五分钟更新')
    assert.equal(transactionReads.get(walletId), 1, '钱包十五分钟更新，余额刷新不会重复扫流水')
    assert.equal(liveState.connections.find(item => item.id === walletId).updatedAt, new Date(clock).toISOString())
    assert.ok(events.includes('balances'))
    assert.equal(events.includes('connection'), false, '自动更新不冒充手动操作或弹成功提示')
    clock += 60000
    listeners.get('visibilitychange')()
    await refreshAccountData()
    assert.equal(browserExchangeReads, 3, '切回页面补查到期账户')
    await refreshTransactionData()
    const transactionCount = transactionReads.get(exchangeId)
    await syncConnection(exchangeId)
    assert.equal(transactionReads.get(exchangeId), transactionCount + 1, '账户卡片刷新同时更新交易记录')
    assert.ok(eventTypes.includes('transaction-data-change'), '交易更新发出独立通知，页面无需切走再回来')

    let releaseTransaction
    const transactionStarted = new Promise(resolve => { enterTransaction = resolve })
    transactionGate = new Promise(resolve => { releaseTransaction = resolve })
    const running = syncTransactions(exchangeId, [])
    assert.equal(syncTransactions(exchangeId, []), running, '同来源重复调用共用请求')
    await transactionStarted
    const inFlightCount = transactionReads.get(exchangeId)
    const manual = syncConnection(exchangeId)
    const otherWalletReads = browserWalletReads, ownBalanceReads = browserExchangeReads
    clock += 300000
    await refreshAccountData()
    assert.equal(browserExchangeReads, ownBalanceReads, '同来源交易读取中不并行读取余额')
    assert.equal(browserWalletReads, otherWalletReads + 1, '单个账户交易读取慢不挡住其他账户余额')
    releaseTransaction(); await running; await manual; transactionGate = undefined
    assert.equal(transactionReads.get(exchangeId), inFlightCount, '账户刷新复用刚完成的同来源流水，不立刻重复请求')

    let releaseLocalRead
    const localReadStarted = new Promise(resolve => { enterLocalRead = resolve })
    localReadGate = new Promise(resolve => { releaseLocalRead = resolve })
    const staleRead = loadTransactions()
    await localReadStarted
    clock++
    await syncTransactions(exchangeId, [])
    const latestTransactions = structuredClone(transactionState)
    releaseLocalRead(); await staleRead; localReadGate = undefined
    assert.deepEqual(transactionState, latestTransactions, '迟到的本机读取不能覆盖已收到的新交易记录')

    const savedTransactions = structuredClone(transactionState)
    failTransactions = true
    await assert.rejects(syncTransactions(exchangeId, []), /中断或超时/)
    assert.deepEqual(transactionState, savedTransactions, '失败保留已存交易记录')
    failTransactions = false
    await loadTransactions()
    assert.ok(transactionError)
    let releaseDeletedRead
    const deletedReadStarted = new Promise(resolve => { enterTransaction = resolve })
    transactionGate = new Promise(resolve => { releaseDeletedRead = resolve })
    failTransactions = true
    const lateFailure = syncTransactions(exchangeId, [])
    await deletedReadStarted
    await removeConnection(exchangeId)
    assert.equal(transactionError, '', '账户移除成功后不再残留它的旧交易读取错误')
    releaseDeletedRead(); await assert.rejects(lateFailure, /中断或超时/)
    transactionGate = undefined; failTransactions = false
    assert.equal(transactionError, '', '账户移除后，迟到的失败也不能重新写入旧错误')
    stop()
    assert.equal(intervals.size, 0)
    assert.equal(listeners.size, 0)
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else globalThis.window = originalWindow
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = originalDocument
  }
} finally { rmSync(folder, { recursive: true, force: true }) }
console.log('账户自动刷新隔离检查通过：一分钟／五分钟、新币与合约、失败保留、退让、防重复及清理。')

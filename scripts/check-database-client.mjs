// 用户另行同意后运行；内存假响应，不访问本机服务、文件或真实账户。
import assert from 'node:assert/strict'

const originalFetch = globalThis.fetch, originalWindow = globalThis.window
const id = '12345678-1234-1234-1234-123456789abc'
const row = { id: 'binance:test:usdm:reward:1', connectionId: id, connectionName: '模拟', identity: 'test', account: 'U本位', scope: 'usdm', asset: 'USDT', symbol: '', quoteAsset: '', quoteQuantity: null, price: null, fees: [], realizedPnl: null, pnlAsset: '', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: 'COMMISSION_REBATE', relatedTradeId: '', type: '奖励', quantity: '1', time: Date.now() - 1000 }
let release, enter, reads = 0, updated = false
const gate = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { enter = resolve })
globalThis.window = { dispatchEvent: () => true }
globalThis.fetch = async path => {
  assert(String(path).startsWith('/api/transactions'), '不允许外部请求')
  if (String(path).includes('/sync')) { updated = true; return new Response(JSON.stringify({ records: [], syncs: [], archive: true })) }
  reads++
  const before = { records: [row], syncs: [], archive: true, nextOffset: null, storeRevision: 'old' }
  if (reads === 2) { enter(); await gate; return new Response(JSON.stringify(before)) }
  return new Response(JSON.stringify(updated ? { ...before, records: [row, { ...row, id: row.id + ':2', quantity: '2' }], storeRevision: 'new' } : before))
}
try {
  const client = await import('../src/data/transaction-client.ts?database-race-check')
  await client.ensureTransactions()
  const loading = client.loadTransactions()
  await entered
  await client.syncTransactions(id, [])
  release()
  assert.equal((await loading).records.length, 2, '读取中发生同步后必须补读新版本，不能成功返回旧缓存')
  assert.equal(client.transactionState.records[1].quantity, '2')
  assert.equal(reads, 3, '同一读请求只在资料变化后重读一次')
  let firstRelease, firstReads = 0
  const firstGate = new Promise(resolve => { firstRelease = resolve })
  globalThis.fetch = async () => {
    firstReads++
    if (firstReads === 1) { await firstGate; return new Response(JSON.stringify({ records: [row], syncs: [], archive: true })) }
    return new Response(JSON.stringify({ records: [row, { ...row, id: row.id + ':2' }], syncs: [], archive: true, nextOffset: null, storeRevision: 'full' }))
  }
  const delayed = await import('../src/data/transaction-client.ts?database-first-page-race-check')
  const ensuring = delayed.ensureTransactions()
  await delayed.loadTransactions()
  firstRelease()
  assert.equal((await ensuring).records.length, 2, '迟到的首批响应不得覆盖完整缓存')
  assert.equal(delayed.transactionState.records.length, 2)
  console.log('资料库客户端同步交错检查通过（纯假响应）')
} finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }

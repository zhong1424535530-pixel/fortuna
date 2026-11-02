// 只用假服务、假时钟和临时目录，不联网、不碰本人资料。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScheduler } from '../server/scheduler.mjs'
import { emptyWorkspace } from '../src/data/workspace.ts'

const folder = mkdtempSync(join(tmpdir(), 'scheduler-check-'))
let clock = Date.now() - 3600000 // 保存会拒绝未来时间的走势点，假时钟从一小时前开始
const calls = []
const account = { id: 'manual-account-00000000-0000-4000-8000-000000000000', name: '固定资产', updatedAt: new Date(clock).toISOString() }
const workspace = { ...emptyWorkspace(), manualAccounts: [account], manualAssets: [{ id: 'manual-car', symbol: 'CAR', name: '车辆', market: 'other', accountId: account.id, quantity: 1, price: 6000, currency: 'USD', icon: '', updatedAt: account.updatedAt }] }
const live = { connections: [{ id: 'ex', type: 'binance', name: '币安' }, { id: 'wa', type: 'wallet', name: '钱包' }], snapshot: { accounts: [], holdings: [], contracts: [] } }
let syncs = [], failWallet = true
const connections = {
  list: () => live,
  sync: async (id, force, automatic) => { calls.push('sync:' + id + ':' + automatic) },
  refreshMarket: async () => { calls.push('market'); throw new Error('行情假失败不能挡住后续步骤') },
  listTransactions: () => ({ records: [], syncs }),
  syncTransactions: async id => {
    calls.push('tx:' + id)
    if (id === 'wa' && failWallet) throw new Error('假断网')
    syncs = [...syncs.filter(item => item.connectionId !== id), { connectionId: id, key: 'spot', status: 'ok', at: clock }]
    return { records: [], syncs }
  },
}
const scheduler = startScheduler({
  folder, store: { inspect: () => ({ data: workspace }) }, connections,
  fx: { refresh: async () => { calls.push('fx') }, list: () => ({ quote: null }) },
  cnQuotes: { read: async () => ({}) },
  tickMs: 3600000, now: () => clock,
})
const tick = async () => { calls.length = 0; await scheduler.tick() }
try {
  await new Promise(resolve => setTimeout(resolve, 50)) // 启动时立即跑的第一轮：币安成功、钱包失败
  const start = clock
  clock = start + 1000
  await tick()
  assert.deepEqual(calls.filter(call => call.startsWith('sync')), ['sync:ex:true', 'sync:wa:true'], '每轮检查全部账户，是否到期由服务自己判断')
  assert.ok(calls.includes('market') && calls.includes('fx'), '行情失败不影响汇率')
  assert.deepEqual(calls.filter(call => call.startsWith('tx')), [], '刚同步过不重复读')

  clock = start + 299000
  await tick()
  assert.deepEqual(calls.filter(call => call.startsWith('tx')), [], '不到5分钟不读币安')
  clock = start + 300000
  await tick()
  assert.deepEqual(calls.filter(call => call.startsWith('tx')), ['tx:ex'], '币安满5分钟再读；失败的钱包退让到30分钟')
  const pointsAt = () => JSON.parse(readFileSync(join(folder, 'equity-history.json'), 'utf8')).points.map(point => point.t)
  const before = pointsAt()
  clock = start + 315000
  await tick()
  assert.deepEqual(pointsAt(), before, '15秒后的下一轮不能把上一个走势点替换掉')
  failWallet = false
  clock = start + 1800000
  await tick()
  assert.ok(calls.includes('tx:wa'), '钱包退让期满后重试')

  const saved = JSON.parse(readFileSync(join(folder, 'equity-history.json'), 'utf8')).points
  assert.ok(saved.length >= 3, '网页没打开也逐分钟累积净资产走势点')
  assert.equal(saved.at(-1).net, 600000, '用网页同一套估值：车辆 6000 美元')
  console.log('服务端定时任务检查通过：账户、行情、汇率、交易记录和走势记录，网页关闭时照常更新。')
} finally {
  scheduler.stop()
  rmSync(folder, { recursive: true, force: true })
}

// 仅准备：本人另行同意模拟检查后，才可运行本脚本；全部资料都在新临时目录。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertDatabaseWritable, atomicDatabase, closeDatabase, createDatabase, databaseLockPath, databaseEnabledPath, databasePath, getDatabase, getDocument, inspectDatabase, observe, recordPrices, setDocument, withDatabaseWriter } from '../server/database.mjs'
import { migrateDatabase } from '../server/database-migration.mjs'
import { createTransactionStore } from '../server/transaction-store.mjs'

const folder = mkdtempSync(join(tmpdir(), 'investment-database-check-'))
const empty = { manualAssets: [], customizations: {}, snapshots: [], changes: [] }
const now = Date.now() - 1000
const row = { id: 'check:trade:1', connectionId: randomUUID(), connectionName: '隔离账户', identity: 'isolated', account: '现货', scope: 'spot:BTCUSDT', type: '买入', time: now, asset: 'BTC', quantity: '0.000000000000000000000000000000000001', symbol: 'BTCUSDT', quoteAsset: 'USDT', quoteQuantity: '0.000000000000000000000000000000000123', price: '123', fees: [], realizedPnl: null, pnlAsset: '', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: '', relatedTradeId: '' }
const envelope = { format: 'personal-investment-dashboard', version: 1, revision: randomUUID(), updatedAt: new Date(now).toISOString(), data: empty }
const point = { t: Math.floor(now / 1000), net: 123, gross: 123, rows: [], prices: [['BTC', 0.1]], contracts: [], accounts: [] }
let direct
try {
  const absent = join(folder, 'absent')
  assert.equal(getDatabase(absent), null)
  assert.equal(existsSync(absent), false, '未启用时不得创建目录或空库')
  const legacy = join(folder, 'legacy')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'workspace.json'), JSON.stringify(envelope))
  writeFileSync(join(legacy, 'connections.json'), JSON.stringify({ connections: [], snapshot: { accounts: [], holdings: [], contracts: [] } }))
  writeFileSync(join(legacy, 'transactions.json'), JSON.stringify({ records: [row], syncs: [] }))
  writeFileSync(join(legacy, 'equity-history.json'), JSON.stringify({ points: [point] }))
  mkdirSync(join(legacy, 'backups'))
  const backupId = `${now}-${randomUUID()}.json`
  writeFileSync(join(legacy, 'backups', backupId), JSON.stringify(envelope))
  mkdirSync(join(legacy, 'asset-icons'))
  writeFileSync(join(legacy, 'asset-icons', 'sample.png'), 'isolated-image-fixture')
  assert.throws(() => migrateDatabase(legacy), /--confirm/)
  assert.equal(existsSync(databasePath(legacy)), false)
  const result = migrateDatabase(legacy, { confirmed: true })
  assert.equal(result.transactions, 1)
  assert.equal(result.workspaceBackups, 1)
  assert.equal(readFileSync(join(result.backupPath, 'workspace.json'), 'utf8'), JSON.stringify(envelope))
  assert.equal(readFileSync(join(result.backupPath, 'asset-icons', 'sample.png'), 'utf8'), 'isolated-image-fixture')
  assert.equal(readFileSync(join(legacy, 'transactions.json'), 'utf8'), JSON.stringify({ records: [row], syncs: [] }), '原文件不得删除或修改')
  const migrated = getDatabase(legacy)
  assert.equal(inspectDatabase(migrated), true)
  assert.deepEqual(getDocument(migrated, 'workspace'), envelope)
  assert.deepEqual(JSON.parse(migrated.prepare('SELECT payload FROM transactions WHERE id=?').get(row.id).payload), row, '极小金额逐字保留')
  assert.deepEqual(JSON.parse(migrated.prepare('SELECT payload FROM equity_points WHERE t=?').get(point.t).payload), point)
  assert.throws(() => migrateDatabase(legacy, { confirmed: true }), /已经存在/)
  assert.equal(statSync(databasePath(legacy)).mode & 0o777, 0o600)
  assert.throws(() => atomicDatabase(migrated, () => { setDocument(migrated, 'rollback', 1); throw new Error('停止') }), /停止/)
  assert.equal(getDocument(migrated, 'rollback'), null)
  atomicDatabase(migrated, () => atomicDatabase(migrated, () => setDocument(migrated, 'nested', { exact: row.quantity })))
  assert.deepEqual(getDocument(migrated, 'nested'), { exact: row.quantity })
  assert.equal(observe(migrated, 'same', { value: '1' }, now), true)
  assert.equal(observe(migrated, 'same', { value: '1' }, now + 1), false)
  recordPrices(migrated, [{ key: 'BTC', price: row.quantity, at: now }])
  recordPrices(migrated, [{ key: 'BTC', price: row.quantity, at: now }])
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM price_observations WHERE key='BTC' AND currency='USDT'").get().n, 1)
  assert.equal(migrated.prepare("SELECT price FROM price_observations WHERE currency='USDT'").get().price, row.quantity)
  mkdirSync(databaseLockPath(legacy))
  assert.throws(() => assertDatabaseWritable(legacy), /迁移或恢复/)
  rmSync(databaseLockPath(legacy), { recursive: true })
  closeDatabase(legacy)
  assert.deepEqual(getDocument(getDatabase(legacy), 'workspace'), envelope, '关闭再打开后资料仍在')
  closeDatabase(legacy)

  const damaged = join(folder, 'damaged')
  mkdirSync(damaged)
  writeFileSync(join(damaged, 'equity-history.json'), JSON.stringify({ points: [point, { ...point, t: point.t - 1, gross: null }] }))
  assert.throws(() => migrateDatabase(damaged, { confirmed: true }), /无效/)
  assert.equal(existsSync(databasePath(damaged)), false, '无效条目不能被跳过后切换空库')
  assert.equal(existsSync(databaseLockPath(damaged)), false, '失败后释放维护锁')
  writeFileSync(join(damaged, 'equity-history.json'), 'null')
  assert.throws(() => migrateDatabase(damaged, { confirmed: true }), /无法读取/)
  writeFileSync(databasePath(damaged), 'broken-database')
  assert.throws(() => getDatabase(damaged), /无法读取/)
  assert.equal(readFileSync(databasePath(damaged), 'utf8'), 'broken-database')

  const large = join(folder, 'large')
  direct = createDatabase(databasePath(large))
  atomicDatabase(direct, () => {
    const insert = direct.prepare('INSERT INTO transactions(id,connection_id,identity,time,type,scope,asset,symbol,payload) VALUES (?,?,?,?,?,?,?,?,?)')
    for (let index = 0; index < 100001; index++) {
      const item = { ...row, id: `large:${index}` }
      insert.run(item.id, item.connectionId, item.identity, item.time, item.type, item.scope, item.asset, item.symbol, JSON.stringify(item))
    }
  })
  assert.equal(direct.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 100001, '资料库没有旧文件十万条总量上限')
  assert.equal(JSON.parse(direct.prepare("SELECT payload FROM transactions WHERE id='large:100000'").get().payload).quantity, row.quantity)
  direct.close(); direct = undefined
  const largeStore = createTransactionStore(large)
  assert.equal(largeStore.save([{ ...row, id: 'large:100000' }], []).records.length, 100001, '实际保存入口也允许超过十万条')
  assert.equal(largeStore.list({ limit: 1 }).records.length, 1, '按需查询不需要返回所有历史')
  assert(existsSync(databaseEnabledPath(large)), '启用状态必须落盘，重启后不能悄悄回旧JSON')
  const second = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', "import { getDatabase } from './server/database.mjs'; try { getDatabase(process.argv[1]); process.exitCode = 1 } catch(error) { if (!/另一项网页服务/.test(error.message)) process.exitCode = 2 }", large], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
  assert.equal(second.status, 0, '另一个进程不得打开同一正式资料库')
  closeDatabase(large)
  renameSync(databasePath(large), databasePath(large) + '.held')
  assert.throws(() => getDatabase(large), /资料库不见/, '清掉进程缓存后，持久标记仍阻止回旧JSON')
  renameSync(databasePath(large) + '.held', databasePath(large))
  withDatabaseWriter(large, () => assert.throws(() => largeStore.save([], []), /仍在进行/, '保存和维护共用独占写入锁'))
  console.log('隔离资料检查通过：显式迁移、原文件备份、失败保护、精度、维护锁、重复导入保护和十万条以上保存。未连接本人账户。')
} finally {
  direct?.close()
  for (const name of ['legacy', 'damaged', 'large']) closeDatabase(join(folder, name))
  rmSync(folder, { recursive: true, force: true })
}

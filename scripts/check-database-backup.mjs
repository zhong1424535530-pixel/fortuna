// 仅准备：本人另行同意模拟检查后才可运行；只使用新建临时目录，不接触本人资料。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { atomicDatabase, closeDatabase, createDatabase, databaseLockPath, databasePath, databaseWriterLockPath, getDatabase, setDocument, withDatabaseWriter } from '../server/database.mjs'
import { createDatabaseBackup } from '../server/database-backup.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'investment-backup-check-'))
const folder = join(root, 'database'), absent = join(root, 'absent')
const now = Date.now() - 1000, id = randomUUID(), exact = '0.000000000000000000000000000000000001'
const empty = { manualAssets: [], customizations: {}, snapshots: [], changes: [] }
const workspace = { format: 'personal-investment-dashboard', version: 1, revision: randomUUID(), updatedAt: new Date(now).toISOString(), data: empty }
const connections = { connections: [{ id, type: 'binance', name: '隔离账户', status: 'pending', updatedAt: null, warning: '', hasCredential: true }], snapshot: { accounts: [], holdings: [], contracts: [] } }
const transaction = { id: 'backup:trade:1', connectionId: id, connectionName: '隔离账户', identity: 'isolated', account: '现货', scope: 'spot:BTCUSDT', type: '买入', time: now, asset: 'BTC', quantity: exact, symbol: 'BTCUSDT', quoteAsset: 'USDT', quoteQuantity: exact, price: '1', fees: [{ asset: 'USDT', quantity: exact }], realizedPnl: null, pnlAsset: '', status: '已完成', orderId: '', txHash: '', network: '', address: '', note: '', relatedTradeId: '' }
const sync = { connectionId: id, connectionName: '隔离账户', identity: 'isolated', key: 'spot:BTCUSDT', label: '隔离进度', status: 'ok', from: now - 1000, to: now, at: now, lastSuccess: now, warning: '' }
const point = { t: Math.floor(now / 1000), net: 123, gross: 123, rows: [], prices: [['BTC', 0.1]], contracts: [], accounts: [] }
const originalIcon = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII='
let direct
try {
  const legacy = createDatabaseBackup(absent)
  assert.equal(existsSync(absent), false, '构造服务不得建立资料目录')
  assert.equal(legacy.status().mode, 'legacy')
  assert.equal(existsSync(absent), false, '读取未迁移状态不得建立空库')
  await assert.rejects(() => legacy.exportBackup(), /尚未迁移/)
  assert.equal(existsSync(absent), false)

  direct = createDatabase(databasePath(folder))
  atomicDatabase(direct, () => {
    setDocument(direct, 'workspace', workspace); setDocument(direct, 'connections', connections); setDocument(direct, 'transactions-revision', randomUUID())
    direct.prepare('INSERT INTO transactions(id,connection_id,identity,time,type,scope,asset,symbol,payload) VALUES (?,?,?,?,?,?,?,?,?)').run(transaction.id, id, transaction.identity, now, transaction.type, transaction.scope, transaction.asset, transaction.symbol, JSON.stringify(transaction))
    direct.prepare('INSERT INTO transaction_syncs(key,payload) VALUES (?,?)').run(id + ':' + sync.key, JSON.stringify(sync))
    direct.prepare('INSERT INTO equity_points(t,payload) VALUES (?,?)').run(point.t, JSON.stringify(point))
    direct.prepare('INSERT INTO observations(kind,at,payload) VALUES (?,?,?)').run('workspace', now, JSON.stringify(empty))
    direct.prepare('INSERT INTO observations(kind,at,payload) VALUES (?,?,?)').run('connections', now, JSON.stringify(connections))
    direct.prepare('INSERT INTO price_observations(key,at,currency,basis,price) VALUES (?,?,?,?,?)').run('BTC', now, 'USDT', 'current', exact)
    direct.prepare('INSERT INTO workspace_backups(id,created_at,payload) VALUES (?,?,?)').run(`${now}-${randomUUID()}.json`, now, JSON.stringify(workspace))
  })
  direct.close(); direct = null
  mkdirSync(join(folder, 'asset-icons'))
  writeFileSync(join(folder, 'asset-icons', 'isolated.png'), Buffer.from(originalIcon, 'base64'))
  const service = createDatabaseBackup(folder)
  const exported = await service.exportBackup()
  assert.equal(exported.tables.transactions[0].payload, JSON.stringify(transaction), '所有原币金额逐字保留')
  assert.equal(exported.tables.price_observations[0].price, exact)
  assert.equal(exported.icons[0].data, originalIcon)
  assert.deepEqual(exported.tables, (await service.exportBackup()).tables, '导出完整覆盖所有业务表')
  const before = service.status()
  const future = structuredClone(exported); future.version = 2
  assert.throws(() => service.previewBackup(future), /第1版/)
  const malicious = structuredClone(exported); malicious.icons[0].name = '../outside.png'
  await assert.rejects(() => service.restoreBackup(malicious, before.revision), /图标/)
  const secret = structuredClone(exported)
  const connectionRow = secret.tables.documents.find(row => row.key === 'connections')
  const secretState = JSON.parse(connectionRow.payload); secretState.connections[0].apiKey = 'must-not-leave-keychain'; connectionRow.payload = JSON.stringify(secretState)
  assert.throws(() => service.previewBackup(secret), /密钥/)
  const broken = structuredClone(exported); broken.tables.transactions[0].time++
  await assert.rejects(() => service.restoreBackup(broken, before.revision), /不一致/)
  assert.deepEqual((await service.exportBackup()).tables, exported.tables, '坏备份不得修改原库')
  const preview = service.previewBackup(exported)
  withDatabaseWriter(folder, () => setDocument(getDatabase(folder), 'transactions-revision', randomUUID()))
  await assert.rejects(() => service.restoreBackup(exported, preview.revision), /重新预览/)
  const revision = service.previewBackup(exported).revision
  const restored = await service.restoreBackup(exported, revision)
  assert.equal(restored.restored, true)
  assert.deepEqual((await service.exportBackup()).tables, exported.tables, '恢复后所有表和金额完整一致')
  assert.equal(readFileSync(join(folder, 'asset-icons', 'isolated.png')).toString('base64'), originalIcon)
  assert.equal(readdirSync(join(folder, 'database-backups')).length, 1, '导入前只保留一份保护备份')
  const second = await service.restoreBackup(exported, service.previewBackup(exported).revision)
  assert.equal(second.restored, true)
  assert.equal(readdirSync(join(folder, 'database-backups')).length, 1, '再次导入后仍只留最新一份')
  assert.equal(service.status().backups, undefined)
  assert.equal(existsSync(databaseLockPath(folder)), false)
  assert.equal(existsSync(databaseWriterLockPath(folder)), false)
  const busy = createDatabaseBackup(folder, { isBusy: () => true })
  await assert.rejects(() => busy.restoreBackup(exported, service.previewBackup(exported).revision), /正在读取/)
  assert.equal(existsSync(databaseLockPath(folder)), false)
  mkdirSync(databaseWriterLockPath(folder))
  await assert.rejects(() => service.exportBackup(), /正在保存/)
  assert.equal(existsSync(databaseLockPath(folder)), false, '获取写入锁失败要释放自己持有的维护锁')
  rmSync(databaseWriterLockPath(folder), { recursive: true })
  const linkedIcon = join(folder, 'asset-icons', 'linked.png')
  symlinkSync(join(folder, 'asset-icons', 'isolated.png'), linkedIcon)
  await assert.rejects(() => service.exportBackup(), /链接/)
  rmSync(linkedIcon)
  closeDatabase(folder)
  renameSync(databasePath(folder), databasePath(folder) + '.held')
  assert.throws(() => service.status(), /资料库不见/, '已启用的库缺失不得误报未迁移')
  renameSync(databasePath(folder) + '.held', databasePath(folder))
  console.log('完整备份隔离检查通过：所有业务表、精度、图标、预览、恢复、版本、秘密字段、危险路径、维护锁、冲突保护与导入前只留一份保护备份。')
} finally {
  direct?.close(); closeDatabase(folder)
  rmSync(root, { recursive: true, force: true })
}

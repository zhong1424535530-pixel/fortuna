import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { validateWorkspace } from '../src/data/workspace-schema.ts'
import { assertWorkspacePortfolio } from '../src/data/portfolio.ts'
import { emptyTransactions, validTransactionState } from '../src/data/transactions.ts'
import { validEquityPoint } from '../src/data/equity-history.ts'
import { validateState } from './connection-service.mjs'
import { atomicDatabase, createDatabase, databaseLockPath, databaseWriterLockPath, databasePath, databaseEnabledPath, getDocument, inspectDatabase, observe, recordPrices, setDocument } from './database.mjs'

const sourceNames = ['workspace.json', 'connections.json', 'transactions.json', 'equity-history.json', 'backups', 'asset-icons']
const sha = contents => createHash('sha256').update(contents).digest('hex')

function sourceManifest(folder) {
  const entries = []
  function visit(relative) {
    const path = join(folder, relative)
    let stat
    try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error(`旧资料包含不支持的链接或特殊文件：${relative}。`)
    if (stat.isDirectory()) {
      entries.push([relative, 'directory'])
      for (const name of readdirSync(path).sort()) visit(join(relative, name))
    } else entries.push([relative, sha(readFileSync(path))])
  }
  for (const name of sourceNames) visit(name)
  return entries
}

function readJson(folder, name) {
  const path = join(folder, name)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  }
  catch { throw new Error(`${name} 无法读取，迁移已停止，原文件保留。`) }
}

function validateWorkspaceFile(value) {
  if (!value || value.format !== 'personal-investment-dashboard' || value.version !== 1 || typeof value.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(value.revision) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || !validateWorkspace(value.data)) throw new Error('workspace.json 格式不完整，迁移已停止。')
  // 这里只校验；迁移不能顺手清除旧示例或改写原始金额。
  assertWorkspacePortfolio(value.data)
  return value
}

function copyManifest(folder, destination, manifest) {
  mkdirSync(destination, { mode: 0o700 })
  for (const [relative, signature] of manifest) {
    const target = join(destination, relative)
    if (signature === 'directory') mkdirSync(target, { recursive: true, mode: 0o700 })
    else {
      copyFileSync(join(folder, relative), target)
      chmodSync(target, 0o600)
      const fd = openSync(target, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      if (sha(readFileSync(target)) !== signature) throw new Error('迁移前备份核对失败，原文件保留。')
    }
  }
}

function verifyRows(db, table, keyColumn, rows) {
  if (Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) !== rows.length) throw new Error(`${table} 条数不一致，迁移已停止。`)
  const select = db.prepare(`SELECT payload FROM ${table} WHERE ${keyColumn}=?`)
  for (const [key, value] of rows) if (select.get(key)?.payload !== JSON.stringify(value)) throw new Error(`${table} 原始金额或内容不一致，迁移已停止。`)
}

export function migrateDatabase(folder, { confirmed = false } = {}) {
  if (!confirmed) throw new Error('迁移需先停止网页服务，再使用 --confirm 明确执行。')
  if (existsSync(databasePath(folder))) throw new Error('正式资料库已经存在，本次未重复导入。')
  if (existsSync(databaseEnabledPath(folder))) throw new Error('此目录曾启用资料库，旧文件可能过时，请先恢复资料库，不能重新导入旧文件。')
  mkdirSync(folder, { recursive: true, mode: 0o700 }); chmodSync(folder, 0o700)
  const lock = databaseLockPath(folder)
  try { mkdirSync(lock, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('资料正在迁移或恢复，本次已停止。若上次意外关闭，请先核对资料和网页服务，再处理维护锁。'); throw error }
  const temporary = join(folder, `.portfolio-${randomUUID()}.sqlite`)
  let db, backupPath, writerLocked = false, marked = false
  try {
    try { mkdirSync(databaseWriterLockPath(folder), { mode: 0o700 }); writerLocked = true }
    catch { throw new Error('旧资料仍在保存，请等保存完成并停止网页服务后再迁移。') }
    if (existsSync(databasePath(folder))) throw new Error('正式资料库已经存在，本次未重复导入。')
    const manifest = sourceManifest(folder)
    const workspace = readJson(folder, 'workspace.json')
    if (workspace !== null) validateWorkspaceFile(workspace)
    const connections = readJson(folder, 'connections.json')
    if (connections !== null) validateState(connections)
    const transactionFile = join(folder, 'transactions.json')
    if (existsSync(transactionFile) && lstatSync(transactionFile).size > 48 * 1024 * 1024) throw new Error('transactions.json 超过旧文件允许大小，迁移已停止。')
    const transactions = readJson(folder, 'transactions.json') ?? emptyTransactions()
    if (!validTransactionState(transactions) || transactions.records.length > 100000) throw new Error('transactions.json 格式或旧记录数量不正确，迁移已停止。')
    const history = readJson(folder, 'equity-history.json') ?? { points: [] }
    if (!history || !Array.isArray(history.points) || history.points.some(point => !validEquityPoint(point)) || new Set(history.points.map(point => point.t)).size !== history.points.length) throw new Error('equity-history.json 含有无效或重复历史点，迁移已停止。')
    const oldBackups = []
    for (const [relative, kind] of manifest) {
      const match = /^backups\/(\d{13}-[0-9a-f-]{36}\.json)$/.exec(relative)
      if (!match || kind === 'directory') continue
      const value = validateWorkspaceFile(readJson(folder, relative))
      oldBackups.push([match[1], value])
    }
    if (JSON.stringify(sourceManifest(folder)) !== JSON.stringify(manifest)) throw new Error('读取期间旧资料发生变化，请停止网页服务后再迁移。')
    const backupRoot = join(folder, 'migration-backups')
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
    backupPath = join(backupRoot, `${Date.now()}-${randomUUID()}`)
    copyManifest(folder, backupPath, manifest)
    writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: manifest }), { flag: 'wx', mode: 0o600 })
    db = createDatabase(temporary)
    atomicDatabase(db, () => {
      if (workspace !== null) { setDocument(db, 'workspace', workspace); observe(db, 'workspace', workspace.data, Date.parse(workspace.updatedAt)) }
      if (connections !== null) { setDocument(db, 'connections', connections); observe(db, 'connections', connections) }
      const transaction = db.prepare('INSERT INTO transactions(id,connection_id,identity,time,type,scope,asset,symbol,payload) VALUES (?,?,?,?,?,?,?,?,?)')
      for (const row of transactions.records) {
        transaction.run(row.id, row.connectionId, row.identity, row.time, row.type, row.scope, row.asset, row.symbol, JSON.stringify(row))
        if (row.rewardValuation) recordPrices(db, [{ key: row.asset, price: row.rewardValuation.price, at: row.rewardValuation.at }], 'USDT', `reward:${row.rewardValuation.basis}`)
      }
      const sync = db.prepare('INSERT INTO transaction_syncs(key,payload) VALUES (?,?)')
      for (const item of transactions.syncs) sync.run(item.connectionId + ':' + item.key, JSON.stringify(item))
      const point = db.prepare('INSERT INTO equity_points(t,payload) VALUES (?,?)')
      for (const item of history.points) {
        point.run(item.t, JSON.stringify(item))
        recordPrices(db, item.prices.map(([key, price]) => ({ key, price, at: item.t * 1000 })), 'USD', 'equity')
      }
      const backup = db.prepare('INSERT INTO workspace_backups(id,created_at,payload) VALUES (?,?,?)')
      for (const [id, value] of oldBackups) backup.run(id, Number(id.slice(0, 13)), JSON.stringify(value))
      db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('legacy_migration', JSON.stringify({ at: Date.now(), backupPath, manifest }))
    })
    if (JSON.stringify(getDocument(db, 'workspace')) !== JSON.stringify(workspace) || JSON.stringify(getDocument(db, 'connections')) !== JSON.stringify(connections)) throw new Error('账户或人工资料核对失败，迁移已停止。')
    verifyRows(db, 'transactions', 'id', transactions.records.map(row => [row.id, row]))
    verifyRows(db, 'transaction_syncs', 'key', transactions.syncs.map(row => [row.connectionId + ':' + row.key, row]))
    verifyRows(db, 'equity_points', 't', history.points.map(row => [row.t, row]))
    verifyRows(db, 'workspace_backups', 'id', oldBackups)
    inspectDatabase(db)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); db = undefined
    const fd = openSync(temporary, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    if (JSON.stringify(sourceManifest(folder)) !== JSON.stringify(manifest)) throw new Error('备份期间旧资料发生变化，请停止网页服务后再迁移。')
    if (existsSync(databasePath(folder))) throw new Error('正式资料库已被其他操作创建，本次迁移已停止。')
    writeFileSync(databaseEnabledPath(folder), '1', { flag: 'wx', mode: 0o600 }); marked = true
    renameSync(temporary, databasePath(folder))
    const directory = openSync(folder, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
    return { databasePath: databasePath(folder), backupPath, transactions: transactions.records.length, syncs: transactions.syncs.length, equityPoints: history.points.length, workspaceBackups: oldBackups.length }
  } finally {
    db?.close()
    if (marked && !existsSync(databasePath(folder))) unlinkSync(databaseEnabledPath(folder))
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(temporary + suffix)) unlinkSync(temporary + suffix)
    if (writerLocked) rmdirSync(databaseWriterLockPath(folder))
    rmdirSync(lock)
  }
}

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { Decimal } from 'decimal.js'
import { ConnectionError } from './connection-http.mjs'

const databases = new Map()
const identities = new Map(), owners = new Set()
const structure = {
  metadata: ['key:TEXT:1', 'value:TEXT:0'],
  documents: ['key:TEXT:1', 'payload:TEXT:0'],
  transactions: ['id:TEXT:1', 'connection_id:TEXT:0', 'identity:TEXT:0', 'time:INTEGER:0', 'type:TEXT:0', 'scope:TEXT:0', 'asset:TEXT:0', 'symbol:TEXT:0', 'payload:TEXT:0'],
  transaction_syncs: ['key:TEXT:1', 'payload:TEXT:0'],
  equity_points: ['t:INTEGER:1', 'payload:TEXT:0'],
  observations: ['id:INTEGER:1', 'kind:TEXT:0', 'at:INTEGER:0', 'payload:TEXT:0'],
  price_observations: ['key:TEXT:1', 'at:INTEGER:2', 'currency:TEXT:3', 'basis:TEXT:4', 'price:TEXT:0'],
  workspace_backups: ['id:TEXT:1', 'created_at:INTEGER:0', 'payload:TEXT:0'],
}

export const databasePath = folder => join(folder, 'portfolio.sqlite')
export const databaseEnabledPath = folder => join(folder, 'database-enabled')
export const databaseLockPath = folder => join(folder, 'database-maintenance.lock')
export const databaseWriterLockPath = folder => join(folder, 'database-write.lock')
export function withDatabaseWriter(folder, work) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const path = databaseWriterLockPath(folder)
  try { mkdirSync(path, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') throw new ConnectionError('另一项资料保存或迁移仍在进行，请稍后重试。', 503); throw error }
  try {
    assertDatabaseWritable(folder)
    const result = work()
    if (result && typeof result.then === 'function') throw new Error('同步资料写入不能跨越异步操作。')
    return result
  } finally { rmdirSync(path) }
}
// 全新的资料目录直接建资料库（SQLite 单文件，无需另装数据库服务）；已有旧版 JSON 资料的目录保持原样，由人工确认后迁移，绝不自动导入。
// 返回 'created'（刚新建）、'ready'（资料库已存在）或 'legacy'（有旧 JSON 资料尚未迁移）。
export function ensureDatabase(folder) {
  if (existsSync(databasePath(folder)) || existsSync(databaseEnabledPath(folder))) return 'ready'
  if (['workspace.json', 'connections.json', 'transactions.json', 'equity-history.json'].some(name => existsSync(join(folder, name)))) return 'legacy'
  createDatabase(databasePath(folder)).close()
  return 'created'
}
// 启动时调用：服务刚启动，不可能有写入在进行，上次被强制结束留下的写入锁可以安全清除。
// 维护锁不清：它可能表示迁移或恢复中途失败，需要人工核对资料。
export function clearStaleWriterLock(folder) {
  const path = databaseWriterLockPath(folder)
  if (!existsSync(path)) return false
  rmdirSync(path)
  return true
}
export function assertDatabaseWritable(folder) {
  if (existsSync(databaseLockPath(folder))) throw new ConnectionError('资料正在迁移或恢复，请等操作结束后再保存。', 503)
}

export function inspectDatabase(db) {
  const result = db.prepare('PRAGMA quick_check').all()
  if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') throw new Error('资料库完整性检查未通过。')
  for (const [table, columns] of Object.entries(structure)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(column => `${column.name}:${column.type.toUpperCase()}:${column.pk}`)
    if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error('资料库结构不兼容，请保留原资料库。')
  }
  if (db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value !== '1') throw new Error('资料库版本不兼容，请保留原资料库。')
  return true
}

function configure(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
}

function acquireOwner(folder) {
  const path = resolve(join(folder, 'database-owner.lock'))
  if (owners.has(path)) return
  const claim = path + '.claim'
  try { mkdirSync(claim, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一项资料库启动核对尚未结束，请稍后再试。'); throw error }
  try {
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) } catch { throw new Error('资料库使用标记无法核对，请先停止其他网页服务再处理。') }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('资料库使用标记无效。')
      let alive = true
      try { process.kill(owner.pid, 0) } catch (failure) { if (failure.code === 'ESRCH') alive = false; else throw failure }
      if (alive) throw new Error('另一项网页服务正在使用此资料库，请关闭后再打开。')
      const stale = path + '.stale-' + randomUUID()
      renameSync(path, stale); mkdirSync(path, { mode: 0o700 }); rmSync(stale, { recursive: true })
    }
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    owners.add(path)
  } finally { rmdirSync(claim) }
}
process.once('exit', () => {
  for (const db of databases.values()) { try { db.close() } catch { /* 退出时不覆盖资料。 */ } }
  for (const path of owners) { try { if (JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).pid === process.pid) { unlinkSync(join(path, 'owner.json')); rmdirSync(path) } } catch { /* 中断后的标记由下次启动核对。 */ } }
})

export function getDatabase(folder) {
  const path = resolve(databasePath(folder))
  let stat
  try { stat = lstatSync(path) }
  catch (error) { if (error.code !== 'ENOENT') throw new ConnectionError('本机资料库无法读取，已暂停修改。', 503) }
  if (!stat) {
    if (databases.has(path) || existsSync(databaseEnabledPath(folder))) throw new ConnectionError('已启用的资料库不见了，已暂停读写，请保留当前目录后处理。', 503)
    return null
  }
  if (databases.has(path)) {
    if (identities.get(path) !== stat.dev + ':' + stat.ino) throw new ConnectionError('资料库文件被其他操作替换，请停止网页服务并核对后重新打开。', 503)
    return databases.get(path)
  }
  let db
  try {
    if (!stat.isFile()) throw new Error('资料库必须是普通文件。')
    acquireOwner(folder)
    chmodSync(dirname(path), 0o700); chmodSync(path, 0o600)
    db = new DatabaseSync(path)
    inspectDatabase(db)
    configure(db)
    if (!existsSync(databaseEnabledPath(folder))) writeFileSync(databaseEnabledPath(folder), '1', { flag: 'wx', mode: 0o600 })
    databases.set(path, db)
    identities.set(path, stat.dev + ':' + stat.ino)
    return db
  } catch (error) {
    db?.close()
    throw new ConnectionError(`本机资料库无法读取，已暂停修改。${error.message}`, 503)
  }
}

export function createDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700)
  const fd = openSync(path, 'wx', 0o600)
  closeSync(fd)
  let db
  try {
    db = new DatabaseSync(path)
    configure(db)
    atomicDatabase(db, () => {
      db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE documents (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE transactions (id TEXT PRIMARY KEY NOT NULL, connection_id TEXT NOT NULL, identity TEXT NOT NULL, time INTEGER NOT NULL, type TEXT NOT NULL, scope TEXT NOT NULL, asset TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX transactions_connection_time ON transactions(connection_id, time DESC, id);
        CREATE INDEX transactions_time ON transactions(time DESC, id);
        CREATE INDEX transactions_related_trade ON transactions(json_extract(payload, '$.relatedTradeId'));
        CREATE TABLE transaction_syncs (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE equity_points (t INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX observations_kind_time ON observations(kind, at DESC, id DESC);
        CREATE TABLE price_observations (key TEXT NOT NULL, at INTEGER NOT NULL, currency TEXT NOT NULL, basis TEXT NOT NULL, price TEXT NOT NULL, PRIMARY KEY(key, at, currency, basis));
        CREATE TABLE workspace_backups (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
      `)
      db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('schema_version', '1')
    })
    return db
  } catch (error) {
    db?.close()
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) unlinkSync(path + suffix)
    throw error
  }
}

export function atomicDatabase(db, work) {
  function run() {
    const result = work()
    if (result && typeof result.then === 'function') throw new Error('资料库保存必须一次同步完成。')
    return result
  }
  if (db.isTransaction) return run()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function serialize(value) {
  const payload = JSON.stringify(value)
  if (payload === undefined) throw new Error('不能保存缺失资料。')
  return payload
}
export function getDocument(db, key) {
  const row = db.prepare('SELECT payload FROM documents WHERE key = ?').get(key)
  return row ? JSON.parse(row.payload) : null
}
export function setDocument(db, key, value) {
  db.prepare('INSERT INTO documents(key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, serialize(value))
}
export function observe(db, kind, value, at = Date.now()) {
  if (typeof kind !== 'string' || !kind || !Number.isSafeInteger(at) || at < 0) throw new Error('历史采样的名称或时间不正确。')
  const payload = serialize(value)
  return atomicDatabase(db, () => {
    if (db.prepare('SELECT payload FROM observations WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind)?.payload === payload) return false
    db.prepare('INSERT INTO observations(kind,at,payload) VALUES (?,?,?)').run(kind, at, payload)
    return true
  })
}
export function recordPrices(db, quotes, currency = 'USDT', basis = 'current') {
  if (!Array.isArray(quotes) || typeof currency !== 'string' || !currency || currency.length > 40 || typeof basis !== 'string' || !basis || basis.length > 80) throw new Error('行情依据格式不正确。')
  return atomicDatabase(db, () => {
    const insert = db.prepare('INSERT INTO price_observations(key,at,currency,basis,price) VALUES (?,?,?,?,?) ON CONFLICT(key,at,currency,basis) DO UPDATE SET price=excluded.price')
    for (const quote of quotes) {
      if (!quote || typeof quote.key !== 'string' || !quote.key || quote.key.length > 512 || !Number.isSafeInteger(quote.at) || quote.at < 0 || !['string', 'number'].includes(typeof quote.price)) throw new Error('行情采样不完整。')
      const price = new Decimal(quote.price)
      if (!price.isFinite() || price.isNegative()) throw new Error('行情价格不正确。')
      insert.run(quote.key, quote.at, currency, basis, String(quote.price))
    }
  })
}
export function closeDatabase(folder) {
  const path = resolve(databasePath(folder)), db = databases.get(path)
  if (db) { db.close(); databases.delete(path); identities.delete(path) }
}

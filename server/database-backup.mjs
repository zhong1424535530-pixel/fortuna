import { DatabaseSync, backup } from 'node:sqlite'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { Decimal } from 'decimal.js'
import { validateWorkspace } from '../src/data/workspace-schema.ts'
import { assertWorkspacePortfolio } from '../src/data/portfolio.ts'
import { validTransactionState } from '../src/data/transactions.ts'
import { validEquityPoint } from '../src/data/equity-history.ts'
import { validateState } from './connection-service.mjs'
import { ConnectionError, validIconImage } from './connection-http.mjs'
import { atomicDatabase, closeDatabase, createDatabase, databaseLockPath, databasePath, databaseWriterLockPath, getDatabase, inspectDatabase } from './database.mjs'

export const FULL_BACKUP_LIMIT = 256 * 1024 * 1024
const FORMAT = 'personal-investment-dashboard-full'
const columns = {
  metadata: ['key', 'value'], documents: ['key', 'payload'],
  transactions: ['id', 'connection_id', 'identity', 'time', 'type', 'scope', 'asset', 'symbol', 'payload'],
  transaction_syncs: ['key', 'payload'], equity_points: ['t', 'payload'],
  observations: ['id', 'kind', 'at', 'payload'], price_observations: ['key', 'at', 'currency', 'basis', 'price'],
  workspace_backups: ['id', 'created_at', 'payload'],
}
const primaryKeys = { metadata: ['key'], documents: ['key'], transactions: ['id'], transaction_syncs: ['key'], equity_points: ['t'], observations: ['id'], price_observations: ['key', 'at', 'currency', 'basis'], workspace_backups: ['id'] }
const numericColumns = new Set(['time', 't', 'at', 'created_at'])
const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message, status = 400) => { throw new ConnectionError(message, status) }
const hash = value => createHash('sha256').update(value).digest('hex')
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)
const backupId = value => typeof value === 'string' && /^\d{13}-[0-9a-f-]{36}$/.test(value)
function exactKeys(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }

function safeTree(value, depth = 0) {
  if (depth > 40) fail('备份层级过深，无法安全读取。')
  if (typeof value === 'number' && !Number.isFinite(value)) fail('备份包含无效金额。')
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase()
    if (['__proto__', 'prototype', 'constructor'].includes(key) || /^(apikey|apisecret|secret|secrets|secretkey|credentials|passphrase|providerkey|privatekey|mnemonic|seedphrase|password|accesstoken|refreshtoken|authorization|cookie|environment|env)$/.test(normalized)) fail('完整备份不能包含密钥、口令或环境设置。')
    safeTree(item, depth + 1)
  }
}
function workspace(value) {
  if (!object(value) || value.format !== 'personal-investment-dashboard' || value.version !== 1 || !uuid(value.revision) || !date(value.updatedAt) || !validateWorkspace(value.data)) fail('备份中的人工资料格式不正确。')
  assertWorkspacePortfolio(value.data)
}
function payload(row) {
  try { const value = JSON.parse(row.payload); safeTree(value); return value }
  catch (error) { if (error instanceof ConnectionError) throw error; fail('备份中有无法读取的业务资料。') }
}
function validateIcons(icons) {
  if (!Array.isArray(icons)) fail('图标资料格式不正确。')
  const names = new Set(); let total = 0
  for (const icon of icons) {
    if (!exactKeys(icon, ['name', 'data']) || typeof icon.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(png|jpe?g|webp)$/.test(icon.name) || icon.name.includes('..') || names.has(icon.name) || typeof icon.data !== 'string' || icon.data.length > 700000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(icon.data)) fail('图标名称、大小或内容无效。')
    const bytes = Buffer.from(icon.data, 'base64')
    if (bytes.toString('base64') !== icon.data || !validIconImage({ buffer: bytes, type: imageTypes[icon.name.split('.').at(-1)] })) fail('图标内容无法识别，仅支持有效的小图片。')
    total += bytes.length; if (total > 128 * 1024 * 1024) fail('图标合计超过128 MB，请先单独保留原资料。', 413)
    names.add(icon.name)
  }
}

export function validateFullBackup(value) {
  if (!exactKeys(value, ['format', 'version', 'createdAt', 'tables', 'icons']) || value.format !== FORMAT || value.version !== 1 || !date(value.createdAt)) fail('请选择本项目的第1版完整业务备份。')
  if (Buffer.byteLength(JSON.stringify(value)) > FULL_BACKUP_LIMIT) fail('完整备份超过256 MB，本次未导入；原资料保留。', 413)
  if (!exactKeys(value.tables, Object.keys(columns))) fail('完整备份的资料表缺失或版本不兼容。')
  safeTree(value)
  const values = {}
  for (const [table, fields] of Object.entries(columns)) {
    const rows = value.tables[table], seen = new Set()
    if (!Array.isArray(rows)) fail('完整备份的资料表无法读取。')
    values[table] = []
    for (const row of rows) {
      if (!exactKeys(row, fields)) fail(`完整备份中的${table}字段不完整。`)
      for (const field of fields) {
        if (numericColumns.has(field) || field === 'id' && table === 'observations') {
          if (!Number.isSafeInteger(row[field]) || row[field] < 0) fail('备份中的编号或时间不正确。')
        } else if (typeof row[field] !== 'string') fail('备份中的文字或原币金额不正确。')
      }
      const key = JSON.stringify(primaryKeys[table].map(field => row[field]))
      if (seen.has(key)) fail('备份含有重复记录，无法确定该保留哪一条。')
      seen.add(key)
      if (fields.includes('payload')) values[table].push(payload(row))
    }
  }
  const tables = value.tables
  if (tables.metadata.find(row => row.key === 'schema_version')?.value !== '1') fail('备份资料库版本不兼容。')
  for (const row of tables.metadata) {
    if (row.key === 'schema_version') continue
    if (row.key !== 'legacy_migration') fail('备份包含无法识别的资料库设置。')
    let migrated; try { migrated = JSON.parse(row.value) } catch { fail('旧资料迁移记录无法读取。') }
    safeTree(migrated)
    if (!exactKeys(migrated, ['at', 'backupPath', 'manifest']) || !Number.isSafeInteger(migrated.at) || migrated.at < 0 || typeof migrated.backupPath !== 'string' || !Array.isArray(migrated.manifest) || migrated.manifest.some(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !/^(workspace\.json|connections\.json|transactions\.json|equity-history\.json|backups(?:\/[A-Za-z0-9_.-]+)?|asset-icons(?:\/[A-Za-z0-9_.-]+)?)$/.test(item[0]) || item[0].includes('..') || typeof item[1] !== 'string' || !(item[1] === 'directory' || /^[0-9a-f]{64}$/.test(item[1])))) fail('旧资料迁移记录格式不正确。')
  }
  for (let index = 0; index < tables.documents.length; index++) {
    const row = tables.documents[index], data = values.documents[index]
    if (row.key === 'workspace') workspace(data)
    else if (row.key === 'connections') { try { validateState(data) } catch { fail('备份中的账户资料格式不正确。') } }
    else if (row.key !== 'transactions-revision' || !uuid(data)) fail('备份包含无法识别的业务资料。')
  }
  if (!validTransactionState({ records: values.transactions, syncs: values.transaction_syncs }, { archive: true })) fail('备份中的交易或查询进度格式不正确。')
  tables.transactions.forEach((row, index) => {
    const data = values.transactions[index]
    if ([['id', 'id'], ['connection_id', 'connectionId'], ['identity', 'identity'], ['time', 'time'], ['type', 'type'], ['scope', 'scope'], ['asset', 'asset'], ['symbol', 'symbol']].some(([field, key]) => row[field] !== data[key])) fail('备份的交易索引与原始内容不一致。')
  })
  tables.transaction_syncs.forEach((row, index) => { const data = values.transaction_syncs[index]; if (row.key !== data.connectionId + ':' + data.key) fail('备份的查询进度编号不一致。') })
  tables.equity_points.forEach((row, index) => { const data = values.equity_points[index]; if (!validEquityPoint(data) || row.t !== data.t) fail('备份中的资产历史格式不正确。') })
  tables.observations.forEach((row, index) => {
    const data = values.observations[index]
    if (row.id < 1 || row.at > Date.now() + 300000) fail('备份中的采样编号或时间不正确。')
    if (row.kind === 'workspace') { if (!validateWorkspace(data)) fail('备份中的人工历史格式不正确。'); assertWorkspacePortfolio(data) }
    else if (row.kind === 'connections') { try { validateState(data) } catch { fail('备份中的账户历史格式不正确。') } }
    else fail('备份包含无法识别的历史采样。')
  })
  for (const row of tables.price_observations) {
    let price; try { price = new Decimal(row.price) } catch { fail('备份中的价格依据不正确。') }
    if (!row.key || row.key.length > 512 || !row.currency || row.currency.length > 40 || !row.basis || row.basis.length > 80 || !price.isFinite() || price.isNegative() || row.at > Date.now() + 300000) fail('备份中的价格依据不正确。')
  }
  tables.workspace_backups.forEach((row, index) => {
    if (!/^\d{13}-[0-9a-f-]{36}\.json$/.test(row.id) || Number(row.id.slice(0, 13)) !== row.created_at) fail('备份中的人工备份编号不正确。')
    workspace(values.workspace_backups[index])
  })
  validateIcons(value.icons)
  return value
}

function safePath(path, directory = false) {
  const absolute = resolve(path), parent = dirname(absolute)
  if (parent !== absolute) safePath(parent, true)
  let stat
  try { stat = lstatSync(absolute) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) fail('资料目录包含链接或特殊文件，已停止以保护原资料。', 503)
  return stat
}
function write(path, value) {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
}
function syncDirectory(folder) { const fd = openSync(folder, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function readIcons(folder) {
  const directory = join(folder, 'asset-icons')
  if (!safePath(directory, true)) return []
  const icons = readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = safePath(path)
    if (stat.size > 512 * 1024) fail('图标文件过大，已停止完整备份。', 413)
    return { name, data: readFileSync(path).toString('base64') }
  })
  validateIcons(icons)
  return icons
}
function hashFile(path) {
  const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = openSync(path, 'r')
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, size)); return digest.digest('hex') }
  finally { closeSync(fd) }
}
function rowsFrom(db) {
  const tables = {}; let bytes = 0
  for (const table of Object.keys(columns)) {
    tables[table] = []
    for (const row of db.prepare(`SELECT ${columns[table].join(',')} FROM ${table}`).iterate()) {
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes > FULL_BACKUP_LIMIT) fail('完整JSON超过256 MB，本次未导出或导入；原资料和已有本机快照保留。', 413)
      tables[table].push(row)
    }
  }
  return tables
}
function summary(value) {
  const counts = Object.fromEntries(Object.entries(value.tables).map(([key, rows]) => [key, rows.length]))
  const range = [null, null]
  for (const [table, field, multiplier] of [['transactions', 'time', 1], ['equity_points', 't', 1000], ['observations', 'at', 1], ['price_observations', 'at', 1]]) for (const row of value.tables[table]) {
    const at = row[field] * multiplier
    range[0] = range[0] === null ? at : Math.min(range[0], at); range[1] = range[1] === null ? at : Math.max(range[1], at)
  }
  return { counts, icons: value.icons.length, createdAt: value.createdAt, earliestAt: range[0], latestAt: range[1] }
}

export function createDatabaseBackup(folder, { isBusy = () => false } = {}) {
  const directory = join(folder, 'database-backups')
  let warning = '', recoveryRequired = false
  function requireDatabase() { safePath(folder, true); safePath(databasePath(folder)); const db = getDatabase(folder); if (!db) fail('资料尚未迁移，原文件已保留；请先完成单独确认的迁移。', 409); return db }
  // 只留最近一份恢复前的保护备份（刚生成的那份），其余一律清理。
  function pruneSnapshots(keep) {
    for (const id of readdirSync(directory).filter(backupId)) if (id !== keep) { const path = join(directory, id); safePath(path, true); rmSync(path, { recursive: true }) }
    syncDirectory(directory)
  }
  function revision(db) {
    // WAL文件变化配合连接写入计数，防止预览后新资料被旧备份覆盖。
    const files = ['', '-wal'].map(suffix => {
      const path = databasePath(folder) + suffix
      if (!safePath(path)) return null
      const stat = lstatSync(path, { bigint: true })
      return [String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]
    })
    return hash(JSON.stringify([files, db.prepare('PRAGMA data_version').get(), db.prepare('SELECT total_changes() AS changes').get(), readIcons(folder)]))
  }
  function status() {
    if (!safePath(databasePath(folder))) {
      getDatabase(folder)
      const maintenance = existsSync(databaseLockPath(folder))
      return { mode: 'legacy', path: databasePath(folder), revision: null, counts: {}, maintenance, warning: maintenance ? '上次资料维护尚未结束，请保留整个资料目录并先核对，暂时不要继续保存。' : '尚未迁移：继续保留并使用原有资料文件。迁移需要另行确认。' }
    }
    const db = requireDatabase()
    const counts = Object.fromEntries(Object.keys(columns).map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]))
    return { mode: 'database', path: databasePath(folder), revision: revision(db), counts, warning, maintenance: existsSync(databaseLockPath(folder)), backupPath: directory }
  }
  async function locked(work) {
    requireDatabase()
    if (isBusy()) fail('账户或交易资料正在读取，请等完成后再备份或恢复。', 409)
    const lock = databaseLockPath(folder)
    try { mkdirSync(lock, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') fail('资料正在迁移、备份或恢复，请稍后再试。', 409); throw error }
    const writer = databaseWriterLockPath(folder)
    let acquiredWriter = false
    try {
      try { mkdirSync(writer, { mode: 0o700 }); acquiredWriter = true } catch (error) { if (error.code === 'EEXIST') fail('资料正在保存，请稍后再备份或恢复。', 409); throw error }
      return await work()
    } finally { if (!recoveryRequired) { if (acquiredWriter) rmdirSync(writer); rmdirSync(lock) } }
  }
  async function snapshot(reason, persistent = true) {
    const db = requireDatabase(), id = `${Date.now()}-${randomUUID()}`, createdAt = new Date().toISOString()
    safePath(directory, true); mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, `.pending-${id}`), target = join(directory, id)
    mkdirSync(temp, { mode: 0o700 })
    try {
      const icons = readIcons(folder), iconsJson = JSON.stringify(icons)
      await backup(db, join(temp, 'portfolio.sqlite'))
      if (JSON.stringify(readIcons(folder)) !== iconsJson) fail('备份期间图标有变动，请稍后重试。', 409)
      const path = join(temp, 'portfolio.sqlite'); safePath(path); chmodSync(path, 0o600)
      const saved = new DatabaseSync(path, { readOnly: true })
      let exported
      try { inspectDatabase(saved); if (!persistent) { exported = { format: FORMAT, version: 1, createdAt, tables: rowsFrom(saved), icons }; validateFullBackup(exported) } }
      finally { saved.close() }
      write(join(temp, 'icons.json'), iconsJson)
      write(join(temp, 'manifest.json'), JSON.stringify({ id, createdAt, reason, databaseHash: hashFile(path), iconsHash: hash(iconsJson) }))
      const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory(temp)
      if (persistent) { renameSync(temp, target); syncDirectory(directory) }
      return { id, createdAt, reason, path: target, exported }
    } finally { if (existsSync(temp)) rmSync(temp, { recursive: true }) }
  }
  async function exportBackup() { return locked(async () => (await snapshot('manual', false)).exported) }
  function previewBackup(value) { validateFullBackup(value); const current = status(); if (current.mode !== 'database') fail(current.warning, 409); return { ...summary(value), revision: current.revision } }
  async function restoreBackup(value, expectedRevision) {
    validateFullBackup(value)
    if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision)) fail('请先预览完整备份，再确认恢复。')
    return locked(async () => {
      if (revision(requireDatabase()) !== expectedRevision) fail('预览之后已有新资料保存，请重新预览再恢复。', 409)
      const temp = join(folder, `.restore-${randomUUID()}`), staged = join(temp, 'portfolio.sqlite'), icons = join(folder, 'asset-icons'), stagedIcons = join(temp, 'asset-icons')
      mkdirSync(temp, { mode: 0o700 }); mkdirSync(stagedIcons, { mode: 0o700 })
      let prepared, movedDatabase = false, movedIcons = false, installedDatabase = false, installedIcons = false, preserve = false
      try {
        prepared = createDatabase(staged)
        atomicDatabase(prepared, () => {
          prepared.exec('DELETE FROM metadata')
          for (const [table, fields] of Object.entries(columns)) {
            const insert = prepared.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
            for (const row of value.tables[table]) insert.run(...fields.map(field => row[field]))
          }
        })
        inspectDatabase(prepared)
        prepared.exec('PRAGMA wal_checkpoint(TRUNCATE)'); prepared.close(); prepared = null
        for (const icon of value.icons) write(join(stagedIcons, icon.name), Buffer.from(icon.data, 'base64'))
        syncDirectory(stagedIcons); syncDirectory(temp)
        const saved = await snapshot('before-restore')
        // 从关闭旧连接到切换完成全程同步；维护锁阻止其他保存入口穿插写入。
        const current = requireDatabase()
        current.exec('PRAGMA wal_checkpoint(TRUNCATE)'); closeDatabase(folder)
        for (const suffix of ['-wal', '-shm']) if (existsSync(databasePath(folder) + suffix)) fail('旧资料库尚未完全关闭，已停止恢复，原资料保留。', 503)
        renameSync(databasePath(folder), join(temp, 'previous.sqlite')); movedDatabase = true
        if (safePath(icons, true)) { renameSync(icons, join(temp, 'previous-icons')); movedIcons = true }
        renameSync(staged, databasePath(folder)); installedDatabase = true
        renameSync(stagedIcons, icons); installedIcons = true
        syncDirectory(folder)
        inspectDatabase(requireDatabase())
        try { pruneSnapshots(saved.id) } catch { /* 清理失败不影响已完成的恢复。 */ }
        warning = '完整资料已恢复；密钥仍在原钥匙串。账户的密钥标记来自备份，请重新核对连接状态。'
        return { restored: true, backupId: saved.id, warning }
      } catch (error) {
        prepared?.close()
        try {
          closeDatabase(folder)
          if (installedDatabase) for (const suffix of ['', '-wal', '-shm']) rmSync(databasePath(folder) + suffix, { force: true })
          if (installedIcons) rmSync(icons, { recursive: true })
          if (movedDatabase) renameSync(join(temp, 'previous.sqlite'), databasePath(folder))
          if (movedIcons) renameSync(join(temp, 'previous-icons'), icons)
          syncDirectory(folder)
        } catch { preserve = true; recoveryRequired = true; fail(`恢复遇到磁盘错误，撤回尚未完成。请停止保存，保留整个资料目录及${temp}，再处理。`, 503) }
        throw error
      } finally { if (!preserve) rmSync(temp, { recursive: true, force: true }) }
    })
  }
  return { status, exportBackup, previewBackup, restoreBackup }
}

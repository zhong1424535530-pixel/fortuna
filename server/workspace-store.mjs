import { removeRetiredDemoData, validateWorkspace } from '../src/data/workspace-schema.ts'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertWorkspacePortfolio } from '../src/data/portfolio.ts'
import { getDatabase, getDocument, setDocument, atomicDatabase, databasePath, assertDatabaseWritable, withDatabaseWriter, observe } from './database.mjs'

export class StorageError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export function parseBackup(value, validate = assertWorkspacePortfolio) {
  if (!value || value.format !== 'personal-investment-dashboard' || value.version !== 1 || !value.data) throw new StorageError(400, '这不是可识别的资产备份文件。')
  try { if (!validateWorkspace(value.data)) throw new Error('资料格式不完整。'); value.data = removeRetiredDemoData(value.data); validate(value.data) } catch (error) { throw new StorageError(400, error.message) }
  return value.data
}
export function createWorkspaceStore(folder, validate = assertWorkspacePortfolio) {
  const filePath = join(folder, 'workspace.json')
  const backupPath = join(folder, 'backups')
  function prepare() { mkdirSync(folder, { recursive: true, mode: 0o700 }); mkdirSync(backupPath, { recursive: true, mode: 0o700 }) }
  function atomic(path, contents) {
    const temporary = `${path}.${randomUUID()}.tmp`
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, contents, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
      assertDatabaseWritable(folder)
      renameSync(temporary, path)
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
  function inspect() {
    const database = getDatabase(folder)
    const document = database ? getDocument(database, 'workspace') : null
    if (database ? document === null : !existsSync(filePath)) return { data: null, revision: null, updatedAt: null }
    const raw = database ? JSON.stringify(document) : readFileSync(filePath, 'utf8')
    try {
      const value = JSON.parse(raw)
      if (typeof value.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(value.revision) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error()
      parseBackup(value, validate)
      return { data: value.data, revision: value.revision, updatedAt: value.updatedAt }
    } catch {
      return { data: null, revision: `damaged-${createHash('sha256').update(raw).digest('hex')}`, updatedAt: null, error: '本机资料文件损坏或格式无法识别，已暂停普通保存。请在设置中预览备份后恢复，原文件会保留。' }
    }
  }
  function read() { const value = inspect(); if (value.error) throw new StorageError(503, value.error); return value }
  function write(data, revision, restore = false) {
    try { if (!validateWorkspace(data)) throw new Error('资料格式不完整。'); data = removeRetiredDemoData(data); validate(data) } catch (error) { throw new StorageError(400, error.message) }
    assertDatabaseWritable(folder)
    const database = getDatabase(folder)
    if (database) return atomicDatabase(database, () => {
      const current = inspect()
      if (current.error && !restore) throw new StorageError(503, current.error)
      if (revision !== current.revision) throw new StorageError(409, '其他页面已更新资料。当前保存未覆盖任何记录，请保留输入并刷新后核对。')
      // 只有导入（整体替换）才留一份导入前的资料；普通保存不再备份。
      const previous = restore ? getDocument(database, 'workspace') : null
      if (previous) {
        const at = Date.now()
        database.exec('DELETE FROM workspace_backups')
        database.prepare('INSERT INTO workspace_backups(id, created_at, payload) VALUES (?, ?, ?)').run(`${at}-${randomUUID()}.json`, at, JSON.stringify(previous))
      }
      const next = { format: 'personal-investment-dashboard', version: 1, revision: randomUUID(), updatedAt: new Date().toISOString(), data }
      setDocument(database, 'workspace', next)
      observe(database, 'workspace', next.data, Date.parse(next.updatedAt))
      return { data: next.data, revision: next.revision, updatedAt: next.updatedAt }
    })
    const current = inspect()
    if (current.error && !restore) throw new StorageError(503, current.error)
    if (revision !== current.revision) throw new StorageError(409, '其他页面已更新资料。当前保存未覆盖任何记录，请保留输入并刷新后核对。')
    prepare()
    // 只有导入（整体替换）才留一份导入前的资料；损坏的原文件每次单独保留。
    if (restore && existsSync(filePath)) atomic(join(backupPath, current.error ? `${Date.now()}-${randomUUID()}.damaged` : 'before-import.json'), readFileSync(filePath, 'utf8'))
    const next = { format: 'personal-investment-dashboard', version: 1, revision: randomUUID(), updatedAt: new Date().toISOString(), data }
    atomic(filePath, JSON.stringify(next))
    return { data: next.data, revision: next.revision, updatedAt: next.updatedAt }
  }
  return {
    read, inspect,
    info: () => ({ filePath: getDatabase(folder) ? databasePath(folder) : filePath, backupPath }),
    save: (data, revision) => withDatabaseWriter(folder, () => write(data, revision)),
    restore: (data, revision) => withDatabaseWriter(folder, () => write(data, revision, true)),
    export: () => ({ format: 'personal-investment-dashboard', version: 1, exportedAt: new Date().toISOString(), data: read().data ?? { manualAssets: [], customizations: {}, snapshots: [], changes: [] } }),
  }
}

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { feeRecordKey, validFeeValuations } from '../src/data/fee-valuation.ts'
import { randomUUID } from 'node:crypto'
import { emptyTransactions, validTransactionState } from '../src/data/transactions.ts'
import { ConnectionError, decimal } from './connection-http.mjs'
import { getDatabase, atomicDatabase, setDocument, assertDatabaseWritable, withDatabaseWriter } from './database.mjs'

export function mergeTransactions(prior, next) {
  const rows = new Map(prior.map(row => [row.id, row]))
  for (const row of next) {
    const old = rows.get(row.id)
    rows.set(row.id, !row.feeValuations && old?.feeValuations && feeRecordKey(old) === feeRecordKey(row) && validFeeValuations(old) ? { ...row, feeValuations: old.feeValuations } : row)
  }
  return [...rows.values()].filter(row => {
    const trade = row.relatedTradeId && rows.get(row.relatedTradeId)
    if (!trade || !['买入', '卖出'].includes(trade.type)) return true
    if (row.type === '手续费' && trade.fees.some(fee => fee.asset === row.asset && decimal(fee.quantity, '手续费', true).negated().eq(row.quantity))) return false
    if (row.type === '已实现盈亏' && trade.pnlAsset === row.asset && trade.realizedPnl !== null && decimal(trade.realizedPnl, '平仓盈亏', true).eq(row.quantity)) return false
    return true
  }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))
}
export function createTransactionStore(folder) {
  const path = join(folder, 'transactions.json')
  function list({ connectionId = '', start = 0, end = Number.MAX_SAFE_INTEGER, offset = 0, limit = null } = {}) {
    const database = getDatabase(folder)
    if (database) {
      if (![start, end, offset].every(Number.isSafeInteger) || start < 0 || end < start || offset < 0 || limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000)) throw new ConnectionError('交易记录查询范围无效。')
      const where = 'time >= ? AND time <= ?' + (connectionId ? ' AND connection_id = ?' : '')
      const values = [start, end, ...(connectionId ? [connectionId] : [])]
      const records = database.prepare(`SELECT payload FROM transactions WHERE ${where} ORDER BY time DESC, id ASC${limit === null ? '' : ' LIMIT ? OFFSET ?'}`).all(...values, ...(limit === null ? [] : [limit, offset])).map(row => JSON.parse(row.payload))
      const syncs = database.prepare('SELECT payload FROM transaction_syncs').all().map(row => JSON.parse(row.payload))
      if (!validTransactionState({ records, syncs }, { archive: true })) throw new ConnectionError('资料库中的交易记录无法核对，已暂停修改。', 503)
      return { records, syncs }
    }
    if (!existsSync(path)) return emptyTransactions()
    try {
      if (statSync(path).size > 48 * 1024 * 1024) throw new Error()
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!validTransactionState(value)) throw new Error()
      const records = value.records.filter(row => row.time >= start && row.time <= end && (!connectionId || row.connectionId === connectionId))
      return { records: limit === null ? records : records.slice(offset, offset + limit), syncs: value.syncs }
    } catch { throw new ConnectionError('交易记录文件无法读取，已暂停修改，请保留原文件后处理。', 503) }
  }
  function save(records, syncs) {
    assertDatabaseWritable(folder)
    const database = getDatabase(folder)
    if (!validTransactionState({ records, syncs }, { archive: !!database })) throw new ConnectionError('交易记录格式不完整，本次未替换已有资料。', 502)
    if (database) return atomicDatabase(database, () => {
      const affected = new Map(), get = database.prepare('SELECT payload FROM transactions WHERE id = ?')
      const related = database.prepare("SELECT payload FROM transactions WHERE json_extract(payload, '$.relatedTradeId') = ?")
      for (const row of records) {
        for (const id of [row.id, row.relatedTradeId].filter(Boolean)) {
          const prior = get.get(id)
          if (prior) { const value = JSON.parse(prior.payload); affected.set(value.id, value) }
        }
        for (const prior of related.all(row.id)) { const value = JSON.parse(prior.payload); affected.set(value.id, value) }
      }
      const merged = mergeTransactions([...affected.values()], records), kept = new Set(merged.map(row => row.id))
      for (const id of affected.keys()) if (!kept.has(id)) database.prepare('DELETE FROM transactions WHERE id = ?').run(id)
      const put = database.prepare('INSERT INTO transactions(id, connection_id, identity, time, type, scope, asset, symbol, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id, identity=excluded.identity, time=excluded.time, type=excluded.type, scope=excluded.scope, asset=excluded.asset, symbol=excluded.symbol, payload=excluded.payload')
      for (const row of merged) put.run(row.id, row.connectionId, row.identity, row.time, row.type, row.scope, row.asset, row.symbol, JSON.stringify(row))
      const putSync = database.prepare('INSERT INTO transaction_syncs(key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload')
      for (const item of syncs) putSync.run(item.connectionId + ':' + item.key, JSON.stringify(item))
      setDocument(database, 'transactions-revision', randomUUID())
      return list()
    })
    const prior = list()
    const scopeMap = new Map(prior.syncs.map(item => [item.connectionId + ':' + item.key, item]))
    for (const item of syncs) scopeMap.set(item.connectionId + ':' + item.key, item)
    const state = { records: mergeTransactions(prior.records, records), syncs: [...scopeMap.values()] }
    const content = JSON.stringify(state)
    if (!validTransactionState(state) || Buffer.byteLength(content) > 48 * 1024 * 1024) throw new ConnectionError('交易记录已达到本机容量上限，已保留原资料，请先导出后处理。', 503)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const temp = path + '.' + randomUUID() + '.tmp'
    let fd
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; assertDatabaseWritable(folder); renameSync(temp, path) }
    catch { throw new ConnectionError('交易记录保存失败，原文件保留。', 503) }
    finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp) }
    return state
  }
  return { list, save: (records, syncs) => withDatabaseWriter(folder, () => save(records, syncs)) }
}

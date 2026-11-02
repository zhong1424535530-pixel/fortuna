import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendEquityPoint, compactEquityPoints, validEquityPoint } from '../src/data/equity-history.ts'
import { getDatabase, atomicDatabase, assertDatabaseWritable, recordPrices, withDatabaseWriter } from './database.mjs'
import { ConnectionError } from './connection-http.mjs'

const chains = new Map()

function read(folder) {
  const database = getDatabase(folder)
  if (database) {
    const points = database.prepare('SELECT payload FROM equity_points ORDER BY t').all().map(row => JSON.parse(row.payload))
    if (points.some(point => !validEquityPoint(point))) throw new ConnectionError('资料库中的历史曲线无法核对，原资料保留。', 503)
    return points
  }
  const path = join(folder, 'equity-history.json')
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(data.points)) throw new Error()
    return data.points.filter(point => validEquityPoint(point))
  } catch { throw new ConnectionError('走势文件无法读取，已暂停写入以保护原文件，请先保留 equity-history.json 再处理。', 503) }
}

function write(folder, points) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, 'equity-history.json')
  const temp = path + '.' + randomUUID() + '.tmp'
  let fd
  try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ points })); fsyncSync(fd); closeSync(fd); fd = undefined; assertDatabaseWritable(folder); renameSync(temp, path) }
  finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp) }
}

export function listEquityHistory(folder, { start = 0, end = Number.MAX_SAFE_INTEGER, sample = true } = {}) {
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start) throw new ConnectionError('历史日期范围无效。')
  const database = getDatabase(folder)
  if (!database) return read(folder).filter(point => point.t >= start && point.t <= end)
  const rows = database.prepare('SELECT payload FROM equity_points WHERE t >= ? AND t <= ? ORDER BY t').all(start, end).map(row => JSON.parse(row.payload))
  if (rows.some(point => !validEquityPoint(point))) throw new ConnectionError('资料库中的历史曲线无法核对，原资料保留。', 503)
  if (!sample || rows.length <= 4000) return rows
  // 只压缩发送到页面的曲线，资料库里的原始采样保持完整。
  const stride = Math.ceil(rows.length / 3500), keep = new Map()
  for (let i = 0; i < rows.length; i++) {
    const point = rows[i], day = Math.floor((point.t + 8 * 3600) / 86400)
    if (i % stride === 0 || i === rows.length - 1) keep.set(point.t, point)
    if (i === 0 || Math.floor((rows[i - 1].t + 8 * 3600) / 86400) !== day) keep.set(point.t, point)
    if (i === rows.length - 1 || Math.floor((rows[i + 1].t + 8 * 3600) / 86400) !== day) keep.set(point.t, point)
  }
  return [...keep.values()].sort((a, b) => a.t - b.t)
}

// 每小时整理一次旧曲线（规则见 compactEquityPoints），否则每分钟一个点，三年会超过 10 GB。
// 同时删除被整理掉的点对应的价格依据，两张表保持一致。
let compactedAt = 0
export function compactHistory(database, nowSeconds, force = false) {
  if (!force && Date.now() - compactedAt < 3600000) return 0
  compactedAt = Date.now()
  const times = database.prepare('SELECT t FROM equity_points ORDER BY t').all().map(row => row.t)
  const kept = new Set(compactEquityPoints(times.map(t => ({ t })), nowSeconds).map(point => point.t))
  const dropped = times.filter(t => !kept.has(t))
  if (!dropped.length) return 0
  atomicDatabase(database, () => {
    const remove = database.prepare('DELETE FROM equity_points WHERE t = ?')
    for (const t of dropped) remove.run(t)
    database.prepare("DELETE FROM price_observations WHERE basis = 'equity' AND at NOT IN (SELECT t * 1000 FROM equity_points)").run()
  })
  return dropped.length
}

export function saveEquityPoint(folder, point) {
  const run = (chains.get(folder) ?? Promise.resolve()).then(() => withDatabaseWriter(folder, () => {
    assertDatabaseWritable(folder)
    const database = getDatabase(folder)
    if (database) {
      if (!validEquityPoint(point)) throw new ConnectionError('历史采样格式无效，原资料保留。')
      atomicDatabase(database, () => {
        // 系统时钟被回拨时不写入比已有记录更早的点，避免历史顺序错乱。
        const latest = database.prepare('SELECT MAX(t) AS t FROM equity_points').get().t
        if (latest !== null && point.t < latest) return
        database.prepare('INSERT INTO equity_points(t, payload) VALUES (?, ?) ON CONFLICT(t) DO UPDATE SET payload=excluded.payload').run(point.t, JSON.stringify(point))
        recordPrices(database, point.prices.map(([key, price]) => ({ key, price: String(price), at: point.t * 1000 })), 'USD', 'equity')
      })
      compactHistory(database, point.t)
      return
    }
    const points = appendEquityPoint(read(folder), point)
    if (!validEquityPoint(point)) return points
    write(folder, points)
    return points
  }))
  chains.set(folder, run.then(() => {}, () => {}))
  return run
}

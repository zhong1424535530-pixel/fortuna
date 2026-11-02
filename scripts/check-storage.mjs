import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { createWorkspaceStore, parseBackup } from '../server/workspace-store.mjs'
import { createWorkspaceApi } from '../server/workspace-api.mjs'

const folder = mkdtempSync(join(tmpdir(), 'investment-storage-check-'))
const empty = { manualAssets: [], customizations: {}, snapshots: [], changes: [] }
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII='
const cost = { averagePrice: 1, quantity: 712, currency: 'USD', feeIncluded: false, updatedAt: '2026-10-19T00:00:00Z' }
// 本轮增加现金/负债恢复场景，等待本人另行同意后运行。
const sample = { ...empty, avatar, costs: { 'manual-cash': { manual: cost } }, liabilities: [{ id: 'liability-home', name: '房贷', kind: '房贷', amount: 712000, currency: 'CNY', note: '隔离检查', settled: false, updatedAt: cost.updatedAt }], manualAssets: [{ id: 'manual-cash', name: '人民币余额', symbol: 'CNY', market: 'cash', quantity: 712, price: 1, currency: 'CNY', accountId: 'manual', icon: '', updatedAt: cost.updatedAt }] }
let server
try {
  const store = createWorkspaceStore(join(folder, 'files'))
  assert.equal(store.read().data, null)
  const first = store.save(sample, null)
  assert.throws(() => store.save({ ...sample, avatar: 'https://outside.example/avatar.svg' }, first.revision), /资料/, '头像只接受受限的本机图片')
  assert.deepEqual(createWorkspaceStore(join(folder, 'files')).read().data, sample, '服务重启后读取同一份文件')
  assert.equal(statSync(store.info().filePath).mode & 0o777, 0o600)
  assert.throws(() => store.save(empty, null), /其他页面/, '旧页面不能覆盖已迁移资料')
  const second = store.save(empty, first.revision)
  assert.notEqual(first.revision, second.revision)
  assert.equal(readdirSync(store.info().backupPath).length, 0, '普通保存不再自动备份')
  assert.deepEqual(parseBackup(store.export()), empty)
  const restored = store.restore(sample, second.revision)
  assert.deepEqual(store.read().data, sample)
  assert.deepEqual(JSON.parse(readFileSync(join(store.info().backupPath, 'before-import.json'), 'utf8')).data, empty, '导入前保留当前资料')
  assert.throws(() => store.save({ ...sample, costs: { 'manual-cash': { gf: cost } } }, restored.revision), /账户/)
  assert.throws(() => parseBackup({ format: 'wrong', version: 1, data: sample }))
  assert.throws(() => parseBackup({ ...store.export(), data: { ...empty, manualAssets: [{ id: 'bad' }] } }))
  let current = restored
  for (let index = 0; index < 6; index++) current = store.save(index % 2 ? empty : sample, current.revision)
  assert.equal(readdirSync(store.info().backupPath).length, 1, '之后的普通保存不新增备份')
  writeFileSync(store.info().filePath, '{broken')
  assert.throws(() => store.read(), /损坏|无法读取/)
  assert.throws(() => store.save(empty, current.revision), /损坏|无法读取/)
  assert.equal(readFileSync(store.info().filePath, 'utf8'), '{broken', '损坏文件不得被空资料覆盖')
  const damaged = store.inspect()
  assert.throws(() => store.restore(sample, current.revision), /其他页面/)
  store.restore(sample, damaged.revision)
  assert.deepEqual(store.read().data, sample)
  const quarantined = readdirSync(store.info().backupPath).find(id => id.endsWith('.damaged'))
  assert.ok(quarantined)
  assert.equal(readFileSync(join(store.info().backupPath, quarantined), 'utf8'), '{broken', '明确恢复后仍保留损坏原件')

  const api = createWorkspaceApi(join(folder, 'api'))
  server = createServer(api)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'X-Investment-App': '1', 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + '/api/workspace')).status, 403)
  assert.equal((await fetch(base + '/api/workspace', { headers: { ...headers, Origin: 'https://outside.example' } })).status, 403)
  assert.equal(await new Promise((resolve, reject) => { const request = httpRequest(base + '/api/workspace', { headers: { ...headers, Host: 'outside.example' } }, response => { response.resume(); resolve(response.statusCode) }); request.on('error', reject); request.end() }), 403)
  const start = await (await fetch(base + '/api/workspace', { headers })).json()
  assert.equal(start.data, null)
  const save = await fetch(base + '/api/workspace', { method: 'PUT', headers, body: JSON.stringify({ revision: null, data: sample }) })
  assert.equal(save.status, 200)
  const saved = await save.json()
  assert.deepEqual(saved.data, sample)
  assert.equal((await fetch(base + '/api/workspace', { method: 'PUT', headers, body: JSON.stringify({ revision: null, data: empty }) })).status, 409)
  assert.equal((await fetch(base + '/api/workspace', { method: 'PUT', headers, body: '{invalid' })).status, 400)
  assert.equal((await fetch(base + '/api/workspace', { method: 'PUT', headers, body: 'x'.repeat(12 * 1024 * 1024 + 1) })).status, 413)
  const exported = await (await fetch(base + '/api/export', { headers })).json()
  assert.deepEqual(parseBackup(exported), sample)
  assert.ok(!('revision' in exported) && !('filePath' in exported))
  assert.deepEqual((await (await fetch(base + '/api/workspace', { headers })).json()).data, sample)
  assert.equal((await fetch(base + '/api/backups', { headers })).status, 404, '自动备份接口已移除')
  console.log('本机文件保存、重启读取、导入前保护、并发保护、损坏保护和接口边界检查通过。测试目录与本人资料隔离。')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  rmSync(folder, { recursive: true, force: true })
}

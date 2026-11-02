// 只用临时目录、假时钟和本机端口，不联网、不碰本人资料。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32nopad } from '@scure/base'
import { createAuth, newSecret, otpauthUri, totp } from '../server/auth.mjs'
import { createWorkspaceApi } from '../server/workspace-api.mjs'

// RFC 6238 附录 B 标准向量（SHA1，8 位码的后 6 位）：时间 59 秒 → 94287082。
assert.equal(totp(Buffer.from('12345678901234567890'), Math.floor(59 / 30)), '287082')
assert.equal(totp(Buffer.from('12345678901234567890'), Math.floor(1111111109 / 30)), '081804')
const secret = newSecret()
assert.match(secret, /^[A-Z2-7]{32}$/)
assert.equal(otpauthUri(secret), `otpauth://totp/Fortuna?secret=${secret}`)
assert.ok(otpauthUri(secret).length <= 78, '地址超过 78 字节二维码会变大，80 列的终端放不下')
const codeAt = (time, offset = 0) => totp(Buffer.from(base32nopad.decode(secret)), Math.floor(time / 30000) + offset)

const folder = mkdtempSync(join(tmpdir(), 'auth-check-'))
let clock = 1_800_000_000_000, server
try {
  const auth = createAuth(folder, { now: () => clock })
  server = createServer(createWorkspaceApi(join(folder, 'api'), { auth: createAuth(folder, { now: () => clock }) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port, base = `http://127.0.0.1:${port}`
  const call = (path, { method = 'GET', cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { method, headers: { 'X-Investment-App': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null, cookie: response.headers['set-cookie']?.[0] }))
    })
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const login = (username, code) => call('/api/auth/login', { method: 'POST', body: { username, code } })

  // 还没绑定：什么数据都拿不到，也登录不了。
  assert.deepEqual((await call('/api/auth/status')).body, { bound: false, authenticated: false })
  assert.equal((await call('/api/connections')).status, 401)
  assert.equal((await login('qingbaoju', '000000')).status, 409)

  auth.bind(secret, -1)
  assert.equal(auth.username(), 'qingbaoju', '默认用户名')
  assert.equal(statSync(join(folder, 'auth.json')).mode & 0o777, 0o600, '登录资料仅本人可读写')

  // 未登录的任何数据接口都拒绝，包括图标。
  for (const path of ['/api/connections', '/api/workspace', '/api/database/export', '/api/transactions', '/api/equity-history']) assert.equal((await call(path)).status, 401, path)
  assert.equal((await call('/api/asset-icon?asset=x', { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Investment-App': '0' } })).status, 401)
  assert.equal((await call('/api/connections', { cookie: 'qbj_session=' + 'A'.repeat(43) })).status, 401, '伪造的登录凭证无效')

  // 正确登录：下发 HttpOnly + SameSite=Strict 的凭证，之后能读数据。
  const good = codeAt(clock)
  const ok = await login('QingBaoJu', good)
  assert.equal(ok.status, 200, '用户名不区分大小写')
  assert.match(ok.cookie, /^qbj_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/)
  const session = ok.cookie.split(';')[0]
  assert.ok(!readFileSync(join(folder, 'auth.json'), 'utf8').includes(session.split('=')[1]), '磁盘上不保存明文凭证')
  assert.equal((await call('/api/connections', { cookie: session })).status, 200)
  assert.deepEqual((await call('/api/auth/status', { cookie: session })).body, { bound: true, authenticated: true, username: 'qingbaoju' })
  assert.deepEqual((await call('/api/auth/status')).body, { bound: true, authenticated: false }, '未登录时不透露用户名')
  assert.match((await login('qingbaoju', '123456')).body.error, /不正确/)

  // 同一个动态码不能重放；下一个窗口的码可以。
  clock += 1000
  assert.equal((await login('qingbaoju', good)).status, 401, '已用过的码不能再用')
  assert.equal((await login('qingbaoju', codeAt(clock, 1))).status, 200, '下一个窗口的码有效')
  assert.equal((await login('qingbaoju', codeAt(clock, -3))).status, 401, '过期太久的码无效')

  // 服务重启后登录状态仍在（登录资料在磁盘上）。
  const restarted = createAuth(folder, { now: () => clock })
  assert.equal(restarted.check({ headers: { cookie: session }, socket: {} }), true)

  // 经过反向代理的 HTTPS 访问，凭证加 Secure。
  clock += 60000
  const secure = await call('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, body: { username: 'qingbaoju', code: codeAt(clock) } })
  assert.match(secure.cookie, /; Secure$/)

  // 改用户名：需要已登录；格式受限；新名字立即生效，登录状态保留。
  assert.equal((await call('/api/auth/username', { method: 'PUT', body: { username: 'newname' } })).status, 401)
  assert.equal((await call('/api/auth/username', { method: 'PUT', cookie: session, body: { username: 'a b' } })).status, 400)
  assert.equal((await call('/api/auth/username', { method: 'PUT', cookie: session, body: { username: 'a' } })).status, 400)
  assert.deepEqual((await call('/api/auth/username', { method: 'PUT', cookie: session, body: { username: ' my.name-1 ' } })).body, { username: 'my.name-1' })
  assert.deepEqual((await call('/api/auth/username', { method: 'PUT', cookie: session, body: { username: '张三.J' } })).body, { username: '张三.J' }, '用户名可以是中文')
  assert.deepEqual((await call('/api/auth/username', { method: 'PUT', cookie: session, body: { username: ' my.name-1 ' } })).body, { username: 'my.name-1' })
  assert.equal((await call('/api/connections', { cookie: session })).status, 200)
  clock += 60000
  assert.equal((await login('qingbaoju', codeAt(clock))).status, 401, '旧用户名不能再用')
  assert.equal((await login('my.name-1', codeAt(clock))).status, 200)

  // 不同地址访问：来源必须与访问地址一致；跨站一律拒绝。
  assert.equal((await call('/api/connections', { cookie: session, headers: { Host: 'asset.example.com' } })).status, 200, '域名或 IP 访问不再被本机地址限制拦截')
  assert.equal((await call('/api/connections', { cookie: session, headers: { Host: 'asset.example.com', Origin: 'https://asset.example.com' } })).status, 200)
  assert.equal((await call('/api/connections', { cookie: session, headers: { Origin: 'https://outside.example' } })).status, 403)
  assert.equal((await call('/api/connections', { cookie: session, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await call('/api/connections', { cookie: session, headers: { 'X-Investment-App': '0' } })).status, 403)

  // 退出登录后凭证作废。
  const out = await call('/api/auth/logout', { method: 'POST', cookie: session })
  assert.match(out.cookie, /Max-Age=0$/)
  assert.equal((await call('/api/connections', { cookie: session })).status, 401)

  // 按来源地址：连错 5 次锁这个地址 24 小时，锁定期间正确的码也不行；别的地址不受影响；重启后仍锁；服务器上解除后恢复。
  const wrong = headers => call('/api/auth/login', { method: 'POST', headers, body: { username: 'qingbaoju', code: '000000' } })
  const right = headers => call('/api/auth/login', { method: 'POST', headers, body: { username: 'my.name-1', code: codeAt(clock, 1) } })
  const attacker = { 'X-Forwarded-For': '203.0.113.9' }, owner = { 'X-Forwarded-For': '198.51.100.7' }
  for (let i = 0; i < 5; i++) assert.equal((await wrong(attacker)).status, 401)
  clock += 60000
  const locked = await right(attacker)
  assert.equal(locked.status, 429); assert.match(locked.body.error, /investment-unlock/)
  clock += 23 * 3600000
  assert.equal((await right(attacker)).status, 429, '24 小时内一直锁着')
  assert.equal(createAuth(folder, { now: () => clock }).unlockAll(), 1, '重启后锁定记录仍在')
  assert.equal((await right(attacker)).status, 200, '服务器上解除后立即恢复')
  for (let i = 0; i < 5; i++) assert.equal((await wrong(attacker)).status, 401)
  clock += 25 * 3600000
  assert.equal((await right(attacker)).status, 200, '满 24 小时自动解除')
  for (let i = 0; i < 5; i++) assert.equal((await wrong(attacker)).status, 401)
  clock += 60000
  assert.equal((await right(owner)).status, 200, '别的地址不受影响')

  // 重新绑定：旧登录全部失效，新密钥生效。
  const before = createAuth(folder, { now: () => clock })
  const another = newSecret()
  before.bind(another, Math.floor(clock / 30000))
  assert.equal(before.check({ headers: { cookie: session }, socket: {} }), false)
  assert.equal(before.username(), 'my.name-1', '重新绑定保留用户名')

  // 登录资料损坏时一律拒绝（不放行）。
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(folder, 'auth.json'), '{broken')
  assert.equal((await call('/api/connections')).status, 503)
  console.log('登录检查通过：动态码标准向量、未登录一律拒绝、重放与限流、用户名修改、重启后保持登录、退出与重新绑定。')
} finally {
  server?.close()
  rmSync(folder, { recursive: true, force: true })
}

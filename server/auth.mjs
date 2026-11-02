// 登录：用户名 + 谷歌验证器的 6 位动态码（RFC 6238）。资料放在资料目录的 auth.json，权限 600。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { base32nopad } from '@scure/base'
import { ConnectionError } from './connection-http.mjs'
import { validUsername } from '../src/data/workspace-schema.ts'

export const DEFAULT_USERNAME = 'qingbaoju'
const LABEL = 'Fortuna'
const STEP_MS = 30000
const SESSION_MS = 30 * 86400000
const MAX_SESSIONS = 20
const MAX_FAILURES = 5
const LOCK_MS = 86400000
const COOKIE = 'qbj_session'
const digest = value => createHash('sha256').update(value).digest()
const sameText = (a, b) => timingSafeEqual(digest(a), digest(b))

export function totp(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', secret).update(counter).digest()
  return String((hmac.readUInt32BE(hmac[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0')
}
// 允许前后各一个 30 秒窗口（手机与服务器时钟略有偏差）；已用过的窗口不能再用，同一个码不能重放。
export function matchStep(secretText, code, lastStep, time) {
  if (!/^\d{6}$/.test(code)) return null
  const secret = Buffer.from(base32nopad.decode(secretText)), current = Math.floor(time / STEP_MS)
  for (const step of [current - 1, current, current + 1]) if (step > lastStep && sameText(totp(secret, step), code)) return step
  return null
}
export const newSecret = () => base32nopad.encode(randomBytes(20))
// 地址越短二维码越小：这样 80 列的 SSH 终端也能完整显示，不要往里加别的参数。
export const otpauthUri = secret => `otpauth://totp/${LABEL}?secret=${secret}`
export { validUsername }

export function createAuth(folder, { now = Date.now } = {}) {
  const path = join(folder, 'auth.json')
  let cache = null, cacheKey = ''
  // 按来源地址计数：连错 5 次就锁这个地址 24 小时，只有在服务器上运行 investment-unlock 才能提前解开。
  // shortcut: 连错次数只放内存（重启清零），锁定记录落盘（auth-locks.json）；攻击者换地址会重新计数，量大时再考虑全局限速。
  const failures = new Map(), locksPath = join(folder, 'auth-locks.json')
  // 经 Caddy 转发时真实地址在 X-Forwarded-For 里，只在连接来自本机时才信它，直连的请求不能自报地址。
  const clientIp = request => {
    const remote = request.socket.remoteAddress ?? 'unknown'
    return /^(127\.|::1$|::ffff:127\.)/.test(remote) ? request.headers['x-forwarded-for']?.split(',').at(-1).trim() || remote : remote
  }
  function readLocks() {
    try { const value = JSON.parse(readFileSync(locksPath, 'utf8')); return value && typeof value === 'object' ? value : {} } catch { return {} }
  }
  function lock(ip) {
    const locks = Object.fromEntries(Object.entries(readLocks()).filter(([, until]) => until > now()))
    locks[ip] = now() + LOCK_MS
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(locksPath, JSON.stringify(locks), { mode: 0o600 })
  }
  function unlockAll() {
    const count = Object.values(readLocks()).filter(until => until > now()).length
    if (existsSync(locksPath)) unlinkSync(locksPath)
    return count
  }

  function read() {
    let stat
    try { stat = statSync(path, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw new ConnectionError('登录资料无法读取，已拒绝所有访问。', 503) }
    const key = `${stat.ino}:${stat.size}:${stat.mtimeNs}`
    if (key === cacheKey) return cache
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      base32nopad.decode(value.secret)
      if (value.version !== 1 || !validUsername(value.username) || !Number.isSafeInteger(value.lastStep) || !Array.isArray(value.sessions) || value.sessions.some(item => typeof item?.hash !== 'string' || !Number.isFinite(item.expires))) throw new Error()
      cache = value; cacheKey = key
      return cache
    } catch { throw new ConnectionError('登录资料已损坏，已拒绝所有访问。请在服务器上运行 sudo investment-bind 重新绑定。', 503) }
  }
  function write(state) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
    let fd
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path) }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp) } catch { /* 已改名或未创建。 */ } }
    cacheKey = ''
  }
  const tokenOf = request => request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`))?.[1] ?? null
  const live = state => state.sessions.filter(item => item.expires > now())
  const cookie = (token, request, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`

  function check(request) {
    const state = read(), token = tokenOf(request)
    if (!state || !token) return false
    const hash = digest(token).toString('hex')
    return live(state).some(item => item.hash === hash)
  }
  function status(request) {
    const state = read(), authenticated = check(request)
    return { bound: !!state, authenticated, ...(authenticated ? { username: state.username } : {}) }
  }
  function login({ username, code }, request) {
    const state = read()
    if (!state) throw new ConnectionError('服务器尚未完成初始化，暂时无法登录。', 409)
    const ip = clientIp(request), until = readLocks()[ip] ?? 0
    if (until > now()) throw new ConnectionError(`这个网络地址连续输错 5 次，已锁定 ${Math.ceil((until - now()) / 3600000)} 小时。请在服务器上运行 sudo investment-unlock 解除。`, 429)
    // 用户名和动态码都要核对，不让回答泄露是哪一项错了。
    const nameOk = typeof username === 'string' && sameText(username.trim().toLowerCase(), state.username.toLowerCase())
    const step = typeof code === 'string' ? matchStep(state.secret, code, state.lastStep, now()) : null
    if (!nameOk || step === null) {
      const count = (failures.get(ip) ?? 0) + 1
      if (count >= MAX_FAILURES) { failures.delete(ip); lock(ip) } else failures.set(ip, count)
      throw new ConnectionError('用户名或动态码不正确。', 401)
    }
    failures.delete(ip)
    const token = randomBytes(32).toString('base64url')
    write({ ...state, lastStep: step, sessions: [...live(state), { hash: digest(token).toString('hex'), expires: now() + SESSION_MS }].slice(-MAX_SESSIONS) })
    return cookie(token, request, SESSION_MS / 1000)
  }
  function logout(request) {
    const state = read(), token = tokenOf(request)
    if (state && token) { const hash = digest(token).toString('hex'); write({ ...state, sessions: live(state).filter(item => item.hash !== hash) }) }
    return cookie('', request, 0)
  }
  function rename(username) {
    const state = read()
    if (!state) throw new ConnectionError('尚未绑定动态码。', 409)
    if (!validUsername(username)) throw new ConnectionError('用户名需为 2–32 位文字、数字、下划线、点或短横线。')
    write({ ...state, username: username.trim() })
    return username.trim()
  }
  // 绑定或重新绑定：旧的登录状态全部作废。
  function bind(secret, step, username = read()?.username ?? DEFAULT_USERNAME) {
    write({ version: 1, username, secret, lastStep: step, sessions: [] })
  }
  return { check, status, login, logout, rename, bind, unlockAll, bound: () => !!read(), username: () => read()?.username ?? DEFAULT_USERNAME }
}

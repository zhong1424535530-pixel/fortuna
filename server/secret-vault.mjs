// 交易所密钥的保存位置：Mac 用系统钥匙串；Linux 服务器没有图形界面的钥匙串，改存加密文件。
// 加密文件 secrets.enc.json：AES-256-GCM，加密口令来自环境变量 INVESTMENT_MASTER_KEY（至少 24 个字符），口令不进资料目录，也不进备份。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { AsyncEntry } from '@napi-rs/keyring'
import { ConnectionError } from './connection-http.mjs'

const FILE = 'secrets.enc.json'
const noKey = () => new ConnectionError('服务器没有设置密钥加密口令 INVESTMENT_MASTER_KEY，无法读取或保存交易所密钥。', 503)

export function createFileVault(folder, { masterKey = process.env.INVESTMENT_MASTER_KEY } = {}) {
  const path = join(folder, FILE)
  let derived = null
  const keyFor = salt => {
    if (typeof masterKey !== 'string' || masterKey.length < 24) throw noKey()
    if (!derived || derived.salt !== salt) derived = { salt, key: scryptSync(masterKey, Buffer.from(salt, 'base64'), 32) }
    return derived.key
  }
  function load() {
    if (!existsSync(path)) return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} }
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value.version !== 1 || typeof value.salt !== 'string' || !value.entries || typeof value.entries !== 'object') throw new Error()
      return value
    } catch { throw new ConnectionError('密钥文件无法读取，已拒绝修改，请先保留 secrets.enc.json 再处理。', 503) }
  }
  function store(value) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
    let fd
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path) }
    catch { throw new ConnectionError('密钥文件保存失败，未写入明文。', 503) }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp) } catch { /* 已改名或未创建。 */ } }
  }
  // 把账户编号作为附加认证数据：把 A 账户的密文搬到 B 账户名下会解不开。
  const seal = (key, id, secret) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(id))
    const data = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  }
  const open = (key, id, entry) => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'))
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8'))
    } catch { throw new ConnectionError('密钥解密失败：加密口令不对，或密钥文件被改动。', 503) }
  }
  return {
    async get(id) { const file = load(); return file.entries[id] ? open(keyFor(file.salt), id, file.entries[id]) : {} },
    async set(id, secret) { const file = load(); file.entries[id] = seal(keyFor(file.salt), id, secret); store(file) },
    async remove(id) { const file = load(); if (!(id in file.entries)) return; delete file.entries[id]; store(file) },
  }
}

export function createKeychainVault(folder) {
  const service = 'PersonalInvestmentDashboard.' + createHash('sha256').update(folder).digest('hex').slice(0, 16)
  return {
    async get(id) { try { const raw = await new AsyncEntry(service, id).getPassword(); return raw ? JSON.parse(raw) : {} } catch { throw new ConnectionError('无法读取系统钥匙串，请解锁这台Mac后重试。', 503) } },
    async set(id, secret) { try { await new AsyncEntry(service, id).setPassword(JSON.stringify(secret)) } catch { throw new ConnectionError('系统钥匙串保存失败，未把密钥写入普通文件。', 503) } },
    async remove(id) { try { await new AsyncEntry(service, id).deletePassword() } catch { throw new ConnectionError('系统钥匙串删除失败，接入记录尚未移除。', 503) } },
  }
}

// INVESTMENT_VAULT=file 或 keychain 可强制指定；默认 Linux 用加密文件，其余系统用钥匙串。
export function createVault(folder) {
  const mode = process.env.INVESTMENT_VAULT ?? (process.platform === 'linux' ? 'file' : 'keychain')
  return mode === 'file' ? createFileVault(folder) : createKeychainVault(folder)
}

// 密钥加密文件检查：只用临时目录和假密钥。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileVault } from '../server/secret-vault.mjs'

const folder = mkdtempSync(join(tmpdir(), 'vault-'))
const master = 'test-master-key-0123456789-abcdef'
try {
  const vault = createFileVault(folder, { masterKey: master })
  assert.deepEqual(await vault.get('a'), {}, '没有保存过的账户返回空')
  await vault.set('a', { apiKey: 'KEY-AAAAAAAA', apiSecret: 'SECRET-AAAAAAAA' })
  await vault.set('b', { apiKey: 'KEY-BBBBBBBB', apiSecret: 'SECRET-BBBBBBBB', passphrase: 'PASS' })
  const file = join(folder, 'secrets.enc.json'), raw = readFileSync(file, 'utf8')
  assert.ok(!raw.includes('KEY-AAAAAAAA') && !raw.includes('SECRET-BBBBBBBB') && !raw.includes('PASS'), '文件里不能出现明文')
  assert.equal(statSync(file).mode & 0o777, 0o600, '文件权限只允许本人读写')
  assert.deepEqual(await createFileVault(folder, { masterKey: master }).get('b'), { apiKey: 'KEY-BBBBBBBB', apiSecret: 'SECRET-BBBBBBBB', passphrase: 'PASS' }, '重启后仍可读取')
  await assert.rejects(createFileVault(folder, { masterKey: 'wrong-master-key-0123456789-zzzz' }).get('a'), /解密失败/, '口令不对不能读取')
  await assert.rejects(createFileVault(folder, { masterKey: undefined }).get('a'), /INVESTMENT_MASTER_KEY/, '没设置口令要明确报错')
  await assert.rejects(createFileVault(folder, { masterKey: 'short' }).set('c', {}), /INVESTMENT_MASTER_KEY/, '口令太短拒绝使用')
  const value = JSON.parse(raw)
  value.entries.b = value.entries.a
  writeFileSync(file, JSON.stringify(value))
  await assert.rejects(createFileVault(folder, { masterKey: master }).get('b'), /解密失败/, '把 A 的密文搬到 B 名下解不开')
  value.entries.a.data = Buffer.from('篡改').toString('base64')
  writeFileSync(file, JSON.stringify(value))
  await assert.rejects(createFileVault(folder, { masterKey: master }).get('a'), /解密失败/, '密文被改动要发现')
  writeFileSync(file, '{broken')
  await assert.rejects(vault.set('d', {}), /无法读取/, '密钥文件损坏时拒绝覆盖')
  assert.equal(readFileSync(file, 'utf8'), '{broken', '损坏的原文件保持不变')
  writeFileSync(file, JSON.stringify({ version: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', entries: {} }))
  await vault.set('e', { apiKey: 'K' }); await vault.remove('e'); await vault.remove('e')
  assert.deepEqual(await vault.get('e'), {}, '删除后读取为空，重复删除不报错')
  console.log('密钥加密文件检查通过：AES-256-GCM、重启读取、口令错误与缺失、密文搬移与篡改、损坏保护、文件权限。')
} finally { rmSync(folder, { recursive: true, force: true }) }

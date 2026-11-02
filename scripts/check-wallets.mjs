// 仅在用户另行同意模拟测试后运行；假数据、临时目录，不联网、不访问钥匙串和真实账户。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walletAddress } from '../server/wallet-addresses.mjs'
import { encodeBalanceBatch, decodeBalanceBatch, readEvmTokens, tokenCatalog } from '../server/wallet-evm.mjs'
import { parseLlamaPrices, walletCoinKey } from '../server/wallet-prices.mjs'
import { parseBitcoinBalance, parseSolanaTokens } from '../server/wallet-reader.mjs'
import { createConnectionService } from '../server/connection-service.mjs'
import { assertWorkspacePortfolio } from '../src/data/portfolio.ts'
import { validateWorkspace } from '../src/data/workspace-schema.ts'
import { networks } from '../src/data/live-types.ts'
import { dedupeNativeHoldings, isNativeAlias } from '../src/data/asset-identity.ts'
const owner = '0x1234567890123456789012345678901234567890'
const word = value => BigInt(value).toString(16).padStart(64, '0')
const stamp = '2026-10-20T08:00:00Z'
function encodedResults(values) {
  const tuples = values.map(value => value === null ? word(0) + word(64) + word(0) : word(1) + word(64) + word(32) + word(value))
  let offset = values.length * 32
  const offsets = tuples.map(tuple => { const result = word(offset); offset += tuple.length / 2; return result })
  return '0x' + word(32) + word(values.length) + offsets.join('') + tuples.join('')
}
assert.equal(walletAddress(owner.toUpperCase().replace('0X', '0x')), owner)
assert.throws(() => walletAddress('0x' + '0'.repeat(40)))
assert.equal(walletAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'btc'), '1BoatSLRHtKNngkdXEeobR76b53LETtpyT')
assert.throws(() => walletAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyU', 'btc'))
assert.throws(() => walletAddress('xpub123', 'btc'))
const sol = 'So11111111111111111111111111111111111111112'
assert.equal(walletAddress(sol, 'solana'), sol)
assert.throws(() => walletAddress(sol + '0', 'solana'))
const tokens = [{ address: owner }]
const encoded = encodeBalanceBatch(owner, tokens)
assert.equal(encoded.slice(0, 10), '0x82ad56cb')
assert.equal(encoded.length, 10 + 2 * (32 + 32 + 32 + 192))
assert.equal(encoded.slice(202, 266), owner.slice(2).padStart(64, '0'))
assert.deepEqual(decodeBalanceBatch(encodedResults([10n, null, 0n, 2n ** 100n]), 4), [10n, null, 0n, 2n ** 100n])
assert.throws(() => decodeBalanceBatch(encodedResults([1n]), 2))
assert.throws(() => decodeBalanceBatch('0x' + word(32) + word(1) + word(0), 1))
const now = Date.now(), key = 'bsc:' + owner
const quotes = parseLlamaPrices({ coins: { [key]: { price: 2, timestamp: now / 1000, confidence: .99 } } }, [key], now)
assert.equal(quotes.get(key).price, '2')
assert.equal(parseLlamaPrices({ coins: { [key]: { price: 2, timestamp: now / 1000 - 7200 } } }, [key], now).size, 0)
assert.equal(parseLlamaPrices({ coins: { [key]: { price: 2, timestamp: now / 1000, confidence: .1 } } }, [key], now).size, 0)
assert.equal(walletCoinKey({ chainId: 56, address: owner }), key)
assert.equal(walletCoinKey({ chainId: 'solana', address: sol }), 'solana:' + sol)
const btc = { address: 'example', chain_stats: { funded_txo_sum: 250000000, spent_txo_sum: 100000000 }, mempool_stats: { funded_txo_sum: 10000000, spent_txo_sum: 0 } }
assert.deepEqual(parseBitcoinBalance(btc, 'example'), { quantity: '1.6', pending: true })
assert.throws(() => parseBitcoinBalance(btc, 'other'))
assert.throws(() => parseBitcoinBalance({ ...btc, chain_stats: { funded_txo_sum: -1, spent_txo_sum: 0 } }, 'example'))
const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const solAccount = (pubkey, amount) => ({ pubkey, account: { owner: program, data: { parsed: { info: { owner: sol, mint: sol, tokenAmount: { amount, decimals: 9 } } } } } })
assert.equal(parseSolanaTokens({ value: [solAccount('one', '1000000000'), solAccount('two', '2000000000')] }, sol, program)[0].quantity, '3')
assert.throws(() => parseSolanaTokens({ value: [solAccount('one', '1'), solAccount('one', '1')] }, sol, program))
assert.throws(() => parseSolanaTokens({ value: [solAccount('one', '1')] }, 'different', program))
for (const network of networks) assert.ok(tokenCatalog.evm[network.chainId].length > 0)
const network = networks.find(item => item.id === 'zksync')
let scanned = 0
const fakeRpc = async (_url, options) => {
  const body = JSON.parse(options.body)
  let result
  if (body.method === 'eth_chainId') result = '0x144'
  else if (body.method === 'eth_getBalance') result = '0x0'
  else {
    assert.equal(body.params[0].to, '0xF9cda624FBC7e059355ce98a31693d299FACd963')
    const count = Number(BigInt('0x' + body.params[0].data.slice(74, 138)))
    result = encodedResults(Array.from({ length: count }, () => scanned++ === 0 ? 1000000n : 0n))
  }
  return { jsonrpc: '2.0', id: 1, result }
}
assert.equal((await readEvmTokens({ address: owner }, network, fakeRpc)).coins.length, 1)
// POL 主币和 0x1010 是同一份余额；只剔除同一账户的重复位置。
const polygonAlias = '0x0000000000000000000000000000000000001010'
assert.equal(isNativeAlias(137, polygonAlias), true)
assert.equal(isNativeAlias(1, polygonAlias), false)
assert.equal(isNativeAlias(137, '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270'), false)
const polRows = [
  { id: 'evm:137:native', positions: [{ accountId: 'one', quantity: 2 }] },
  { id: 'evm:137:' + polygonAlias, positions: [{ accountId: 'one', quantity: 2 }, { accountId: 'two', quantity: 3 }] },
  { id: 'evm:1:' + polygonAlias, positions: [{ accountId: 'one', quantity: 2 }] },
]
const oldPolRows = JSON.stringify(polRows)
const cleanPolRows = dedupeNativeHoldings(polRows)
assert.equal(cleanPolRows.length, 3)
assert.deepEqual(cleanPolRows[1].positions, [{ accountId: 'two', quantity: 3 }])
assert.equal(JSON.stringify(polRows), oldPolRows)
assert.equal(dedupeNativeHoldings([polRows[0], { ...polRows[1], positions: [polRows[1].positions[0]] }]).length, 1)
assert.equal(dedupeNativeHoldings([polRows[1]]).length, 1)
const polygonNetwork = networks.find(item => item.id === 'polygon')
const polygonRead = await readEvmTokens({ address: owner, trackedTokens: [{ chain: 'polygon', address: polygonAlias }] }, polygonNetwork, async (_url, options) => {
  const body = JSON.parse(options.body)
  let result
  if (body.method === 'eth_chainId') result = '0x89'
  else if (body.method === 'eth_getBalance') result = '0xde0b6b3a7640000'
  else {
    const input = body.params[0].data.toLowerCase()
    assert.ok(!input.includes(polygonAlias.slice(2)), '目录与手动追踪均不能再次查询主币别名')
    const count = Number(BigInt('0x' + input.slice(74, 138)))
    result = encodedResults(Array(count).fill(0n))
  }
  return { jsonrpc: '2.0', id: 1, result }
})
assert.equal(polygonRead.coins.length, 1)
assert.equal(polygonRead.coins[0].address, null)
assert.equal(polygonRead.coins[0].quantity, '1')
const manual = { id: 'manual-account-12345678-1234-1234-1234-123456789012', name: '不动产', updatedAt: stamp }
const data = { manualAccounts: [manual], manualAssets: [{ id: 'manual-home', symbol: '房产', name: '房子', market: 'other', accountId: manual.id, quantity: 1, price: 1000000, currency: 'CNY', icon: '', updatedAt: stamp }], customizations: {}, snapshots: [], changes: [] }
assert.equal(validateWorkspace(data), true)
assert.doesNotThrow(() => assertWorkspacePortfolio(data, { accounts: [], holdings: [], contracts: [] }))
assert.throws(() => assertWorkspacePortfolio({ ...data, manualAccounts: [] }, { accounts: [], holdings: [], contracts: [] }))
assert.equal(validateWorkspace({ ...data, manualAccounts: [manual, { ...manual, id: manual.id.replace('12345678', '87654321') }] }), false)
const folder = mkdtempSync(join(tmpdir(), 'investment-wallet-check-'))
try {
  const service = createConnectionService(folder, { dailyPrices: async parts => parts, readers: { wallet: async connection => [{ account: { id: 'live-' + connection.id + '-btc', sourceId: 'live-' + connection.id, name: connection.name, kind: '钱包', status: 'ok', updatedAt: stamp, pnlCents: 0, warning: '' }, holdings: [], contracts: [] }] }, vault: { get: async () => { throw new Error('不应读取钥匙串') } } })
  const input = { type: 'wallet', name: 'BTC', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', walletFamily: 'btc', provider: 'rpc', chains: [] }
  const saved = await service.upsert(input)
  assert.equal(saved.connections[0].walletFamily, 'btc')
  await assert.rejects(() => service.upsert(input), /已经添加/)
  await assert.rejects(() => service.upsert({ ...input, walletFamily: 'solana' }), /Solana/)
} finally { rmSync(folder, { recursive: true, force: true }) }
console.log('免费钱包与手动账户隔离检查通过')
process.exit(0)

// 仅在用户另行同意模拟测试后运行。假地址、假响应和临时目录；不联网、不读钥匙串。
import assert from 'node:assert/strict'
import { makeWalletRecord, walletUnits } from '../server/wallet-transaction-common.mjs'
import { parseBitcoinTransaction, parseSolanaTransaction } from '../server/wallet-other-transactions.mjs'
import { parseEvmOperation } from '../server/wallet-evm-transactions.mjs'
import { validTransactionState, walletTransactionUrl } from '../src/data/transactions.ts'
import { mergeTransactions } from '../server/transaction-store.mjs'
import { readWalletTransactions } from '../server/wallet-transactions.mjs'
import { createConnectionService } from '../server/connection-service.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const connection = { id: '12345678-1234-1234-1234-123456789abc', name: '隔离钱包', type: 'wallet', address: '0x' + '1'.repeat(40), chains: ['eth'], walletFamily: 'evm' }
const network = { id: 'eth', name: 'Ethereum', chainId: 1, symbol: 'ETH' }
const now = Date.now() - 10000, hash = '0x' + 'a'.repeat(64)
const move = (token, asset, quantity) => ({ token, asset, quantity, counterparty: '测试地址' })
assert.equal(walletUnits('1', 18), '0.000000000000000001')
const grouped = makeWalletRecord(connection, network, { hash, time: now, fees: [], status: '已完成', moves: [move('native', 'ETH', '-1'), move('usdc', 'USDC', '2000')], swap: true })
assert.equal(grouped.type, '兑换')
assert.equal(grouped.movements.length, 2)
assert(validTransactionState({ records: [grouped], syncs: [] }))
assert(walletTransactionUrl(grouped).startsWith('https://eth.blockscout.com/tx/'))
assert.equal(makeWalletRecord(connection, network, { hash, time: now, fees: [], status: '已完成', moves: [], swap: false }), null, '授权不展示')
assert.equal(makeWalletRecord(connection, network, { hash, time: now, fees: [], status: '已完成', moves: [move('a', 'SAME', '-1'), move('b', 'SAME', '2')], swap: false }), null, '混合进出不自动猜兑换')
assert.throws(() => makeWalletRecord(connection, network, { hash, time: now, fees: [], status: '已完成', moves: [move('a', 'USDC', '2')], swap: true }), /只取得了一侧/, '兑换不能缺一侧后冒充收款')
assert.equal(mergeTransactions([grouped], [grouped]).length, 1)
const btcConnection = { ...connection, walletFamily: 'btc', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }
const btc = { txid: 'a'.repeat(64), fee: 1000, status: { confirmed: true, block_time: Math.floor(now / 1000) }, vin: [{ prevout: { scriptpubkey_address: btcConnection.address, value: 100000 } }], vout: [{ scriptpubkey_address: btcConnection.address, value: 20000 }, { scriptpubkey_address: '外部地址', value: 79000 }] }
const sent = parseBitcoinTransaction(btc, btcConnection, now, [])
assert.equal(sent.type, '转出')
assert.equal(sent.quantity, '0.00079', '同地址找零不算收入，发送数量排除已知手续费')
assert.equal(sent.fees[0].quantity, '0.00001')
const received = parseBitcoinTransaction({ ...btc, vin: [{ prevout: { scriptpubkey_address: '外部地址', value: 100000 } }], vout: [{ scriptpubkey_address: btcConnection.address, value: 99000 }] }, btcConnection, now, [])
assert.equal(received.type, '收到'); assert.equal(received.fees.length, 0, '收款方不重复记录发送方费用')
const pending = parseBitcoinTransaction({ ...btc, status: { confirmed: false } }, btcConnection, now, [])
assert.equal(pending.status, '处理中')
assert.equal(mergeTransactions([pending], [sent])[0].status, '已完成')
const evm = { hash, timestamp: new Date(now).toISOString(), from: { hash: connection.address }, to: { hash: '0x' + '2'.repeat(40) }, value: '1000000000000000000', fee: { type: 'actual', value: '1000000000000000' }, status: 'ok', raw_input: '0x' }
const native = parseEvmOperation(evm, [], [], connection, network)
assert.equal(native.quantity, '1'); assert.equal(native.type, '转出')
assert.equal(parseEvmOperation({ ...evm, value: '0', raw_input: '0x095ea7b3' }, [], [], connection, network), null)
const solOwner = 'So11111111111111111111111111111111111111112'
const solConnection = { ...connection, address: solOwner, walletFamily: 'solana' }
const sol = { blockTime: Math.floor(now / 1000), meta: { err: null, fee: 5000, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] }, transaction: { signatures: ['a'.repeat(88)], message: { accountKeys: [{ pubkey: solOwner, signer: true }], instructions: [{ program: 'system', parsed: { type: 'createAccount', info: { source: solOwner, lamports: 2000000 } } }] } } }
assert.equal(parseSolanaTransaction(sol, 'a'.repeat(88), solConnection), null, '租金和账户创建不当作转出')
const nativeInstruction = { program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: solOwner, destination: '11111111111111111111111111111111', lamports: 1000000000 } } }
const paid = parseSolanaTransaction({ ...sol, transaction: { ...sol.transaction, message: { ...sol.transaction.message, instructions: [nativeInstruction] } } }, 'a'.repeat(88), solConnection)
assert.equal(paid.quantity, '1'); assert.equal(paid.fees[0].quantity, '0.000005')
const reverted = parseSolanaTransaction({ ...sol, meta: { ...sol.meta, err: { InstructionError: [0, 'Custom'] } }, transaction: { ...sol.transaction, message: { ...sol.transaction.message, instructions: [nativeInstruction] } } }, 'a'.repeat(88), solConnection)
assert.equal(reverted.status, '失败'); assert.equal(reverted.movements.length, 0); assert.equal(reverted.fees[0].quantity, '0.000005')
const nftSol = { ...sol, meta: { ...sol.meta, preTokenBalances: [{ accountIndex: 1, owner: solOwner, mint: '3'.repeat(32), uiTokenAmount: { decimals: 0 } }], postTokenBalances: [] }, transaction: { ...sol.transaction, message: { accountKeys: [{ pubkey: solOwner }, { pubkey: '2'.repeat(32) }, { pubkey: '4'.repeat(32) }], instructions: [{ program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transfer', info: { source: '2'.repeat(32), destination: '4'.repeat(32), amount: '1' } } }] } } }
assert.throws(() => parseSolanaTransaction(nftSol, 'a'.repeat(88), solConnection), /不完整/, '未知零小数币种整笔拒绝，避免NFT和其支付混入')
const internal = { transaction_hash: hash, index: 0, type: 'call', success: true, from: evm.from, to: evm.to, value: evm.value }
assert.equal(parseEvmOperation(evm, [], [internal], connection, network).quantity, '1', '根调用不能重复算原生币转出')
const incomingInternal = { ...internal, from: { hash: '0x' + '2'.repeat(40) }, to: { hash: connection.address } }
assert.equal(parseEvmOperation({ ...evm, value: '0' }, [], [incomingInternal], connection, network).type, '收到', '第一条内部调用不是根调用时不能漏收款')
const token = (index, contract, source, destination, qty) => ({ transaction_hash: hash, log_index: index, from: { hash: source }, to: { hash: destination }, total: { value: qty, decimals: '6' }, token: { type: 'ERC-20', address_hash: contract, symbol: 'SAME' } })
const tokens = [token(0, '0x' + '3'.repeat(40), connection.address, '0x' + '2'.repeat(40), '1000000'), token(1, '0x' + '4'.repeat(40), '0x' + '2'.repeat(40), connection.address, '2000000')]
assert.equal(parseEvmOperation({ ...evm, value: '0' }, tokens, [], connection, network), null, '同名但不同地址的币不能抵消成普通收款')
const approvedSwap = parseEvmOperation({ ...evm, value: '0', to: { hash: '0xe592427a0aece92de3edee1f18e0157c05861564' }, raw_input: '0xc04b8d59' }, tokens, [], connection, network)
assert.equal(approvedSwap.type, '兑换'); assert.equal(approvedSwap.movements.length, 2)
let networkCalls = 0
const unavailable = await readWalletTransactions({ ...connection, chains: ['bsc'] }, { now, fetchJson: async () => { networkCalls++; throw new Error('不应访问未接入来源') } })
assert.equal(networkCalls, 0); assert.equal(unavailable.syncs[0].status, 'partial'); assert.equal(unavailable.records.length, 0)
const fakeSource = async (url, input) => {
  assert(!input?.headers?.['X-API-Key'] && !url.includes('apikey='), '免费来源不新增密钥')
  if (url.includes('/internal-transactions')) throw new Error('内部转账来源故意失败')
  return { items: [], next_page_params: null }
}
const oneChainFails = await readWalletTransactions({ ...connection, chains: ['base', 'bsc'] }, { now, fetchJson: fakeSource })
assert.deepEqual(oneChainFails.syncs.map(item => item.status), ['error', 'partial'])
assert(validTransactionState(oneChainFails))
const folder = mkdtempSync(join(tmpdir(), 'investment-wallet-records-'))
try {
  let vaultReads = 0
  const service = createConnectionService(folder, {
    vault: { get: async () => { vaultReads++; throw new Error('钱包记录不应读钥匙串') } }, dailyPrices: async parts => parts,
    readers: { wallet: async input => [{ account: { id: 'live-' + input.id + '-eth', sourceId: 'live-' + input.id, name: input.name, status: 'ok', updatedAt: new Date(now).toISOString(), warning: '', pnlCents: 0 }, holdings: [], contracts: [] }] },
    walletTransactionReader: async input => ({ records: [{ ...grouped, connectionId: input.id, connectionName: input.name }], syncs: [] }),
  })
  const added = await service.upsert({ type: 'wallet', name: '隔离钱包', address: connection.address, chains: ['eth'], walletFamily: 'evm', provider: 'rpc' })
  const saved = await service.syncTransactions(added.connections[0].id)
  assert.equal(vaultReads, 0)
  assert.equal(saved.records[0].type, '兑换')
  assert.deepEqual(service.list().snapshot, added.snapshot, '钱包流水不改余额或持仓')
} finally { rmSync(folder, { recursive: true, force: true }) }
console.log('钱包记录隔离检查通过（未连接真实钱包）')

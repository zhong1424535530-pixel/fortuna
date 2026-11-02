import { readFileSync } from 'node:fs'
import { ConnectionError, Decimal, requestJson } from './connection-http.mjs'
import { isNativeAlias } from '../src/data/asset-identity.ts'
export const tokenCatalog = JSON.parse(readFileSync(new URL('./data/wallet-tokens.json', import.meta.url), 'utf8'))
const word = value => BigInt(value).toString(16).padStart(64, '0')
export function encodeBalanceBatch(owner, tokens) {
  if (!/^0x[0-9a-f]{40}$/i.test(owner) || tokens.length > 200 || tokens.some(token => !/^0x[0-9a-f]{40}$/i.test(token.address))) throw new ConnectionError('代币查询参数无效。')
  const call = '70a08231' + owner.slice(2).toLowerCase().padStart(64, '0')
  return '0x82ad56cb' + word(32) + word(tokens.length) + tokens.map((_, index) => word(tokens.length * 32 + index * 192)).join('') + tokens.map(token => token.address.slice(2).toLowerCase().padStart(64, '0') + word(1) + word(96) + word(36) + call.padEnd(128, '0')).join('')
}
export function decodeBalanceBatch(value, count) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{64})+$/i.test(value) || value.length > 4_000_002 || count < 0 || count > 200) throw new ConnectionError('代币批量余额格式无效。', 502)
  const hex = value.slice(2)
  const read = offset => {
    if (!Number.isSafeInteger(offset) || offset % 32 || offset < 0 || (offset + 32) * 2 > hex.length) throw new ConnectionError('代币余额内容不完整。', 502)
    return BigInt('0x' + hex.slice(offset * 2, (offset + 32) * 2))
  }
  const array = Number(read(0))
  if (array !== 32 || read(array) !== BigInt(count)) throw new ConnectionError('代币返回数量不一致。', 502)
  return Array.from({ length: count }, (_, index) => {
    const relative = Number(read(array + 32 + index * 32))
    if (relative < count * 32) throw new ConnectionError('代币返回位置无效。', 502)
    const tuple = array + 32 + relative, success = read(tuple), offset = Number(read(tuple + 32))
    if (![0n, 1n].includes(success) || offset < 64) throw new ConnectionError('代币返回状态无效。', 502)
    const length = read(tuple + offset)
    if (success === 0n || length === 0n) return null
    if (length !== 32n) return null
    return read(tuple + offset + 32)
  })
}
export async function rpcQuery(url, method, params, fetchJson = requestJson) {
  const data = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  if (data?.jsonrpc !== '2.0' || data.id !== 1 || data.error || data.result === undefined) throw new ConnectionError('公共链上查询暂不可用，已保留上次余额。', 502)
  return data.result
}
const backupRpc = { 1: 'https://eth.drpc.org', 56: 'https://bsc.drpc.org', 10: 'https://optimism-rpc.publicnode.com', 137: 'https://polygon-bor-rpc.publicnode.com', 42161: 'https://arbitrum-one-rpc.publicnode.com', 8453: 'https://base-rpc.publicnode.com', 100: 'https://gnosis.drpc.org', 43114: 'https://api.avax.network/ext/bc/C/rpc', 324: 'https://zksync.drpc.org', 534352: 'https://scroll.drpc.org' }
export async function readEvmTokens(connection, network, fetchJson = requestJson) {
  const tokens = (tokenCatalog.evm[String(network.chainId)] ?? []).filter(([address]) => !isNativeAlias(network.chainId, address)).map(([address, decimals, symbol, name, coinId]) => ({ address, decimals, symbol, name, coinId, chainId: network.chainId }))
  for (const item of connection.trackedTokens ?? []) if (item.chain === network.id && !isNativeAlias(network.chainId, item.address) && !tokens.some(token => token.address.toLowerCase() === item.address.toLowerCase())) tokens.push({ address: item.address, decimals: null, symbol: '', name: '', coinId: null, chainId: network.chainId })
  let active = network.rpc
  try {
    if (BigInt(await rpcQuery(active, 'eth_chainId', [], fetchJson)) !== BigInt(network.chainId)) throw new Error()
  } catch {
    active = backupRpc[network.chainId]
    if (!active || BigInt(await rpcQuery(active, 'eth_chainId', [], fetchJson)) !== BigInt(network.chainId)) throw new ConnectionError('网络身份未通过核对，未替换余额。', 502)
  }
  const query = async (method, params) => {
    try { return await rpcQuery(active, method, params, fetchJson) }
    catch {
      const backup = backupRpc[network.chainId]
      if (!backup || backup === active) throw new ConnectionError('公共查询暂不可用，请稍后再刷新。', 502)
      if (BigInt(await rpcQuery(backup, 'eth_chainId', [], fetchJson)) !== BigInt(network.chainId)) throw new ConnectionError('备用网络身份不一致。', 502)
      active = backup
      return rpcQuery(active, method, params, fetchJson)
    }
  }
  const rawNative = await query('eth_getBalance', [connection.address, 'latest'])
  if (!/^0x[0-9a-f]+$/i.test(rawNative)) throw new ConnectionError('主币余额无法识别。', 502)
  const coins = [{ address: null, decimals: 18, symbol: network.symbol, name: network.symbol, coinId: network.coinId, chainId: network.chainId, quantity: new Decimal(BigInt(rawNative).toString()).div('1e18').toFixed() }]
  const multicall = network.chainId === 324 ? '0xF9cda624FBC7e059355ce98a31693d299FACd963' : '0xcA11bde05977b3631167028862bE2a173976CA11'
  const started = Date.now()
  const batch = async chunk => {
    if (Date.now() - started > 85000) throw new ConnectionError('本次目录扫描超时，已保留上次余额，请减少同时查询的网络。', 502)
    try {
      return decodeBalanceBatch(await query('eth_call', [{ to: multicall, data: encodeBalanceBatch(connection.address, chunk) }, 'latest']), chunk.length)
    } catch (error) {
      if (chunk.length <= 25) throw error
      const middle = Math.ceil(chunk.length / 2)
      return [...await batch(chunk.slice(0, middle)), ...await batch(chunk.slice(middle))]
    }
  }
  let failed = 0
  for (let start = 0; start < tokens.length; start += 200) {
    if (Date.now() - started > 85000) throw new ConnectionError('本次目录扫描超时，已保留上次余额，请减少同时查询的网络。', 502)
    const chunk = tokens.slice(start, start + 200)
    const balances = await batch(chunk)
    for (let i = 0; i < chunk.length; i++) {
      const token = chunk[i], amount = balances[i]
      if (amount === null) { if ((connection.trackedTokens ?? []).some(item => item.address.toLowerCase() === token.address.toLowerCase())) failed++; continue }
      if (amount === 0n) continue
      if (token.decimals === null) {
        const decimals = await query('eth_call', [{ to: token.address, data: '0x313ce567' }, 'latest'])
        if (!/^0x[0-9a-f]{64}$/i.test(decimals) || BigInt(decimals) > 36n) throw new ConnectionError('补充代币的数量精度无法确认。', 502)
        token.decimals = Number(BigInt(decimals)); token.symbol = token.address.slice(0, 8) + '…'; token.name = '自定义代币'
      }
      coins.push({ ...token, quantity: new Decimal(amount.toString()).div(new Decimal(10).pow(token.decimals)).toFixed() })
    }
  }
  return { coins: coins.filter(coin => new Decimal(coin.quantity).gt(0)), warning: `已扫描公开目录中的${tokens.length}项代币；目录外新币、NFT和质押借贷等仓位不在此范围。` + (failed ? `${failed}项补充代币未能读取。` : '') }
}

import { createHash } from 'node:crypto'
import { networks } from '../src/data/live-types.ts'
import { ConnectionError, requestJson } from './connection-http.mjs'
import { walletAddress } from './wallet-addresses.mjs'
import { readEvmTransactions } from './wallet-evm-transactions.mjs'
import { readBitcoinTransactions, readSolanaTransactions } from './wallet-other-transactions.mjs'

export async function readWalletTransactions(connection, options = {}) {
  const now = options.now ?? Date.now(), from = now - 7 * 86400000
  const family = connection.walletFamily ?? 'evm'
  const owner = walletAddress(connection.address, family)
  if (owner !== connection.address) throw new ConnectionError('钱包地址身份无法核对，请先修改已有接入。')
  const identity = createHash('sha256').update(family + ':' + owner).digest('hex')
  const selected = family === 'evm' ? connection.chains.map(id => networks.find(item => item.id === id)) : [{ id: family, name: family === 'btc' ? '比特币' : 'Solana' }]
  if (!selected.length || selected.some(item => !item)) throw new ConnectionError('钱包网络无法识别。')
  const records = [], syncs = [], deadline = Date.now() + 190000
  let calls = 0, stopped = false, nextRequestAt = 0
  const fetchJson = async (url, input = {}) => {
    if (stopped || ++calls > 160 || Date.now() > deadline) throw new ConnectionError('本次达到免费查询的请求或时间上限，未读全的范围可稍后再同步。', 502)
    if (input.method && input.method !== 'GET') {
      let body
      try { body = JSON.parse(input.body) } catch { throw new ConnectionError('钱包只允许读取查询。') }
      if (input.method !== 'POST' || !['getTokenAccountsByOwner', 'getSignaturesForAddress', 'getTransaction', 'eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(body.method)) throw new ConnectionError('钱包只允许读取查询。')
    }
    const delay = Math.max(0, nextRequestAt - Date.now())
    nextRequestAt = Math.max(nextRequestAt, Date.now()) + 500
    if (Date.now() + delay > deadline) throw new ConnectionError('免费查询已到本次时间上限，原记录保留，请稍后再同步。', 502)
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    try { return await (options.fetchJson ?? requestJson)(url, input) }
    catch (error) { if (/查询过于频繁/.test(error.message)) stopped = true; throw error }
  }
  for (const network of selected) {
    const key = 'wallet:' + network.id
    const item = { connectionId: connection.id, connectionName: connection.name, identity, key, label: network.name + ' 钱包记录', status: 'error', from, to: now, at: now, lastSuccess: null, warning: '' }
    try {
      const context = { now, from, fetchJson, previous: options.records ?? [] }
      const result = family === 'btc' ? await readBitcoinTransactions(connection, context) : family === 'solana' ? await readSolanaTransactions(connection, context) : await readEvmTransactions(connection, network, context)
      records.push(...result.records)
      item.status = result.complete ? 'ok' : 'partial'
      item.warning = result.warning || '仅覆盖该免费来源可确认的收到、转出和已支持兑换；授权、NFT和其他操作不展示。'
      if (result.complete) item.lastSuccess = now
    } catch (error) { item.warning = error instanceof ConnectionError ? error.message : '此网络免费记录暂时无法读取，已保留原记录。' }
    if (item.status !== 'ok') item.lastSuccess = (options.previous ?? []).find(prior => prior.identity === identity && prior.key === key)?.lastSuccess ?? null
    syncs.push(item)
  }
  return { records: [...new Map(records.map(row => [row.id, row])).values()], syncs }
}

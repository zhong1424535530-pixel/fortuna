import { makeWalletRecord, walletDataError, walletNumber, walletUnits } from './wallet-transaction-common.mjs'
import { rpcQuery } from './wallet-evm.mjs'

const blockscouts = { eth: 'https://eth.blockscout.com', arbitrum: 'https://arbitrum.blockscout.com', base: 'https://base.blockscout.com', optimism: 'https://optimism.blockscout.com', polygon: 'https://polygon.blockscout.com', gnosis: 'https://gnosis.blockscout.com', scroll: 'https://scroll.blockscout.com', zksync: 'https://zksync.blockscout.com' }
const address = value => { const hash = typeof value === 'string' ? value : value?.hash; if (!/^0x[0-9a-f]{40}$/i.test(hash ?? '')) throw walletDataError(); return hash.toLowerCase() }
const hashOf = value => { if (!/^0x[0-9a-f]{64}$/i.test(value ?? '')) throw walletDataError(); return value.toLowerCase() }
const at = value => { const time = Date.parse(value); if (!Number.isSafeInteger(time) || time < 1483228800000 || time > Date.now() + 300000) throw walletDataError(); return time }
const signedMove = (from, to, owner, quantity, token, asset) => {
  const source = address(from), target = address(to), qty = walletNumber(quantity)
  if (source === target || source !== owner && target !== owner || qty.isZero()) return null
  return { token, asset, quantity: (source === owner ? qty.negated() : qty).toFixed(), counterparty: source === owner ? target : source }
}
function confirmedSwap(tx, network) {
  // shortcut: 仅确认已核对的Ethereum Uniswap V2/V3路由；其他兑换协议需要核实官方地址后再补。
  if (network.id !== 'eth') return false
  const router = address(tx.to), selector = String(tx.raw_input ?? '').slice(0, 10).toLowerCase()
  const v2 = router === '0x7a250d5630b4cf539739df2c5dacab4c659f2488d'
  const v3 = router === '0xe592427a0aece92de3edee1f18e0157c05861564' || router === '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'
  return v2 && ['0x38ed1739', '0x8803dbee', '0x7ff36ab5', '0x18cbafe5', '0xfb3bdb41', '0x4a25d94a', '0x5c11d795', '0xb6f9de95', '0x791ac947'].includes(selector) || v3 && ['0xc04b8d59', '0x414bf389', '0xf28c0498', '0xdb3e2198', '0xb858183f', '0x04e45aaf', '0x09b81346', '0x5023b4df', '0xac9650d8', '0x5ae401dc'].includes(selector)
}
export function parseEvmOperation(tx, tokens, internals, connection, network) {
  const hash = hashOf(tx.hash), owner = connection.address, from = address(tx.from)
  if (!['ok', 'error'].includes(tx.status)) throw walletDataError()
  const failed = tx.status === 'error', value = walletUnits(tx.value, 18), outgoing = from === owner
  const fees = outgoing && tx.fee?.type === 'actual' ? [{ asset: network.symbol, quantity: walletUnits(tx.fee.value, 18) }] : []
  // L2额外费用缺失时不把执行费说成总手续费。
  if (outgoing && ['optimism', 'base', 'scroll', 'zksync'].includes(network.id)) {
    if (tx.l1_fee !== undefined && tx.l1_fee !== null) {
      if (fees.length) fees[0].quantity = walletNumber(fees[0].quantity).plus(walletUnits(tx.l1_fee, 18)).toFixed()
    } else fees.length = 0
  }
  const moves = []
  if (!failed && tx.to && walletNumber(value).gt(0)) { const move = signedMove(tx.from, tx.to, owner, value, 'native', network.symbol); if (move) moves.push(move) }
  const seen = new Set()
  for (const token of failed ? [] : tokens) {
    if (token.token?.type !== 'ERC-20' || token.token?.is_scam === true || token.token?.is_spam === true) continue
    if (hashOf(token.transaction_hash) !== hash) throw walletDataError()
    const id = 'token:' + token.log_index
    if (!Number.isSafeInteger(token.log_index) || token.log_index < 0) throw walletDataError()
    if (seen.has(id)) continue
    seen.add(id)
    const tokenId = address(token.token.address_hash ?? token.token.address)
    const decimalText = token.total?.decimals ?? token.token.decimals
    if (!/^\d{1,2}$/.test(String(decimalText))) throw walletDataError()
    const decimals = Number(decimalText)
    const asset = typeof token.token.symbol === 'string' && token.token.symbol.length <= 40 && !/[\x00-\x1f]/.test(token.token.symbol) && token.token.symbol ? token.token.symbol : tokenId.slice(0, 10)
    const move = signedMove(token.from, token.to, owner, walletUnits(token.total?.value, decimals), tokenId, asset)
    if (move) moves.push(move)
  }
  for (const item of failed ? [] : internals) {
    if (hashOf(item.transaction_hash) !== hash) throw walletDataError()
    // 根调用与外部转账重复；revert的内部调用没有实际资产转移。
    if (item.success !== true || item.type === 'delegatecall' || item.type === 'staticcall') continue
    const id = 'internal:' + item.index
    if (!/^(?:0|[1-9]\d*)(?:_\d+)*$/.test(String(item.index))) throw walletDataError()
    if (seen.has(id)) continue
    seen.add(id)
    if (!item.to) continue
    if (String(item.index) === '0' && tx.to && address(item.from) === from && address(item.to) === address(tx.to) && walletNumber(walletUnits(item.value, 18)).eq(value)) continue
    const move = signedMove(item.from, item.to, owner, walletUnits(item.value, 18), 'native', network.symbol)
    if (move) moves.push(move)
  }
  const swap = tx.to ? confirmedSwap(tx, network) : false
  const failedType = failed && outgoing ? swap ? '兑换' : walletNumber(value).gt(0) && (tx.raw_input === '0x' || tx.raw_input === '0x0') ? '转出' : undefined : undefined
  return makeWalletRecord(connection, network, { hash, time: at(tx.timestamp), status: failed ? '失败' : '已完成', moves, fees, swap, failedType,
    note: [failed ? '交易失败，没有记录为实际资产进出；仅保留来源明确提供的实际费用。' : '', outgoing && !fees.length ? '总手续费未能确认，未当作零；请查看链上原记录。' : '', '仅展示可确认的资产转移与已支持协议的兑换，不展示授权、NFT和其他操作。'].filter(Boolean).join(' ') })
}

async function readBlockscout(base, connection, network, context) {
  const groups = new Map(), warnings = []
  let floor = context.from, complete = true
  for (const kind of ['transactions', 'token-transfers', 'internal-transactions']) {
    let cursor = {}, finished = false
    const seenCursors = new Set()
    for (let page = 0; page < 6; page++) {
      const params = new URLSearchParams({ ...cursor, ...(kind === 'token-transfers' ? { type: 'ERC-20' } : {}) })
      const data = await context.fetchJson(`${base}/api/v2/addresses/${connection.address}/${kind}?${params}`)
      if (!Array.isArray(data?.items) || data.items.length > 100) throw walletDataError()
      let oldest = Infinity
      for (const item of data.items) {
        if (item.timestamp === null && kind === 'transactions') { complete = false; continue }
        const time = at(item.timestamp)
        oldest = Math.min(oldest, time)
        if (time < context.from || time > context.now) continue
        const hash = hashOf(kind === 'transactions' ? item.hash : item.transaction_hash)
        if (!groups.has(hash)) groups.set(hash, { time, tx: null, tokens: [], internals: [] })
        const group = groups.get(hash)
        if (kind === 'transactions') group.tx = item
        else group[kind === 'token-transfers' ? 'tokens' : 'internals'].push(item)
      }
      if (data.next_page_params === null || oldest < context.from || !data.items.length && !data.next_page_params) { finished = true; break }
      const next = data.next_page_params
      if (!next || typeof next !== 'object' || Array.isArray(next) || Object.entries(next).some(([key, value]) => !/^[a-z_]{1,50}$/.test(key) || !['string', 'number'].includes(typeof value) || String(value).length > 160)) throw walletDataError()
      const signature = JSON.stringify(next)
      if (seenCursors.has(signature)) throw walletDataError()
      seenCursors.add(signature); cursor = next
      if (page === 5) floor = Math.max(floor, oldest + 1)
    }
    if (!finished) { complete = false; warnings.push('部分流水达到免费来源的分批查询上限；只保留已经完整归组的较新操作。') }
  }
  const records = []
  for (const [hash, group] of groups) {
    if (group.time < floor) continue
    try {
      const tx = group.tx ?? await context.fetchJson(`${base}/api/v2/transactions/${hash}`)
      if (hashOf(tx.hash) !== hash) throw walletDataError()
      const row = parseEvmOperation(tx, group.tokens, group.internals, connection, network)
      if (row) records.push(row)
    } catch { complete = false; warnings.push('部分交易详情未取得，未用不完整的新记录覆盖原记录。') }
  }
  return { records, complete, warning: [...new Set(warnings)].join(' ') }
}

async function readRoutescan(connection, network, context) {
  const base = `https://api.routescan.io/v2/network/mainnet/evm/${network.chainId}/etherscan/api`
  const groups = new Map()
  for (const action of ['txlist', 'tokentx', 'txlistinternal']) {
    let finished = false
    for (let page = 1; page <= 6; page++) {
      const data = await context.fetchJson(base + '?' + new URLSearchParams({ module: 'account', action, address: connection.address, sort: 'desc', page: String(page), offset: '100' }))
      if (!Array.isArray(data?.result) || !['0', '1'].includes(String(data.status)) || String(data.status) === '0' && !/no transactions found/i.test(data.message ?? '')) throw walletDataError()
      let oldest = Infinity
      for (const item of data.result) {
        const time = Number(item.timeStamp) * 1000, hash = hashOf(item.hash)
        if (!Number.isSafeInteger(time) || time < 1483228800000) throw walletDataError()
        oldest = Math.min(oldest, time)
        if (time < context.from || time > context.now) continue
        if (!groups.has(hash)) groups.set(hash, { time, tx: null, tokens: [], internals: [], tokenMetadata: new Map(), needsReceipt: false })
        const group = groups.get(hash)
        if (action === 'txlist') group.tx = { hash, timestamp: new Date(time).toISOString(), from: item.from, to: item.to || null, value: item.value, status: item.isError === '0' ? 'ok' : item.isError === '1' ? 'error' : '', raw_input: item.input, fee: { type: 'actual', value: walletNumber(item.gasUsed).mul(walletNumber(item.gasPrice)).toFixed() } }
        if (action === 'tokentx') {
          const metadata = { type: 'ERC-20', address_hash: address(item.contractAddress), symbol: item.tokenSymbol, decimals: item.tokenDecimal }
          group.tokenMetadata.set(metadata.address_hash, metadata)
          if (item.logIndex === undefined) group.needsReceipt = true
          else group.tokens.push({ transaction_hash: hash, log_index: Number(item.logIndex), from: item.from, to: item.to, total: { value: item.value, decimals: item.tokenDecimal }, token: metadata })
        }
        if (action === 'txlistinternal') group.internals.push({ transaction_hash: hash, index: item.traceId, type: item.type, success: item.isError === '0', from: item.from, to: item.to, value: item.value })
      }
      if (oldest < context.from || data.result.length < 100) { finished = true; break }
    }
    if (!finished) throw walletDataError()
  }
  const records = [], missing = []
  let checkedChain = false
  const hexInteger = value => { if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) throw walletDataError(); return BigInt(value).toString() }
  for (const [hash, group] of groups) {
    try {
      if (!group.tx || group.needsReceipt) {
        if (!checkedChain) { if (BigInt(await rpcQuery(network.rpc, 'eth_chainId', [], context.fetchJson)) !== BigInt(network.chainId)) throw walletDataError(); checkedChain = true }
        const receipt = await rpcQuery(network.rpc, 'eth_getTransactionReceipt', [hash], context.fetchJson)
        if (!receipt || hashOf(receipt.transactionHash) !== hash || !['0x0', '0x1'].includes(receipt.status) || !Array.isArray(receipt.logs)) throw walletDataError()
        if (!group.tx) {
          const tx = await rpcQuery(network.rpc, 'eth_getTransactionByHash', [hash], context.fetchJson)
          if (!tx || hashOf(tx.hash) !== hash) throw walletDataError()
          group.tx = { hash, timestamp: new Date(group.time).toISOString(), from: tx.from, to: tx.to, value: hexInteger(tx.value), raw_input: tx.input, status: receipt.status === '0x1' ? 'ok' : 'error', fee: { type: 'actual', value: walletNumber(hexInteger(receipt.gasUsed)).mul(walletNumber(hexInteger(receipt.effectiveGasPrice ?? tx.gasPrice))).toFixed() } }
        }
        if (group.needsReceipt) {
          group.tokens = []
          for (const log of receipt.logs) {
            if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' || log.topics.length !== 3) continue
            if (log.topics.slice(1).some(topic => !/^0x0{24}[0-9a-f]{40}$/i.test(topic))) throw walletDataError()
            const source = address('0x' + log.topics[1].slice(-40)), target = address('0x' + log.topics[2].slice(-40))
            if (source !== connection.address && target !== connection.address) continue
            const metadata = group.tokenMetadata.get(address(log.address))
            if (!metadata) throw walletDataError()
            group.tokens.push({ transaction_hash: hash, log_index: Number(BigInt(log.logIndex)), from: source, to: target, total: { value: hexInteger(log.data), decimals: metadata.decimals }, token: metadata })
          }
        }
      }
      const row = parseEvmOperation(group.tx, group.tokens, group.internals, connection, network)
      if (row) records.push(row)
    } catch { missing.push('部分交易详情或日志未完整取得，未保存不完整操作。') }
  }
  return { records, complete: !missing.length, warning: [...new Set(missing)].join(' ') }
}
export async function readEvmTransactions(connection, network, context) {
  const base = blockscouts[network.id]
  if (base) {
    try { return await readBlockscout(base, connection, network, context) }
    catch (error) { if (network.id !== 'eth') throw error }
  }
  if (['eth', 'avalanche'].includes(network.id)) return readRoutescan(connection, network, context)
  return { records: [], complete: false, warning: '此网络尚无本轮已接入的免密钥流水来源；余额仍按原方式读取，未自动添加付费服务。' }
}

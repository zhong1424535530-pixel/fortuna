import { tokenCatalog, rpcQuery } from './wallet-evm.mjs'
import { makeWalletRecord, walletDataError, walletNumber, walletUnits } from './wallet-transaction-common.mjs'

const btcNetwork = { id: 'btc', name: '比特币', symbol: 'BTC' }
const solNetwork = { id: 'solana', name: 'Solana', symbol: 'SOL' }
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const solAddress = value => { if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw walletDataError(); return value }
const satoshis = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 2100000000000000) throw walletDataError(); return walletNumber(String(value)) }
export function parseBitcoinTransaction(tx, connection, now, previous) {
  if (!/^[0-9a-f]{64}$/i.test(tx?.txid ?? '') || !Array.isArray(tx.vin) || !tx.vin.length || !Array.isArray(tx.vout) || !tx.vout.length || typeof tx.status?.confirmed !== 'boolean') throw walletDataError()
  const owner = connection.address
  let input = walletNumber('0'), output = walletNumber('0')
  const payers = new Set()
  for (const item of tx.vin) {
    if (item.is_coinbase === true) continue
    if (!item.prevout) throw walletDataError()
    const quantity = satoshis(item.prevout.value)
    payers.add(item.prevout.scriptpubkey_address ?? '未知付款地址')
    if (item.prevout.scriptpubkey_address === owner) input = input.plus(quantity)
  }
  for (const item of tx.vout) { const quantity = satoshis(item.value); if (item.scriptpubkey_address === owner) output = output.plus(quantity) }
  const delta = output.minus(input)
  if (delta.isZero()) return null
  const outgoing = delta.isNegative(), feeKnown = outgoing && payers.size === 1 && payers.has(owner)
  const fee = feeKnown ? satoshis(tx.fee) : walletNumber('0')
  const quantity = outgoing ? delta.abs().minus(fee) : delta
  if (quantity.isNegative()) throw walletDataError()
  const known = previous.find(row => row.walletOwner === owner && row.scope === 'wallet:btc' && row.txHash === tx.txid)
  const time = tx.status.confirmed ? tx.status.block_time * 1000 : known?.time ?? now
  if (!Number.isSafeInteger(time) || time < 1483228800000 || time > now + 300000) throw walletDataError()
  const parties = outgoing ? tx.vout.filter(item => item.scriptpubkey_address !== owner).map(item => item.scriptpubkey_address).filter(Boolean) : tx.vin.map(item => item.prevout?.scriptpubkey_address).filter(Boolean)
  return makeWalletRecord(connection, btcNetwork, { hash: tx.txid.toLowerCase(), time, status: tx.status.confirmed ? '已完成' : '处理中', swap: false,
    moves: quantity.isZero() ? [] : [{ token: 'native', asset: 'BTC', quantity: (outgoing ? quantity.negated() : quantity).div('1e8').toFixed(), counterparty: parties.length === 1 ? parties[0] : '多个地址' }],
    fees: feeKnown ? [{ asset: 'BTC', quantity: fee.div('1e8').toFixed() }] : [], failedType: outgoing && quantity.isZero() ? '转出' : undefined,
    note: ['仅统计这个公开地址的净进出，返回同地址的找零已扣除；其他找零地址需分别添加，不据此计算投资收益。', outgoing && !feeKnown ? '本笔有多个付款地址，无法准确分摊手续费；数量为该地址净流出，费用未冒充零。' : '', !tx.status.confirmed ? '时间为本机首次发现时间，尚未获得区块确认。' : ''].filter(Boolean).join(' ') })
}
export async function readBitcoinTransactions(connection, context) {
  let lastError
  for (const base of ['https://mempool.space/api', 'https://blockstream.info/api']) {
    try {
      const pending = await context.fetchJson(`${base}/address/${connection.address}/txs/mempool`)
      if (!Array.isArray(pending) || pending.length > 50 || pending.some(tx => tx.status?.confirmed !== false)) throw walletDataError()
      const records = [], seen = new Set()
      let complete = pending.length < 50, cursor = '', reached = false
      for (const tx of pending) { const row = parseBitcoinTransaction(tx, connection, context.now, context.previous); if (row) records.push(row) }
      for (let page = 0; page < 8; page++) {
        const result = await context.fetchJson(`${base}/address/${connection.address}/txs/chain${cursor ? '/' + cursor : ''}`)
        if (!Array.isArray(result) || result.length > 25) throw walletDataError()
        let oldest = Infinity
        for (const tx of result) {
          if (!tx.status?.confirmed || seen.has(tx.txid)) throw walletDataError()
          seen.add(tx.txid)
          const row = parseBitcoinTransaction(tx, connection, context.now, context.previous)
          const time = tx.status.block_time * 1000
          if (!Number.isSafeInteger(time)) throw walletDataError()
          oldest = Math.min(oldest, time)
          if (row && time >= context.from && time <= context.now) records.push(row)
        }
        if (result.length < 25 || oldest < context.from) { reached = true; break }
        const next = result.at(-1).txid
        if (!/^[0-9a-f]{64}$/i.test(next) || next === cursor) throw walletDataError()
        cursor = next
      }
      complete &&= reached
      return { records, complete, warning: [!reached ? '近期交易达到分批查询上限，较早记录未读全。' : '', pending.length === 50 ? '未确认记录达到免费来源单页上限，未确认部分可能不全。' : '', '只覆盖添加的这个地址；其他收款和找零地址不包含在内。'].filter(Boolean).join(' ') }
    } catch (error) { lastError = error }
  }
  throw lastError
}

export function parseSolanaTransaction(data, signature, connection) {
  const meta = data?.meta, transaction = data?.transaction, message = transaction?.message
  if (!meta || !message || !Array.isArray(transaction.signatures) || transaction.signatures[0] !== signature || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions) || !Number.isSafeInteger(data.blockTime) || data.blockTime < 1483228800 || data.blockTime * 1000 > Date.now() + 300000 || !Number.isSafeInteger(meta.fee) || meta.fee < 0 || !(meta.err === null || meta.err && typeof meta.err === 'object' && !Array.isArray(meta.err))) throw walletDataError()
  const keys = message.accountKeys.map(item => solAddress(typeof item === 'string' ? item : item.pubkey)), owner = connection.address
  const accounts = new Map()
  for (const item of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    if (!Number.isSafeInteger(item.accountIndex) || !keys[item.accountIndex] || !Number.isInteger(item.uiTokenAmount?.decimals)) throw walletDataError()
    const info = { mint: solAddress(item.mint), owner: item.owner ? solAddress(item.owner) : '', decimals: item.uiTokenAmount.decimals }
    const prior = accounts.get(keys[item.accountIndex])
    if (prior && (prior.mint !== info.mint || prior.decimals !== info.decimals || prior.owner && info.owner && prior.owner !== info.owner)) throw walletDataError()
    accounts.set(keys[item.accountIndex], { ...info, owner: info.owner || prior?.owner || '' })
  }
  const instructions = [...message.instructions, ...(meta.innerInstructions ?? []).flatMap(item => { if (!Array.isArray(item.instructions)) throw walletDataError(); return item.instructions })]
  const swap = instructions.some(item => item.programId === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
  const moves = []
  let attemptedTransfer = false
  for (const item of instructions) {
    const type = item.parsed?.type, info = item.parsed?.info
    if (!info || !['transfer', 'transferWithSeed', 'transferChecked'].includes(type)) continue
    if (item.program === 'system' && (item.programId === undefined || item.programId === '11111111111111111111111111111111')) {
      const source = solAddress(info.source), destination = solAddress(info.destination)
      if (source !== owner && destination !== owner || source === destination) continue
      // 向自己代币账户充入SOL属于包装或账户资金，不重复列作对外转账。
      if (source === owner && accounts.get(destination)?.owner === owner) continue
      attemptedTransfer ||= source === owner
      const qty = walletUnits(info.lamports, 9)
      if (meta.err === null) moves.push({ token: 'native', asset: 'SOL', quantity: source === owner ? walletNumber(qty).negated().toFixed() : qty, counterparty: source === owner ? destination : source })
    } else if (item.programId === tokenProgram && item.program === 'spl-token') {
      const source = solAddress(info.source), destination = solAddress(info.destination), src = accounts.get(source), dest = accounts.get(destination)
      if (src?.owner !== owner && dest?.owner !== owner || src?.owner === owner && dest?.owner === owner) continue
      const details = src?.owner === owner ? src : dest
      if (!details?.mint || info.mint && info.mint !== details.mint || src && dest && src.mint !== dest.mint) throw walletDataError()
      const qty = walletUnits(type === 'transferChecked' ? info.tokenAmount?.amount : info.amount, details.decimals)
      const token = tokenCatalog.solana.find(row => row[0] === details.mint)
      if (details.decimals === 0 && !token) throw walletDataError()
      const asset = token?.[1] && token[1].length <= 40 ? token[1] : details.mint.slice(0, 8)
      attemptedTransfer ||= src?.owner === owner
      if (meta.err === null) moves.push({ token: details.mint, asset, quantity: src?.owner === owner ? walletNumber(qty).negated().toFixed() : qty, counterparty: src?.owner === owner ? dest?.owner || destination : src?.owner || source })
    }
  }
  const paysFee = keys[0] === owner
  return makeWalletRecord(connection, solNetwork, { hash: signature, time: data.blockTime * 1000, status: meta.err === null ? '已完成' : '失败', moves, swap,
    fees: paysFee ? [{ asset: 'SOL', quantity: walletUnits(meta.fee, 9) }] : [], failedType: meta.err !== null && paysFee ? swap ? '兑换' : attemptedTransfer ? '转出' : undefined : undefined,
    note: '按明确的普通转账指令归组；账户租金、关闭账户返还、授权和NFT不列作收付。手续费仅由本地址实际付款时列出。Token-2022、未知零小数币种和未解析动作未纳入；兑换仅确认已支持的Jupiter程序。' })
}
export async function readSolanaTransactions(connection, context) {
  let active = 'https://api.mainnet-beta.solana.com'
  const query = async (method, params) => {
    try { return await rpcQuery(active, method, params, context.fetchJson) }
    catch { if (active === 'https://solana-rpc.publicnode.com') throw walletDataError(); active = 'https://solana-rpc.publicnode.com'; return rpcQuery(active, method, params, context.fetchJson) }
  }
  const tokenAccounts = await query('getTokenAccountsByOwner', [connection.address, { programId: tokenProgram }, { encoding: 'jsonParsed', commitment: 'finalized' }])
  if (!Array.isArray(tokenAccounts?.value)) throw walletDataError()
  const owned = tokenAccounts.value.map(item => {
    if (item.account?.owner !== tokenProgram || item.account?.data?.parsed?.info?.owner !== connection.address) throw walletDataError()
    return solAddress(item.pubkey)
  })
  const signatures = new Set(), records = [], warnings = []
  const targets = [connection.address, ...owned.slice(0, 20)]
  for (const target of targets) {
    let before
    for (let page = 0; page < 3; page++) {
      const result = await query('getSignaturesForAddress', [target, { limit: 100, commitment: 'finalized', ...(before ? { before } : {}) }])
      if (!Array.isArray(result) || result.length > 100) throw walletDataError()
      let oldest = Infinity
      for (const item of result) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(item.signature ?? '')) throw walletDataError()
        if (item.blockTime === null) warnings.push('部分交易时间缺失，未当作完整历史。')
        else { if (!Number.isSafeInteger(item.blockTime)) throw walletDataError(); oldest = Math.min(oldest, item.blockTime * 1000) }
        if (item.blockTime === null || item.blockTime * 1000 >= context.from) signatures.add(item.signature)
      }
      if (result.length < 100 || oldest < context.from) break
      const next = result.at(-1)?.signature
      if (next === before) throw walletDataError()
      before = next
      if (page === 2) warnings.push('部分地址达到分批查询上限，历史未读全。')
    }
  }
  for (const signature of signatures) {
    try {
      const data = await query('getTransaction', [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }])
      const row = parseSolanaTransaction(data, signature, connection)
      if (row && row.time >= context.from && row.time <= context.now) records.push(row)
    } catch { warnings.push('部分交易详情或指令无法确认，已保留旧记录，未猜测收付和兑换。') }
  }
  return { records, complete: false, warning: ['免费读取只覆盖钱包地址和最多20个当前普通代币账户；已关闭账户、其他代币账户、Token-2022和复杂动作可能缺失。', ...new Set(warnings)].join(' ') }
}

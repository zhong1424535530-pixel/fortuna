import { networks } from '../src/data/live-types.ts'
import { ConnectionError, decimal, Decimal, holding, icons, requestJson, remoteIcon, validChange24h } from './connection-http.mjs'
import { walletAddress } from './wallet-addresses.mjs'
import { readEvmTokens, rpcQuery, tokenCatalog } from './wallet-evm.mjs'
import { walletPrices, walletCoinKey } from './wallet-prices.mjs'
const programs = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
export function parseBitcoinBalance(data, address) {
  if (data?.address !== address) throw new ConnectionError('比特币地址返回不一致。', 502)
  const sum = stats => {
    if (!stats || !['funded_txo_sum', 'spent_txo_sum'].every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0 && stats[key] <= 2100000000000000)) throw new ConnectionError('比特币余额格式无法识别。', 502)
    return BigInt(stats.funded_txo_sum) - BigInt(stats.spent_txo_sum)
  }
  const pending = sum(data.mempool_stats), balance = sum(data.chain_stats) + pending
  if (balance < 0n || balance > 2100000000000000n) throw new ConnectionError('比特币余额超出范围。', 502)
  return { quantity: new Decimal(balance.toString()).div('1e8').toFixed(), pending: pending !== 0n }
}
export function parseSolanaTokens(data, owner, program) {
  if (!Array.isArray(data?.value) || data.value.length > 10000) throw new ConnectionError('Solana代币账户返回不完整。', 502)
  const coins = new Map(), seen = new Set()
  for (const item of data.value) {
    const info = item.account?.data?.parsed?.info, qty = info?.tokenAmount
    if (item.account?.owner !== program || info?.owner !== owner || typeof item.pubkey !== 'string' || seen.has(item.pubkey) || !qty || !Number.isInteger(qty.decimals) || qty.decimals < 0 || qty.decimals > 36 || typeof qty.amount !== 'string' || !/^\d{1,30}$/.test(qty.amount)) throw new ConnectionError('Solana代币余额格式无法识别。', 502)
    const address = walletAddress(info.mint, 'solana')
    seen.add(item.pubkey)
    const amount = new Decimal(qty.amount).div(new Decimal(10).pow(qty.decimals))
    const prior = coins.get(address)
    if (prior && prior.decimals !== qty.decimals) throw new ConnectionError('Solana代币精度不一致。', 502)
    const metadata = tokenCatalog.solana.find(row => row[0] === address)
    coins.set(address, { address, chainId: 'solana', decimals: qty.decimals, symbol: metadata?.[1] ?? address.slice(0, 6) + '…', name: metadata?.[2] ?? '未收录名称的代币', coinId: metadata?.[3] ?? null, quantity: amount.plus(prior?.quantity ?? 0).toFixed() })
  }
  return [...coins.values()].filter(coin => new Decimal(coin.quantity).gt(0))
}
async function readSolana(connection, fetchJson) {
  let active = 'https://api.mainnet-beta.solana.com'
  const query = async (method, params) => {
    try { return await rpcQuery(active, method, params, fetchJson) }
    catch { active = 'https://solana-rpc.publicnode.com'; return rpcQuery(active, method, params, fetchJson) }
  }
  const data = await query('getBalance', [connection.address, { commitment: 'confirmed' }])
  if (!Number.isSafeInteger(data?.value) || data.value < 0) throw new ConnectionError('SOL余额无法识别。', 502)
  const coins = [{ address: null, chainId: 'solana', coinId: 'solana', symbol: 'SOL', name: 'Solana', quantity: new Decimal(data.value).div('1e9').toFixed() }]
  for (const program of programs) {
    const result = await query('getTokenAccountsByOwner', [connection.address, { programId: program }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
    coins.push(...parseSolanaTokens(result, connection.address, program))
  }
  if (new Set(coins.map(coin => coin.address ?? 'native')).size !== coins.length) throw new ConnectionError('Solana重复代币未能确认，已保留上次余额。', 502)
  return { coins: coins.filter(coin => new Decimal(coin.quantity).gt(0)), warning: '已查询普通代币及Token-2022账户；质押、借贷、资金池和NFT专属资料暂不在读取范围。' }
}
async function readBitcoin(connection, fetchJson) {
  let data
  for (const base of ['https://mempool.space/api', 'https://blockstream.info/api']) {
    try { data = parseBitcoinBalance(await fetchJson(base + '/address/' + encodeURIComponent(connection.address)), connection.address); break } catch { /* 使用免费备用查询。 */ }
  }
  if (!data) throw new ConnectionError('比特币公共查询暂不可用，已保留上次余额。', 502)
  return { coins: decimal(data.quantity).gt(0) ? [{ address: null, coinId: 'bitcoin', symbol: 'BTC', name: '比特币', quantity: data.quantity }] : [], warning: '仅统计已添加的这个比特币地址；钱包中的其他收款、找零地址需要分别添加。' + (data.pending ? '当前余额包含尚未确认的变动。' : '') }
}
function coinIcon(coin, network) {
  if (!coin.address) return network?.icon || icons[coin.symbol] || ''
  const blockchains = { 1: 'ethereum', 56: 'smartchain', 10: 'optimism', 137: 'polygon', 8453: 'base', 42161: 'arbitrum', 43114: 'avalanchec', 100: 'xdai', 324: 'zksync', 534352: 'scroll', solana: 'solana' }
  return remoteIcon('https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/' + blockchains[coin.chainId] + '/assets/' + coin.address + '/logo.png')
}
export async function readWallet(connection, _credentials, fetchJson = requestJson) {
  const family = connection.walletFamily ?? 'evm'
  walletAddress(connection.address, family)
  const selected = family === 'evm' ? connection.chains.map(id => networks.find(item => item.id === id)) : [{ id: family, name: family === 'btc' ? '比特币' : 'Solana', icon: family === 'btc' ? icons.BTC : icons.SOL }]
  return Promise.all(selected.map(async network => {
    const sourceId = 'live-' + connection.id
    const account = { id: sourceId + '-' + network.id, sourceId, name: connection.name + ' · ' + network.name, kind: '钱包', icon: network.icon, color: '#9aaad3', status: 'partial', updatedAt: new Date().toISOString(), warning: '', address: connection.address, network: network.name, pnlCents: 0 }
    try {
      const data = family === 'evm' ? await readEvmTokens(connection, network, fetchJson) : family === 'btc' ? await readBitcoin(connection, fetchJson) : await readSolana(connection, fetchJson)
      const prices = await walletPrices(data.coins, fetchJson)
      const holdings = data.coins.map(coin => {
        const quote = prices.get(walletCoinKey(coin))
        const id = family === 'evm' ? 'evm:' + network.chainId + ':' + (coin.address?.toLowerCase() ?? 'native') : family === 'btc' ? 'bitcoin:native' : 'solana:' + (coin.address ?? 'native')
        return holding(id, account.id, coin.symbol, coin.name.slice(0, 95) + ' · ' + network.name, coin.quantity, quote?.price ?? null, '公共链上余额 / ' + (quote?.source ?? '暂无可靠报价'), { network: network.name, change24h: validChange24h(quote?.change24h) ? quote.change24h : null, icon: coinIcon(coin, network), description: `${network.name} · ${coin.address ?? '主币'}。${quote ? '报价时间：' + new Date(quote.at * 1000).toLocaleString('zh-CN') + '。' : ''}${data.warning}` })
      })
      const missing = holdings.filter(item => item.usdPrice === null).length
      account.warning = data.warning + (missing ? `${missing}项资产暂无可靠报价，数量保留，未计入估值。` : '')
      account.updatedAt = new Date().toISOString()
      return { account, holdings, contracts: [] }
    } catch (error) { return { account: { ...account, status: 'error', updatedAt: null, warning: error instanceof ConnectionError ? error.message : '该网络暂时无法读取，已保留上次余额。' }, holdings: [], contracts: [] } }
  }))
}

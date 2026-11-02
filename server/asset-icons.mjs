import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cnExchange } from './cn-quotes.mjs'
import { ConnectionError, fetchIcon, remoteIcon, requestJson, sendIcon, validIconImage } from './connection-http.mjs'

const catalog = JSON.parse(readFileSync(new URL('./data/wallet-tokens.json', import.meta.url), 'utf8'))
const chains = { 1: ['ethereum', 'ethereum'], 56: ['smartchain', 'binance-smart-chain'], 10: ['optimism', 'optimistic-ethereum'], 137: ['polygon', 'polygon-pos'], 8453: ['base', 'base'], 42161: ['arbitrum', 'arbitrum-one'], 43114: ['avalanchec', 'avalanche'], 100: ['xdai', 'xdai'], 324: ['zksync', 'zksync'], 534352: ['scroll', 'scroll'] }
const nativeCoins = { BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', USDT: 'tether', USDC: 'usd-coin', DOGE: 'dogecoin' }
const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const coinPath = id => /^[a-z0-9][a-z0-9._-]{0,150}$/.test(id ?? '') ? '/coins/' + encodeURIComponent(id) : null

export function contractIconAsset(contract, exchange) {
  // shortcut: 股票合约只识别已确认的代码，新增股票合约时补充映射，避免把同名币认成股票。
  const stock = exchange === 'binance' && ['SPCX', 'TSLA', 'INTC', 'MSTR', 'CRCL'].includes(contract.baseAsset)
  return { id: contract.id, symbol: contract.baseAsset, market: stock ? 'us' : 'crypto', exchange }
}

export function assetIconPlan(asset, data = catalog) {
  if (!asset || typeof asset.id !== 'string' || typeof asset.symbol !== 'string') return null
  const symbol = asset.symbol.toUpperCase()
  if (asset.market === 'us') {
    // 股票只用股票图库；DRAM 使用已确认的基金发行方标志。
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol)) return null
    const urls = symbol === 'DRAM' ? ['https://www.roundhillinvestments.com/assets/img/favicon.png'] : ['https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons/' + symbol + '.png']
    if (symbol === 'SPCX') urls.push('https://companiesmarketcap.com/img/company-logos/256/SPCX.webp')
    // CRCL 在 companiesmarketcap 只有深色字标，深色主题下看不清，改用方形图标。
    if (symbol === 'CRCL') urls.push('https://financialmodelingprep.com/image-stock/CRCL.png')
    return { key: 'equity:us:' + symbol, urls }
  }
  if (asset.market === 'cn') {
    // A股标志取自 financialmodelingprep：代码后缀沪市 SS、深市 SZ、北交所 BJ；查不到时网页用股票名称占位。
    const exchange = cnExchange(symbol)
    return exchange ? { key: 'equity:cn:' + symbol, urls: [`https://financialmodelingprep.com/image-stock/${symbol}.${{ sh: 'SS', sz: 'SZ', bj: 'BJ' }[exchange.qq.slice(0, 2)]}.png`] } : null
  }
  if (asset.market !== 'crypto') return null
  let coinId, contract, platform, walletUrl, exchangeSymbol = false
  const evm = asset.id.match(/^evm:(\d+):(0x[0-9a-f]{40})$/i)
  const solana = asset.id.match(/^solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/)
  if (evm) {
    const chain = chains[evm[1]]
    if (!chain) return null
    const row = data.evm[evm[1]]?.find(item => item[0].toLowerCase() === evm[2].toLowerCase())
    coinId = row?.[4]; contract = evm[2].toLowerCase(); platform = chain[1]
    walletUrl = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/' + chain[0] + '/assets/' + (row?.[0] ?? evm[2]) + '/logo.png'
  } else if (solana) {
    coinId = data.solana.find(item => item[0] === solana[1])?.[3]
    contract = solana[1]; platform = 'solana'
    walletUrl = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/' + contract + '/logo.png'
  } else if (/^(evm:\d+|solana|bitcoin):native$/.test(asset.id)) {
    coinId = nativeCoins[symbol] ?? data.symbolIcons?.[symbol]
  } else if (asset.id.startsWith('evm:') || asset.id.startsWith('solana:')) return null
  else {
    const exchange = asset.exchange ?? asset.id.split(':')[0]
    const specific = data.exchangeIcons?.[exchange]
    const common = data.exchangeIcons?.common
    coinId = specific && Object.hasOwn(specific, symbol) ? specific[symbol] : common && Object.hasOwn(common, symbol) ? common[symbol] : nativeCoins[symbol] ?? data.symbolIcons?.[symbol]
    exchangeSymbol = true
  }
  // 交易所代码对应多个币时，取市值排名最靠前的那个（加载图标时向 CoinGecko 查询）。
  if (!coinPath(coinId) && !contract) return exchangeSymbol && /^[A-Z0-9]{1,20}$/.test(symbol) ? { key: 'crypto:rank:' + symbol, symbol, byMarketCap: true, coinId: null, urls: [] } : null
  return { key: contract ? platform + ':' + contract : 'crypto:' + coinId, coinId: coinPath(coinId) ? coinId : null, contract, platform, urls: walletUrl ? [walletUrl] : [] }
}

export function createAssetIconService(folder, findAsset, dependencies = {}) {
  const json = dependencies.requestJson ?? requestJson
  const download = dependencies.fetchIcon ?? fetchIcon
  const now = dependencies.now ?? Date.now
  const directory = join(folder, 'asset-icons')
  const pending = new Map(), failed = new Map(), waiting = []
  let running = 0, retryMetadataAt = 0
  async function limited(task) {
    if (running >= 2) await new Promise(resolve => waiting.push(resolve))
    else running++
    try { return await task() } finally { const next = waiting.shift(); if (next) next(); else running-- }
  }
  async function cached(key) {
    for (const [ext, type] of Object.entries(types)) {
      try {
        const image = { buffer: await readFile(join(directory, key + '.' + ext)), type }
        if (validIconImage(image)) return image
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return null
  }
  async function save(key, image) {
    const ext = Object.keys(types).find(ext => types[ext] === image.type)
    if (!ext || !validIconImage(image)) throw new ConnectionError('图标内容无法识别。', 502)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, key + '.' + ext), temp = file + '.' + randomUUID() + '.tmp'
    try { await writeFile(temp, image.buffer, { mode: 0o600, flag: 'wx' }); await rename(temp, file) }
    finally { await unlink(temp).catch(() => {}) }
    return image
  }
  const trusted = url => {
    if (typeof url !== 'string' || !remoteIcon(url)) return null
    const parsed = new URL(url)
    return ['assets.coingecko.com', 'coin-images.coingecko.com'].includes(parsed.hostname) && parsed.pathname.startsWith('/coins/images/') ? url : null
  }
  async function metadata(plan) {
    if (now() < retryMetadataAt) return null
    try {
      if (plan.byMarketCap) {
        const found = await json('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(plan.symbol))
        const top = (found?.coins ?? []).filter(coin => coin?.symbol?.toUpperCase() === plan.symbol && Number.isInteger(coin.market_cap_rank)).sort((a, b) => a.market_cap_rank - b.market_cap_rank)[0]
        if (!top || !coinPath(top.id)) return null
        // 搜索结果自带图标，直接使用，少一次容易被限流的详情请求。
        return trusted(top.large ?? top.thumb)
      }
      const path = plan.coinId ? coinPath(plan.coinId) : '/coins/' + plan.platform + '/contract/' + encodeURIComponent(plan.contract)
      const value = await json('https://api.coingecko.com/api/v3' + path + '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false')
      if (plan.coinId ? value?.id !== plan.coinId : typeof value?.platforms?.[plan.platform] !== 'string' || (plan.platform === 'solana' ? value.platforms[plan.platform] !== plan.contract : value.platforms[plan.platform].toLowerCase() !== plan.contract)) return null
      return trusted(value?.image?.small ?? value?.image?.large)
    } catch { retryMetadataAt = now() + 60000; return null }
  }
  async function load(plan, key) {
    const existing = await cached(key)
    if (existing) return existing
    if ((failed.get(key) ?? 0) > now()) throw new ConnectionError('暂未找到可确认的图标。', 404)
    return limited(async () => {
      for (const url of plan.urls) {
        try { return await save(key, await download(url)) } catch { /* 图库缺图时继续使用准确的币种资料。 */ }
      }
      const url = plan.urls.length && !plan.contract ? null : await metadata(plan)
      if (url) {
        try { return await save(key, await download(url)) } catch { /* 失败保留字母占位，不影响余额。 */ }
      }
      failed.set(key, now() + 10 * 60000)
      throw new ConnectionError('暂未找到可确认的图标。', 404)
    })
  }
  async function get(id) {
    if (typeof id !== 'string' || id.length > 300) throw new ConnectionError('资产编号无效。', 404)
    const plan = assetIconPlan(findAsset(id))
    if (!plan) throw new ConnectionError('暂未找到可确认的图标。', 404)
    const key = createHash('sha256').update(plan.key).digest('hex')
    if (!pending.has(key)) pending.set(key, load(plan, key).finally(() => pending.delete(key)))
    return pending.get(key)
  }
  return { get, serve: async (id, response) => sendIcon(await get(id), response) }
}

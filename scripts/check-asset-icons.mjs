// 仅使用公开目录与临时文件，不访问真实账户、密钥或网络。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetIconPlan, contractIconAsset, createAssetIconService } from '../server/asset-icons.mjs'
import { remoteIcon, validIconImage } from '../server/connection-http.mjs'
import { automaticAssetIcon } from '../src/data/asset-icons.ts'

const asset = (id, symbol, market = 'crypto') => ({ id, symbol, market, icon: '' })
assert.equal(assetIconPlan(asset('binance:SUI', 'SUI')).coinId, 'sui')
assert.equal(assetIconPlan(asset('binance:DOGE', 'DOGE')).coinId, 'dogecoin')
assert.equal(assetIconPlan(asset('binance:PEPE', 'PEPE')).coinId, 'pepe')
assert.equal(assetIconPlan(asset('binance:TRUMP', 'TRUMP')).coinId, 'official-trump')
assert.equal(assetIconPlan(asset('binance:XPL', 'XPL')).coinId, 'plasma')
const ambiguous = { evm: {}, solana: [], exchangeIcons: { binance: { SAME: '' }, common: { SAME: 'other-coin' } }, symbolIcons: { SAME: 'other-coin' } }
assert.deepEqual(assetIconPlan(asset('binance:SAME', 'SAME'), ambiguous), { key: 'crypto:rank:SAME', symbol: 'SAME', byMarketCap: true, coinId: null, urls: [] })
const token = assetIconPlan(asset('evm:1:0xdac17f958d2ee523a2206206994597c13d831ec7', 'FAKE'))
assert.equal(token.coinId, 'tether')
assert.equal(token.platform, 'ethereum')
assert.equal(assetIconPlan(asset('evm:56:0xdac17f958d2ee523a2206206994597c13d831ec7', 'FAKE')).coinId, null)
const stock = assetIconPlan(asset('binance:equity:EQ_DRAM', 'DRAM', 'us'))
assert.equal(stock.key, 'equity:us:DRAM')
assert.ok(stock.urls[0].startsWith('https://www.roundhillinvestments.com/'))
for (const baseAsset of ['TSLA', 'INTC', 'SPCX', 'MSTR', 'CRCL']) {
  const contract = contractIconAsset({ id: `live-example-usdm:${baseAsset}USDT:BOTH`, baseAsset }, 'binance')
  assert.equal(contract.market, 'us')
  assert.equal(assetIconPlan(contract).key, `equity:us:${baseAsset}`)
  assert.equal(assetIconPlan(contract).key, assetIconPlan(asset(`binance:equity:EQ_${baseAsset}`, baseAsset, 'us')).key)
}
assert.equal(assetIconPlan(contractIconAsset({ id: 'live-example-usdm:SUIUSDT:BOTH', baseAsset: 'SUI' }, 'binance')).coinId, 'sui')
assert.equal(contractIconAsset({ id: 'live-example:TSLAUSDT', baseAsset: 'TSLA' }, 'gate').market, 'crypto')
assert.equal(contractIconAsset({ id: 'live-example:UNKNOWNUSDT', baseAsset: 'UNKNOWN' }, 'binance').market, 'crypto')
assert.ok(assetIconPlan(asset('spcx', 'SPCX', 'us')).urls.includes('https://companiesmarketcap.com/img/company-logos/256/SPCX.webp'))
assert.ok(remoteIcon('https://financialmodelingprep.com/image-stock/CRCL.png'))
assert.equal(remoteIcon('https://financialmodelingprep.com/image-stock/OTHER.png'), '')
assert.equal(assetIconPlan(contractIconAsset({ id: 'live-example-usdm:HYPEUSDT:BOTH', baseAsset: 'HYPE' }, 'binance')).byMarketCap, true)
assert.equal(assetIconPlan(asset('manual-house', 'HOUSE', 'other')), null)
assert.equal(assetIconPlan(asset('binance:SUI', 'SUI', 'cn')), null)
assert.equal(remoteIcon('https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons/AAPL.png').startsWith('/api/'), true)
assert.equal(remoteIcon('https://raw.githubusercontent.com/nvstly/icons/main/secrets.json'), '')
assert.ok(remoteIcon('https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png').startsWith('/api/token-icon?'))
assert.equal(remoteIcon('https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/private.json'), '')
assert.equal(remoteIcon('https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png?redirect=1'), '')
assert.equal(remoteIcon('https://raw.githubusercontent.com.attacker.example/trustwallet/assets/master/blockchains/arbitrum/info/logo.png'), '')
assert.equal(remoteIcon('https://assets.coingecko.com:8080/coins/images/a.png'), '')
assert.equal(remoteIcon('https://www.roundhillinvestments.com/private'), '')
assert.ok(remoteIcon('https://companiesmarketcap.com/img/company-logos/256/SPCX.webp'))
assert.equal(remoteIcon('https://companiesmarketcap.com/private'), '')
assert.equal(remoteIcon('https://companiesmarketcap.com/img/company-logos/256/SPCX.webp?redirect=1'), '')
assert.equal(remoteIcon('https://companiesmarketcap.com.attacker.example/img/company-logos/256/SPCX.webp'), '')
assert.equal(automaticAssetIcon({ ...asset('binance:SUI', 'SUI'), icon: 'data:image/png;base64,test' }), 'data:image/png;base64,test')
assert.equal(automaticAssetIcon({ ...asset('binance:BTC', 'BTC'), icon: '/icons/btc.png' }), '/icons/btc.png')
assert.ok(automaticAssetIcon(asset('binance:SUI', 'SUI')).startsWith('/api/asset-icon?asset='))

const image = { type: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64') }
assert.ok(validIconImage(image))
assert.equal(validIconImage({ type: 'image/png', buffer: Buffer.from('<html>not an icon</html>') }), false)
assert.equal(validIconImage({ type: 'image/svg+xml', buffer: image.buffer }), false)
assert.equal(validIconImage({ type: 'image/png', buffer: Buffer.alloc(512 * 1024 + 1) }), false)
const folder = await mkdtemp(join(tmpdir(), 'investment-icons-check-'))
try {
  const known = new Map([['binance:SUI', asset('binance:SUI', 'SUI')], ['binance:PEPE', asset('binance:PEPE', 'PEPE')], ['binance:XPL', asset('binance:XPL', 'XPL')], ['dram', asset('dram', 'DRAM', 'us')]])
  let metadataCalls = 0, downloads = 0
  const dependencies = {
    requestJson: async url => { metadataCalls++; const id = new URL(url).pathname.split('/').pop(); return { id, image: { small: 'https://coin-images.coingecko.com/coins/images/1/small/test.png' } } },
    fetchIcon: async () => { downloads++; return image },
  }
  const service = createAssetIconService(folder, id => known.get(id), dependencies)
  const [first, second] = await Promise.all([service.get('binance:SUI'), service.get('binance:SUI')])
  assert.deepEqual(first, second)
  assert.equal(metadataCalls, 1); assert.equal(downloads, 1)
  await createAssetIconService(folder, id => known.get(id), dependencies).get('binance:SUI')
  assert.equal(downloads, 1, '重启后复用本机图片')
  await assert.rejects(service.get('../../private'), /图标/)
  assert.equal(metadataCalls, 1, '未知资产不访问外部服务')
  await service.get('dram')
  assert.equal(metadataCalls, 1, '股票不查加密货币目录')
  let attempts = 0, clock = 0
  const failure = createAssetIconService(folder, id => known.get(id), { ...dependencies, now: () => clock, requestJson: async () => { attempts++; throw new Error('unavailable') } })
  await assert.rejects(failure.get('binance:PEPE'))
  await assert.rejects(failure.get('binance:PEPE'))
  assert.equal(attempts, 1)
  clock = 11 * 60000
  await assert.rejects(failure.get('binance:PEPE'))
  assert.equal(attempts, 2, '稍后允许重新查找')
  const wrongId = createAssetIconService(folder, id => known.get(id), { ...dependencies, requestJson: async () => ({ id: 'wrong-coin', image: { small: 'https://assets.coingecko.com/coins/images/1/small/test.png' } }) })
  const before = downloads
  await assert.rejects(wrongId.get('binance:XPL'))
  assert.equal(downloads, before, '身份不匹配不下载')
  const looked = []
  const ranked = createAssetIconService(folder, id => id === 'binance:HYPE' ? asset('binance:HYPE', 'HYPE') : null, {
    requestJson: async url => {
      const parsed = new URL(url)
      looked.push(parsed.pathname)
      if (parsed.pathname === '/api/v3/search') return { coins: [{ id: 'hype-small', symbol: 'HYPE', market_cap_rank: 900 }, { id: 'hype-unranked', symbol: 'HYPE', market_cap_rank: null }, { id: 'hyperliquid', symbol: 'hype', market_cap_rank: 20, large: 'https://coin-images.coingecko.com/coins/images/50882/large/hyperliquid.jpg' }, { id: 'other', symbol: 'OTHER', market_cap_rank: 1 }] }
      return { id: parsed.pathname.split('/').pop(), image: { small: 'https://coin-images.coingecko.com/coins/images/1/small/test.png' } }
    },
    fetchIcon: async () => image,
  })
  await ranked.get('binance:HYPE')
  assert.deepEqual(looked, ['/api/v3/search'], '同名币取市值排名最靠前的，且只查一次')
} finally { await rm(folder, { recursive: true, force: true }) }
assert.ok(remoteIcon('https://financialmodelingprep.com/image-stock/600519.SS.png'))
assert.equal(remoteIcon('https://financialmodelingprep.com/image-stock/600519.SS.png?x=1'), '')
assert.equal(remoteIcon('https://financialmodelingprep.com/image-stock/../secret.png'), '')
// A股：按代码判断沪/深/北交所后缀；查不到时网页用名称占位（fb 参数），代码数字不当占位
assert.deepEqual(assetIconPlan(asset('manual-a', '600519', 'cn')), { key: 'equity:cn:600519', urls: ['https://financialmodelingprep.com/image-stock/600519.SS.png'] })
assert.equal(assetIconPlan(asset('manual-b', '001309', 'cn')).urls[0], 'https://financialmodelingprep.com/image-stock/001309.SZ.png')
assert.equal(assetIconPlan(asset('manual-c', '830799', 'cn')).urls[0], 'https://financialmodelingprep.com/image-stock/830799.BJ.png')
assert.equal(assetIconPlan(asset('manual-d', 'ABC', 'cn')), null)
const cnIcon = automaticAssetIcon({ id: 'manual-b', market: 'cn', icon: '', name: '德明利' })
assert.ok(cnIcon.startsWith('/api/asset-icon?asset=manual-b&fb=data%3Aimage%2Fsvg%2Bxml'))
assert.equal(automaticAssetIcon({ id: 'manual-b', market: 'cn', icon: '', name: '001309' }), '/api/asset-icon?asset=manual-b')
assert.equal(automaticAssetIcon({ id: 'manual-b', market: 'cn', icon: '/icons/x.png', name: '德明利' }), '/icons/x.png', '手动图标优先')

assert.equal(automaticAssetIcon({ id: 'manual-a', market: 'other', icon: '', name: '车辆' }), '/icons/car.svg')
assert.equal(automaticAssetIcon({ id: 'manual-b', market: 'other', icon: '', name: '上海房产' }), '/icons/house.svg')
assert.equal(automaticAssetIcon({ id: 'manual-c', market: 'other', icon: '', name: '黄金首饰' }), '')
assert.equal(automaticAssetIcon({ id: 'manual-d', market: 'other', icon: 'data:image/png;base64,AAAA', name: '车辆' }), 'data:image/png;base64,AAAA')

console.log('资产图标检查通过：身份匹配、手动优先、本机缓存、失败重试与图片边界。')

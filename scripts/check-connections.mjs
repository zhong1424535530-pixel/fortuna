// 仅在用户单独同意模拟测试后运行。全部使用临时文件、内存密钥和假余额，不连接真实平台或系统钥匙串。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createWorkspaceApi } from '../server/workspace-api.mjs'
import { createHash, createHmac } from 'node:crypto'
import { combineHoldings, createConnectionService } from '../server/connection-service.mjs'
import { checkReadOnly, signQuery, buildBinanceMarket, parseFuturesBalances, parseBinanceUid } from '../server/binance-reader.mjs'
import { parseWalletScope, stockBidPrice, walletScopes } from '../server/binance-wallets.mjs'
import { visibleBinanceGroups } from '../src/data/account-groups.ts'
import { cents, decimal, holding, remoteIcon } from '../server/connection-http.mjs'
import { exchanges, networks } from '../src/data/live-types.ts'
import { checkExchangePermissions, exchangeIdentity, parseExchangeBalances, parseExchangePositions, valueExchangeBalances } from '../server/exchange-reader.mjs'
import { parseBitunixBalance, signBitunix } from '../server/bitunix-reader.mjs'
import { parseBinanceMarginPools } from '../server/binance-margin.mjs'
import { marginRatio, marginRows, validMarginPools } from '../src/data/margin-risk.ts'
import { assertWorkspacePortfolio, countOriginalAccounts } from '../src/data/portfolio.ts'
// 保证金比率：仅准备隔离断言，未获批准不运行模拟。
const marginData = { assets: [{ asset: 'USDT', crossWalletBalance: '1800', crossUnPnl: '100' }, { asset: 'USDC', crossWalletBalance: '100', crossUnPnl: '-10' }], totalMaintMargin: '53', totalMarginBalance: '1990' }
const marginPositions = [{ symbol: 'BTCUSDT', marginAsset: 'USDT', maintMargin: '30' }, { symbol: 'ETHUSDT', marginAsset: 'USDT', maintMargin: '20' }, { symbol: 'SOLUSDC', marginAsset: 'USDC', maintMargin: '3' }, { symbol: 'BNBUSDT', marginAsset: 'USDT', maintMargin: '2', isolatedWallet: '100', unRealizedProfit: '-20' }]
const marginContracts = marginPositions.map((row, i) => ({ id: 'margin-' + i, accountId: 'margin-account', symbol: row.symbol, direction: '做多', marginMode: i === 3 ? '逐仓' : '全仓' }))
const marginPools = parseBinanceMarginPools(marginData, marginPositions, marginContracts, false)
assert.equal(marginPools.length, 3)
assert.equal(marginPools.find(pool => pool.id === 'cross:USDT').maintenance, '50')
assert.equal(marginPools.find(pool => pool.id === 'cross:USDT').balance, '1900')
assert.equal(marginPools.find(pool => pool.id === 'cross:USDC').balance, '90')
assert.equal(marginPools.find(pool => pool.id.startsWith('isolated:')).balance, '80')
assert.equal(marginRatio(marginPools.find(pool => pool.id.startsWith('isolated:'))).percent, 2.5)
assert.equal(marginRatio({ ...marginPools[0], maintenance: '51.4429', balance: '1899.1990' }).percent.toFixed(2), '2.71')
assert.equal(marginRatio({ ...marginPools[0], maintenance: null }).percent, null)
assert.equal(marginRatio({ ...marginPools[0], maintenance: '1', balance: '-2' }).exhausted, true)
assert.equal(marginRatio({ ...marginPools[0], maintenance: '0', balance: '0' }).percent, null)
assert.equal(validMarginPools(marginPools), true)
assert.equal(validMarginPools([{ ...marginPools[0], maintenance: '-1' }]), false)
assert.equal(validMarginPools([marginPools[0], marginPools[0]]), false)
assert.equal(parseBinanceMarginPools(marginData, marginPositions, marginContracts, undefined).find(pool => pool.id === 'cross:USDT').maintenance, null)
assert.equal(parseBinanceMarginPools(marginData, marginPositions.slice(0, 3), marginContracts.slice(0, 3), true)[0].balance, '1990')
assert.equal(parseBinanceMarginPools(marginData, marginPositions, marginContracts, true).find(pool => pool.id === 'multi-assets').balance, null)
const marginAccounts = [{ id: 'margin-account', name: '账户一', status: 'ok', updatedAt: '2026-10-24T00:00:00Z', marginPools }, { id: 'other-margin-account', name: '账户二', status: 'ok', updatedAt: null }]
const marginAllContracts = [...marginContracts, { ...marginContracts[0], id: 'other-position', accountId: 'other-margin-account' }]
assert.equal(marginRows(marginAccounts, marginAllContracts).length, 4)
assert.equal(marginRows(marginAccounts, marginAllContracts, ['margin-account']).length, 3)
assert.equal(marginRows(marginAccounts, marginAllContracts, []).length, 0)
import { addDailyOpenPrices, dailyPriceKey, parsePriceChanges24h } from '../server/daily-prices.mjs'
import { heldTodayPnl, validDayOpen } from '../src/data/daily-pnl.ts'
import { parseLlamaPrices, walletPrices } from '../server/wallet-prices.mjs'
import { applyMarketPrices, readMarketPrices, readTransactionFeePrices } from '../server/market-prices.mjs'

const folder = mkdtempSync(join(tmpdir(), 'investment-connections-check-'))
const feeQuoteTime = Date.now()
const feeQuoteRows = { records: [{ id: 'binance:test:spot:1', scope: 'spot', fees: [{ asset: 'BNB', quantity: '0.1' }] }, { id: 'gate:test:spot:1', scope: 'spot', fees: [{ asset: 'GT', quantity: '0.2' }] }, { id: 'wallet:test:1', scope: 'wallet:eth', fees: [{ asset: 'ETH', quantity: '0.001' }] }] }
feeQuoteRows.records.push({ id: 'binance:test:capital:1', scope: 'capital', type: '充值', asset: 'BTC', fees: [] }, { id: 'wallet:test:2', scope: 'wallet:eth', type: '收到', fees: [], movements: [{ token: '0x6982508145454ce325ddbe47a25d4ec3d2311933', asset: 'PEPE' }] })
const feeQuotes = await readTransactionFeePrices(feeQuoteRows, { now: new Date(feeQuoteTime), marketPrices: async snapshot => {
  assert(snapshot.holdings.some(asset => asset.id === 'binance:BNB'), '费用币即使没有持仓也补查')
  assert(snapshot.holdings.some(asset => asset.id === 'gate:GT'), '使用来源交易所的平台币行情')
  assert(snapshot.holdings.some(asset => asset.id === 'evm:1:native'), '链上费用使用已确认的主币身份')
  assert(snapshot.holdings.some(asset => asset.id === 'binance:BTC'), '充值或提现币也补查价格，不依赖存在同币费用')
  assert(snapshot.holdings.some(asset => asset.id === 'evm:1:0x6982508145454ce325ddbe47a25d4ec3d2311933'), '钱包收付按实际代币地址补价，不猜同名币')
  assert(snapshot.holdings.every(asset => asset.positions.length === 0), '补价不构造或改写真实余额')
  return { holdings: new Map([['binance:USDT', { usdPrice: '0.999', at: feeQuoteTime }], ['binance:BNB', { usdPrice: '599.4', at: feeQuoteTime }], ['gate:GT', { usdPrice: '9.99', at: feeQuoteTime }]]), contracts: new Map() }
} })
assert.equal(feeQuotes.find(item => item.key === 'coin:binancecoin').price, '600', '美元报价除以USDT美元价后再计价')
assert.equal(feeQuotes.find(item => item.key === 'crypto:gate:GT').price, '10')
assert(!feeQuotes.some(item => item.key === 'coin:ethereum'), '缺价不伪造零价格')
const secrets = new Map()
let failBinance = false, zeroBinance = false, failEth = false, identity = 'account-a'
const stamp = '2026-10-19T04:00:00Z'
const amount = value => holding('binance:BTC', value, 'BTC', '比特币', '.7', '60000', '隔离假资料')
const acc = (connection, suffix, kind = '交易所') => ({ id: `live-${connection.id}-${suffix}`, sourceId: `live-${connection.id}`, name: connection.name, kind, icon: '', color: '#91ad9c', status: 'ok', updatedAt: stamp, warning: '', pnlCents: 0 })
const dependencies = {
  dailyPrices: async parts => parts,
  vault: { get: async id => secrets.get(id) ?? {}, set: async (id, value) => { secrets.set(id, value) }, remove: async id => { secrets.delete(id) } },
  readers: {
    binance: async connection => {
      if (failBinance) throw new Error('故意断网')
      const spot = { ...acc(connection, 'spot'), identity, uid: '123456789' }
      const futures = { ...acc(connection, 'usdm', '合约账户'), identity, pnlCents: zeroBinance ? 0 : -2000 }
      return [{ account: spot, holdings: zeroBinance ? [] : [amount(spot.id)], contracts: [] }, { account: futures, holdings: zeroBinance ? [] : [holding('binance:USDT', futures.id, 'USDT', '泰达币', '1000', '1', '假资料')], contracts: [] }]
    },
    wallet: async connection => connection.chains.map(chain => {
      const account = { ...acc(connection, chain, '钱包'), network: chain, address: connection.address }
      if (chain === 'eth' && failEth) return { account: { ...account, status: 'error', updatedAt: null, warning: '这条链故意断网' }, holdings: [], contracts: [] }
      return { account, holdings: [holding(`evm:${networks.find(item => item.id === chain).chainId}:native`, account.id, 'ETH', 'ETH', '.1', '2000', '假节点')], contracts: [] }
    }),
  },
}
let server
try {
  const dailyNow = new Date('2026-10-20T04:00:00Z')
  // 行情更新断言只准备，不在未获同意时执行。
  const quoteAccount = { ...acc({ id: 'quote' }, 'spot'), updatedAt: '2026-10-19T04:00:00Z' }
  const quoteAsset = amount(quoteAccount.id)
  const quoteContract = { id: 'quote-contract', accountId: quoteAccount.id, symbol: 'BTCUSDT', baseAsset: 'BTC', markPriceUsd: 60000, unrealizedPnlCents: 123, quantity: 1 }
  const quoteSnapshot = { accounts: [quoteAccount], holdings: [quoteAsset], contracts: [quoteContract] }
  const quoteBefore = JSON.stringify(quoteSnapshot)
  const quotePatches = { holdings: new Map([[quoteAsset.id, { usdPrice: '65000', at: dailyNow.getTime() }]]), contracts: new Map([[quoteContract.id, { usdPrice: '65010', at: dailyNow.getTime() }]]) }
  const repriced = applyMarketPrices(quoteSnapshot, quotePatches, dailyNow)
  assert.equal(repriced.holdings[0].usdPrice, 65000)
  assert.equal(repriced.holdings[0].positions[0].valueCents, 4550000)
  assert.equal(repriced.holdings[0].positions[0].quantityText, quoteAsset.positions[0].quantityText)
  assert.equal(repriced.accounts[0].updatedAt, quoteAccount.updatedAt, '行情时间不能冒充余额刷新时间')
  assert.equal(repriced.contracts[0].markPriceUsd, 65010)
  assert.equal(repriced.contracts[0].unrealizedPnlCents, 123, '市场报价不冒充平台报告的浮盈亏')
  assert.equal(JSON.stringify(quoteSnapshot), quoteBefore)
  for (const usdPrice of ['0', '-1', '坏价格', Infinity]) {
    assert.deepEqual(applyMarketPrices(quoteSnapshot, { holdings: new Map([[quoteAsset.id, { usdPrice, at: dailyNow.getTime() }]]), contracts: new Map() }, dailyNow), quoteSnapshot)
  }
  assert.deepEqual(applyMarketPrices(quoteSnapshot, { holdings: new Map([[quoteAsset.id, { usdPrice: 1, at: dailyNow.getTime() - 7200000 }]]), contracts: new Map() }, dailyNow), quoteSnapshot)
  const marketRead = await readMarketPrices(quoteSnapshot, {
    now: dailyNow,
    connections: [{ id: 'quote', type: 'binance' }],
    native: async () => ({ tether: 1 }),
    exchangeQuotes: async type => { assert.equal(type, 'binance'); return { spot: new Map([['BTC', '65000']]), marks: new Map([['BTCUSDT', { price: '65010', at: dailyNow.getTime() }]]) } },
    fetchJson: async () => { throw new Error('不应联网') },
  })
  assert.equal(marketRead.holdings.get(quoteAsset.id).usdPrice, '65000')
  assert.equal(marketRead.contracts.get(quoteContract.id).usdPrice, '65010')
  for (const type of ['binance', 'okx', 'bybit', 'bitget', 'gate', 'bitunix']) {
    const response = {
      binance: [{ symbol: 'BTCUSDT', markPrice: '61000', time: dailyNow.getTime() }],
      okx: { code: '0', data: [{ instId: 'BTC-USDT-SWAP', markPx: '61000', ts: String(dailyNow.getTime()) }] },
      bybit: { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', markPrice: '61000' }] } },
      bitget: { code: '00000', data: [{ symbol: 'BTCUSDT', markPrice: '61000', ts: String(dailyNow.getTime()) }] },
      gate: [{ name: 'BTC_USDT', mark_price: '61000' }],
      bitunix: { code: 0, data: [{ symbol: 'BTCUSDT', markPrice: '61000' }] },
    }[type]
    const marks = await readMarketPrices({ ...quoteSnapshot, holdings: [] }, { connections: [{ id: 'quote', type }], now: dailyNow, native: async () => ({ tether: 1 }), fetchJson: async (_url, options) => { assert.equal(options, undefined, '合约公开行情不带私密凭据'); return response } })
    assert.equal(marks.contracts.get(quoteContract.id).usdPrice, '61000')
  }
  const xplSnapshot = { ...quoteSnapshot, contracts: [], holdings: [holding('binance:XPL', quoteAccount.id, 'XPL', 'XPL', '100', '.1', '假资料')] }
  const xplMarket = await readMarketPrices(xplSnapshot, { now: dailyNow, native: async force => { assert.equal(force, true); return { tether: 1 } }, fetchJson: async url => {
    assert.ok(url.endsWith('/api/v3/ticker/price'))
    return [{ symbol: 'XPLUSDT', price: '.2' }]
  } })
  assert.equal(xplMarket.holdings.get('binance:XPL').usdPrice, '0.2')
  const midnight = Date.parse('2026-10-20T00:00:00+08:00') / 1000
  let dailyRequests = 0, changeRequests = 0
  const dailyParts = [{ account: { ...acc({ id: 'daily' }, 'spot'), updatedAt: dailyNow.toISOString() }, holdings: [amount('live-daily-spot')], contracts: [] }]
  const fakeDailyPrices = async url => {
    if (url.includes('/percentage/')) { changeRequests++; assert.ok(url.includes('period=24h')); return { coins: { 'coingecko:bitcoin': -2.5 } } }
    dailyRequests++
    assert.ok(url.startsWith('https://coins.llama.fi/prices/historical/' + midnight + '/'))
    // 币安持仓会顺带查 tether，用于换算币安零点 USDT 报价；真实接口会返回它。
    return { coins: { 'coingecko:bitcoin': { price: 50000, timestamp: midnight, confidence: 1 }, 'coingecko:tether': { price: 1, timestamp: midnight, confidence: 1 } } }
  }
  const dailyResult = await addDailyOpenPrices(dailyParts, fakeDailyPrices, dailyNow)
  assert.equal(dailyResult[0].holdings[0].dayOpen.usdPrice, 50000)
  assert.equal(dailyResult[0].holdings[0].change24h, -2.5)
  assert.equal(heldTodayPnl(dailyResult[0].holdings, [dailyResult[0].account], '2026-10-20').pnlCents, 700000)
  assert.equal(dailyParts[0].holdings[0].dayOpen, undefined, '不修改原持仓对象')
  await addDailyOpenPrices(dailyParts, fakeDailyPrices, dailyNow)
  assert.equal(dailyRequests, 1, '同一天重复报价复用缓存')
  assert.equal(changeRequests, 1, '24小时涨跌短时缓存')
  const changeKeys = ['a', 'b', 'c', 'd', 'e', 'f']
  const parsedChanges = parsePriceChanges24h({ coins: { a: 5, b: -2, c: 0, d: null, e: '3', f: -101 } }, changeKeys)
  assert.deepEqual([...parsedChanges], [['a', 5], ['b', -2], ['c', 0]])
  assert.throws(() => parsePriceChanges24h({ error: '失败' }, changeKeys))
  const backupCoin = { coinId: 'isolated-24h-check' }
  let backupRequests = 0
  const backupPrices = await walletPrices([backupCoin], async url => {
    if (url.startsWith('https://coins.llama.fi/prices/current/')) return { coins: {} }
    assert.ok(url.startsWith('https://api.coingecko.com/api/v3/simple/price?'))
    assert.equal(new URL(url).searchParams.get('include_24hr_change'), 'true')
    backupRequests++
    return { [backupCoin.coinId]: { usd: 2, usd_24h_change: 0, last_updated_at: Math.floor(Date.now() / 1000) } }
  })
  assert.equal(backupRequests, 1)
  assert.equal(backupPrices.get('coingecko:' + backupCoin.coinId).change24h, 0, '钱包备用报价保留真实零涨跌')
  let forcedWalletCalls = 0
  const forcedWalletQuote = await walletPrices([backupCoin], async url => {
    forcedWalletCalls++
    assert.ok(url.includes('/prices/current/'))
    return { coins: { ['coingecko:' + backupCoin.coinId]: { price: 3, timestamp: Math.floor(Date.now() / 1000), confidence: 1 } } }
  }, true)
  assert.equal(forcedWalletCalls, 1, '定时更新必须跳过本机旧缓存')
  assert.equal(forcedWalletQuote.get('coingecko:' + backupCoin.coinId).price, '3')
  const quoteClock = Date.now(), oldQuoteKey = 'coingecko:isolated-old-price'
  const oldQuote = { coins: { [oldQuoteKey]: { price: 3, timestamp: Math.floor(quoteClock / 1000) - 360, confidence: 1 } } }
  assert.equal(parseLlamaPrices(oldQuote, [oldQuoteKey], quoteClock, 300).size, 0, '自动更新拒绝超过5分钟的来源报价')
  assert.equal(parseLlamaPrices(oldQuote, [oldQuoteKey], quoteClock).size, 1, '历史查询原有时间范围不受影响')
  for (const token of [{ chainId: 1, address: '0x' + '3'.repeat(40), coinId: 'ethereum' }, { chainId: 'solana', address: '11111111111111111111111111111111', coinId: 'solana' }]) {
    const tokenRequests = []
    const noTokenQuote = await walletPrices([token], async url => {
      tokenRequests.push(url)
      if (url.includes('/prices/current/')) return { coins: {} }
      if (url.includes('coingecko.com')) return {}
      return { error: [], result: { ETH: { c: ['3000'] } } }
    }, true)
    assert.equal(noTokenQuote.size, 0, '代币无价时不能套用所在链主币价格')
    assert.ok(tokenRequests.every(url => !url.includes('kraken.com') && !url.includes('/simple/price?')))
  }
  assert.equal(dailyPriceKey({ id: 'evm:1:native', market: 'crypto' }), 'coingecko:ethereum')
  assert.equal(dailyPriceKey({ id: 'evm:1:0x' + 'a'.repeat(40), market: 'crypto' }), 'ethereum:0x' + 'a'.repeat(40))
  assert.equal(dailyPriceKey({ id: 'binance:UNKNOWN', market: 'crypto', symbol: 'UNKNOWN' }), null)
  assert.equal(dailyPriceKey({ id: 'binance:BTC', market: 'us', symbol: 'BTC' }), null)
  assert.equal(validDayOpen({ date: '2026-10-20', usdPrice: 50000, at: midnight + 301 }), false)
  const failedDaily = await addDailyOpenPrices(dailyParts, async () => { throw new Error('隔离报价失败') }, new Date('2026-10-21T04:00:00Z'))
  assert.equal(failedDaily[0].holdings[0].dayOpen, undefined)
  assert.equal(failedDaily[0].holdings[0].change24h, null, '无24小时行情时不能冒充零涨跌')
  assert.deepEqual(failedDaily[0].holdings[0].positions, dailyParts[0].holdings[0].positions)
  const lateDaily = await addDailyOpenPrices(dailyParts, async () => ({ coins: { 'coingecko:bitcoin': { price: 50000, timestamp: midnight + 86400 + 301, confidence: 1 } } }), new Date('2026-10-21T04:00:00Z'))
  assert.equal(lateDaily[0].holdings[0].dayOpen, undefined, '超过零点五分钟的参考价不合入')
  const smallDay = new Date('2026-10-22T04:00:00Z'), smallMidnight = Date.parse('2026-10-22T00:00:00+08:00') / 1000
  const smallPart = (suffix, quantity) => ({ account: acc({ id: 'small' }, suffix), holdings: [holding('binance:BTC', 'live-small-' + suffix, 'BTC', 'BTC', quantity, '1', '假资料')], contracts: [] })
  const smallParts = [smallPart('spot', '.4'), smallPart('usdm', '.5')]
  const smallBefore = JSON.stringify(smallParts)
  let smallRequests = 0
  const smallResult = await addDailyOpenPrices(smallParts, async () => { smallRequests++; throw new Error('小额不应查询行情') }, smallDay)
  assert.equal(smallRequests, 0)
  assert.equal(JSON.stringify(smallResult), smallBefore, '小额只跳过行情补全，不移除余额')
  const enoughParts = [smallPart('spot', '.6'), smallPart('usdm', '.6')]
  const enoughResult = await addDailyOpenPrices(enoughParts, async url => {
    smallRequests++
    return url.includes('/percentage/') ? { coins: { 'coingecko:bitcoin': 2 } } : { coins: { 'coingecko:bitcoin': { price: 1, timestamp: smallMidnight, confidence: 1 } } }
  }, smallDay)
  assert.equal(smallRequests, 2, '跨账户合计超过1美元需要补查')
  assert.ok(enoughResult.every(part => part.holdings[0].dayOpen?.date === '2026-10-22'))
  const trumpNow = new Date('2026-10-23T04:00:00Z'), trumpMidnight = Date.parse('2026-10-23T00:00:00+08:00') / 1000
  let trumpRequests = 0
  const trumpParts = [{ account: acc({ id: 'trump' }, 'spot'), holdings: [holding('binance:TRUMP', 'live-trump-spot', 'TRUMP', 'TRUMP', '10', '22', '假资料')], contracts: [] }]
  const trumpResult = await addDailyOpenPrices(trumpParts, async url => {
    trumpRequests++
    if (url.includes('/prices/historical/')) return { coins: { 'coingecko:tether': { price: 1.001, timestamp: trumpMidnight, confidence: 1 } } }
    const params = new URL(url).searchParams
    assert.equal(params.get('symbol'), 'TRUMPUSDT')
    assert.equal(params.get('timeZone'), '8')
    assert.equal(params.get('startTime'), String(trumpMidnight * 1000))
    return [[trumpMidnight * 1000, '20', '21', '19', '20', '1', trumpMidnight * 1000 + 59999, '20', 1]]
  }, trumpNow)
  assert.equal(trumpResult[0].holdings[0].dayOpen.usdPrice, 20.02)
  const trumpCount = trumpRequests
  await addDailyOpenPrices(trumpParts, async () => { trumpRequests++; throw new Error('已缓存的参考价不应重复读取') }, trumpNow)
  assert.equal(trumpRequests, trumpCount)
  // 仅准备多平台断言；用户授权模拟测试后才运行。
  assert.deepEqual(exchanges.map(item => item.id), ['binance', 'okx', 'gate', 'bitget', 'bybit', 'bitunix'])
  for (const [type, permissions] of [['okx', { perm: 'read_only' }], ['bybit', { readOnly: 1 }], ['bitget', { permType: 'read-only' }]]) {
    checkExchangePermissions(type, permissions)
    assert.throws(() => checkExchangePermissions(type, {}), /读取权限/)
  }
  assert.throws(() => checkExchangePermissions('okx', { perm: 'read_only,trade' }), /读取权限/)
  assert.throws(() => checkExchangePermissions('bybit', { readOnly: 0 }), /读取权限/)
  assert.throws(() => checkExchangePermissions('bitget', { permType: 'read-and-write' }), /读取权限/)
  assert.notEqual(exchangeIdentity('okx', '123').identity, exchangeIdentity('gate', '123').identity)
  assert.equal(exchangeIdentity('okx', 123).identity, exchangeIdentity('okx', '123').identity)
  assert.throws(() => exchangeIdentity('okx', Number.MAX_SAFE_INTEGER + 1), /身份/)
  const usd = new Map([['USDT', '.9998']])
  const cases = [
    ['okx', 'trading', { data: [{ details: [{ ccy: 'USDT', eq: '110', upl: '10', liab: '0' }] }] }],
    ['bybit', 'unified', { result: { list: [{ coin: [{ coin: 'USDT', walletBalance: '100', unrealisedPnl: '10', borrowAmount: '0' }] }] } }],
    ['bitget', 'usdm', [{ marginCoin: 'USDT', accountEquity: '110', unrealizedPL: '10' }]],
    ['bitget', 'unified', { data: { assets: [{ coin: 'USDT', equity: '110', balance: '100', debt: '0' }] } }],
    ['gate', 'usdm', [{ currency: 'USDT', total: '100', unrealised_pnl: '10' }]],
  ]
  for (const [type, scope, info] of cases) {
    const rows = parseExchangeBalances(type, { info }, scope)
    assert.deepEqual(rows, [{ symbol: 'USDT', quantity: '100', pnl: '10' }])
    const value = valueExchangeBalances(type, 'isolated-account', rows, usd)
    assert.equal(value.holdings[0].positions[0].valueCents, 9998)
    assert.equal(value.pnlCents, 1000, '浮盈亏只加一次，不能把含盈亏的净值再加一次盈亏')
    const missing = valueExchangeBalances(type, 'isolated-account', rows, new Map())
    assert.equal(missing.holdings[0].positions[0].quantityText, '100')
    assert.equal(missing.holdings[0].usdPrice, null)
    assert.equal(missing.pnlCents, null)
  }
  assert.throws(() => parseExchangeBalances('bybit', { info: { result: { list: [] } } }, 'unified'), /不完整/)
  assert.throws(() => parseExchangeBalances('bitget', { info: {} }, 'spot'), /不完整/)
  assert.throws(() => parseExchangeBalances('okx', { info: { data: [{ details: [{ ccy: 'USDT', eq: '100', upl: '0', liab: '5' }] }] } }, 'trading'), /借款/)
  assert.deepEqual(parseBitunixBalance([{ coin: 'USDT', balance: '100', balanceLocked: '0' }]), [{ symbol: 'USDT', quantity: '100', pnl: '0' }])
  assert.deepEqual(parseBitunixBalance([{ marginCoin: 'USDT', available: '80', frozen: '5', margin: '15', crossUnrealizedPNL: '4', isolationUnrealizedPNL: '-1' }], true), [{ symbol: 'USDT', quantity: '100', pnl: '3' }])
  assert.throws(() => parseBitunixBalance([], true), /不完整/)
  const sha = value => createHash('sha256').update(value).digest('hex')
  assert.equal(signBitunix({ uid: '200', id: '1' }, 'fake-key', 'fake-secret', '123456', '1000'), sha(sha('1234561000fake-keyid1uid200') + 'fake-secret'))
  assert.equal(signBitunix({ uid: '200', id: '1' }, 'fake-key', 'fake-secret', '123456', '1000', true), sha(sha('1234561000fake-keyid=1uid=200') + 'fake-secret'))
  const positionInput = { info: {}, id: 'p', symbol: 'BTC/USDT:USDT', side: 'long', contracts: '2', contractSize: '.1', entryPrice: '60000', markPrice: '61000', initialMargin: '100', unrealizedPnl: '200', marginMode: 'cross', leverage: '20' }
  const parsedPosition = parseExchangePositions([positionInput], 'isolated-account', usd)[0]
  assert.equal(parsedPosition.quantity, .2, '合约张数必须换算为币的数量')
  assert.equal(parsedPosition.unrealizedPnlCents, 19996)
  assert.equal(parseExchangePositions([{ ...positionInput, liquidationPrice: '-1' }], 'isolated-account', usd)[0].liquidationPriceUsd, null)

  let failExtra = false
  const extraService = createConnectionService(join(folder, 'extra-exchanges'), { vault: dependencies.vault, dailyPrices: dependencies.dailyPrices, readers: Object.fromEntries(exchanges.map(item => [item.id, async connection => {
    if (failExtra) throw new Error('隔离断网')
    const account = { ...acc(connection, 'spot'), ...exchangeIdentity(connection.type, '123') }
    return [{ account, holdings: [holding(connection.type + ':USDT', account.id, 'USDT', 'USDT', '100', '.9998', '隔离假资料')], contracts: [] }]
  }])) })
  for (const item of exchanges) {
    const extraInput = { type: item.id, name: '隔离' + item.name, apiKey: 'x'.repeat(32), apiSecret: 'y'.repeat(32), ...(item.passphrase ? { passphrase: 'isolated-passphrase' } : {}) }
    if (item.passphrase) await assert.rejects(extraService.upsert({ ...extraInput, passphrase: '' }), /口令/)
    let extra = await extraService.upsert(extraInput)
    const connection = extra.connections.find(entry => entry.type === item.id)
    assert.equal(secrets.get(connection.id).passphrase, extraInput.passphrase)
    extra = await extraService.upsert({ type: item.id, name: '仅改名称' }, connection.id)
    const before = extra.snapshot.holdings
    failExtra = true
    extra = await extraService.sync(connection.id, true)
    assert.deepEqual(extra.snapshot.holdings, before, '新平台断网同样保留旧余额')
    failExtra = false
  }
  const persisted = readFileSync(join(folder, 'extra-exchanges', 'connections.json'), 'utf8')
  assert.ok(!persisted.includes('apiSecret') && !persisted.includes('passphrase') && !persisted.includes('isolated-passphrase'))
  assert.equal(extraService.list().connections.length, 6, '六家平台的同号UID不混为同一账户')
  const bitunixId = extraService.list().connections.find(item => item.type === 'bitunix').id
  await assert.rejects(extraService.upsert({ type: 'bitunix', name: '换密钥', apiKey: 'z'.repeat(32), apiSecret: 'y'.repeat(32) }, bitunixId), /重新添加/)

  let mode = 'spot', modeFailure = false
  const modeService = createConnectionService(join(folder, 'mode-change'), { vault: dependencies.vault, dailyPrices: dependencies.dailyPrices, readers: { bitget: async connection => {
    const account = { ...acc(connection, mode), ...exchangeIdentity('bitget', '456'), ...(modeFailure ? { status: 'error', updatedAt: null, warning: '隔离读取失败' } : {}) }
    return [{ account, holdings: modeFailure ? [] : [holding('bitget:USDT', account.id, 'USDT', 'USDT', '100', '1', '隔离假资料')], contracts: [] }]
  } } })
  let modeState = await modeService.upsert({ type: 'bitget', name: '模式隔离', apiKey: 'x'.repeat(32), apiSecret: 'y'.repeat(32), passphrase: 'isolated-passphrase' })
  const modeId = modeState.connections[0].id, modeHoldings = structuredClone(modeState.snapshot.holdings)
  mode = 'unified'; modeFailure = true
  modeState = await modeService.sync(modeId, true)
  assert.deepEqual(modeState.snapshot.holdings, modeHoldings, '换模式但读取失败，不能删掉旧模式余额')
  modeFailure = false
  modeState = await modeService.sync(modeId, true)
  assert.equal(modeState.snapshot.accounts.length, 1)
  assert.equal(modeState.snapshot.accounts[0].id, 'live-' + modeId + '-unified')
  assert.equal(modeState.snapshot.holdings[0].positions.length, 1, '换模式成功后旧余额不能再加一次')

  const query = 'timestamp=1000&recvWindow=5000'
  assert.equal(signQuery({ timestamp: '1000', recvWindow: '5000' }, 'fake-secret'), query + '&signature=' + createHmac('sha256', 'fake-secret').update(query).digest('hex'))
  checkReadOnly({ enableReading: true })
  for (const permission of ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableSpotAndMarginTrading', 'enableMargin', 'enableFutures', 'enableVanillaOptions', 'enablePortfolioMarginTrading', 'enableFixApiTrade']) assert.throws(() => checkReadOnly({ enableReading: true, [permission]: true }), /仅开启读取/)
  assert.throws(() => checkReadOnly({ enableReading: false }))
  // UID只校验格式与精度，不从旧识别码反推；本轮准备断言，不运行。
  assert.equal(parseBinanceUid(123456789), '123456789')
  assert.equal(parseBinanceUid('12345678901234567890'), '12345678901234567890')
  for (const invalid of [null, undefined, {}, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '1e10', ' 123 ']) assert.throws(() => parseBinanceUid(invalid), /UID/)
  assert.equal(cents(decimal('1.005')), 101)
  assert.equal(cents(decimal('-1.005', '金额', true)), -101)
  assert.equal(holding('small', 'account', 'T', 'T', '123456789.123456789', '.00000001', '假资料').positions[0].valueCents, 123)
  assert.throws(() => cents(decimal('1e30')))
  assert.equal(remoteIcon('https://127.0.0.1/private'), '')
  assert.equal(remoteIcon('https://coingecko.com.attacker.example/x'), '')
  assert.equal(remoteIcon('https://user:password@assets.coingecko.com/x'), '')
  assert.ok(remoteIcon('https://assets.coingecko.com/coins/x.png').startsWith('/api/token-icon?'))
  assert.deepEqual(networks.map(item => item.chainId), [1, 56, 42161, 8453, 10, 137, 43114, 100, 534352, 324])

  // 新增报价与结算币回归断言；本轮只准备，不运行。
  const market = buildBinanceMarket([{ symbol: 'BTCUSDT', price: '60000' }, { symbol: 'DOGEUSDT', price: '.1' }, { symbol: 'BADUSDT', price: '-1' }, { symbol: 'USDCUSDT', price: '1.001' }], { tether: .9998 })
  assert.equal(market.usd.get('BTC'), '59988')
  assert.equal(market.usd.get('DOGE'), '0.09998')
  assert.ok(market.usd.has('USDC'))
  assert.ok(!market.usd.has('BAD'))
  const statsNow = Date.parse('2026-10-20T04:00:00Z')
  const stats = (symbol, lastPrice, openPrice) => ({ symbol, lastPrice, openPrice, openTime: statsNow - 86400000, closeTime: statsNow })
  const dollarMarket = buildBinanceMarket([stats('EXUSDT', '2', '1')], { tether: 1.1 }, { tether: 10 }, statsNow)
  assert.equal(dollarMarket.usd.get('EX'), '2.2')
  assert.equal(dollarMarket.changes24h.get('EX'), 120, '计入USDT自身美元变化，不直接套交易对涨幅')
  const falling = buildBinanceMarket([stats('EXUSDT', '.5', '1'), stats('FLATUSDT', '2', '2'), { ...stats('STALEUSDT', '2', '1'), closeTime: statsNow - 7200000 }], { tether: 1 }, { tether: 0 }, statsNow)
  assert.equal(falling.changes24h.get('EX'), -50)
  assert.equal(falling.changes24h.get('FLAT'), 0)
  assert.ok(!falling.usd.has('STALE'))
  assert.equal(buildBinanceMarket([stats('EXUSDT', '2', '1')], { tether: 1 }, {}, statsNow).changes24h.get('EX'), undefined, '结算币历史美元价未知时不猜涨跌')
  assert.equal(buildBinanceMarket([{ ...stats('EXUSDT', '2', '0') }], { tether: 1 }, { tether: 0 }, statsNow).changes24h.get('EX'), undefined)
  const olderQuote = { ...amount('old'), usdPrice: 55000, change24h: 1, positions: [{ accountId: 'old', quantity: 1, quantityText: '1', valueCents: 5500000 }] }
  const newerQuote = { ...amount('new'), usdPrice: 60000, change24h: -2, positions: [{ accountId: 'new', quantity: 1, quantityText: '1', valueCents: 6000000 }] }
  const quoteAccounts = [{ id: 'old', updatedAt: '2026-10-19T04:00:00Z' }, { id: 'new', updatedAt: '2026-10-20T04:00:00Z' }]
  for (const rows of [[olderQuote, newerQuote], [newerQuote, olderQuote]]) {
    const combined = combineHoldings(rows, quoteAccounts)[0]
    assert.equal(combined.usdPrice, 60000)
    assert.equal(combined.change24h, -2)
    assert.equal(combined.positions.length, 2)
    assert.ok(combined.positions.every(position => position.valueCents === 6000000), '所有账户按最终现价统一重算金额')
  }
  const settlementAssets = [{ asset: 'USDT', walletBalance: '2500', unrealizedProfit: '10' }, { asset: 'USDC', walletBalance: '300', unrealizedProfit: '-5' }]
  const noPrices = parseFuturesBalances(settlementAssets, new Map(), 'account')
  assert.deepEqual(noPrices.holdings.map(asset => asset.positions[0].quantityText), ['2500', '300'])
  assert.ok(noPrices.holdings.every(asset => asset.usdPrice === null))
  assert.equal(noPrices.pnlCents, null, '缺报价不冒充零盈亏，不丢弃真实数量')
  const priced = parseFuturesBalances(settlementAssets, new Map([['USDT', '.9998'], ['USDC', '1.0002']]), 'account')
  assert.equal(priced.pnlCents, 500)
  assert.equal(priced.holdings[0].positions[0].valueCents, 249950)
  assert.equal(priced.holdings[1].positions[0].valueCents, 30006)

  // 分组、股票分类和失败保留断言；仅准备，未获同意不运行。
  const walletAsset = (asset, free) => ({ asset, free, locked: '0', freeze: '0', withdrawing: '0' })
  const walletRows = [{ walletName: 'Spot', assetBalances: [walletAsset('BTC', '1')] }, { walletName: 'Funding', assetBalances: [walletAsset('BTC', '.25'), walletAsset('EQ_DRAM', '2'), walletAsset('USD', '100'), walletAsset('USDT', '50')] }]
  const quoteMap = new Map([['BTC', '60000'], ['USDT', '.9998'], ['USD', '1']])
  const funding = parseWalletScope(walletRows, walletScopes[0], 'funding-id', quoteMap, new Set(['DRAM']))
  const fundingStocks = parseWalletScope(walletRows, walletScopes[1], 'funding-stocks-id', quoteMap, new Set(['DRAM']))
  assert.deepEqual(funding.holdings.map(asset => asset.symbol), ['BTC', 'USDT'])
  assert.equal(funding.holdings[0].positions[0].quantityText, '0.25', '钱包总览中的Spot不能重复纳入')
  assert.deepEqual(fundingStocks.holdings.map(asset => [asset.symbol, asset.market]), [['DRAM', 'us'], ['USD', 'crypto']])
  assert.equal(countOriginalAccounts([{ ...acc({ id: 'a', name: '假资料' }, 'funding'), originName: 'Funding' }, { ...acc({ id: 'a', name: '假资料' }, 'funding-stocks'), originName: 'Funding' }]), 1, '拆分资金账户的展示不增加实际账户数量')
  assert.equal(fundingStocks.holdings[1].category, '现金与稳定币')
  assert.equal(parseWalletScope(walletRows, walletScopes[2], 'alpha-id', quoteMap, new Set()), null, '未返回钱包不能冒充空钱包')
  assert.throws(() => parseWalletScope([{ walletName: 'Funding', balance: '2' }], walletScopes[0], 'id', quoteMap, new Set()), /完整/)
  assert.throws(() => parseWalletScope([{ walletName: 'Funding', assetBalances: [walletAsset('DRAM', '1')] }], walletScopes[0], 'id', quoteMap, null), /类别/)
  assert.equal(stockBidPrice({ symbol: 'DRAM', bidPrice: '48.89', askPrice: '49' }, 'DRAM'), '48.89')
  assert.throws(() => stockBidPrice({ symbol: 'AAPL', bidPrice: '10' }, 'DRAM'), /不匹配/)
  assert.throws(() => stockBidPrice({ symbol: 'DRAM', bidPrice: '0' }, 'DRAM'), /有效/)
  assert.deepEqual(visibleBinanceGroups([
    { id: 'live-spot', kind: '交易所', status: 'ok', pnlCents: 0 },
    { id: 'alpha', kind: '交易所', accountGroup: '现货', status: 'ok', pnlCents: 0 },
    { id: 'live-usdm', kind: '合约账户', status: 'ok', pnlCents: 0 },
    { id: 'stocks', kind: '交易所', accountGroup: '股票', status: 'ok', pnlCents: 0 },
    { id: 'margin', kind: '交易所', accountGroup: '杠杆', status: 'error', pnlCents: 0 },
  ], new Set(['alpha']), new Set(['live-usdm'])), ['现货', '合约', '杠杆'], 'Alpha合并；空股票分类隐藏；失败范围不能静默隐藏')

  let stockScopeState = 'ok'
  const scopedService = createConnectionService(join(folder, 'wallet-scopes'), { vault: dependencies.vault, dailyPrices: dependencies.dailyPrices, readers: { binance: async connection => {
    const spotAccount = { ...acc(connection, 'spot'), identity: 'scoped-account', accountGroup: '现货', walletCoverage: [{ suffix: 'stocks', label: '股票', group: '股票', status: stockScopeState === 'missing' ? 'pending' : 'ok', warning: stockScopeState === 'missing' ? '本次未返回' : '' }] }
    const parts = [{ account: spotAccount, holdings: [], contracts: [] }]
    if (stockScopeState !== 'missing') parts.push({ account: { ...acc(connection, 'stocks'), accountGroup: '股票', originName: 'Stocks' }, holdings: stockScopeState === 'empty' ? [] : [holding('binance:equity:EQ_DRAM', `live-${connection.id}-stocks`, 'DRAM', 'ETF', '2', '40', '隔离假资料', { market: 'us', category: '股票' })], contracts: [] })
    return parts
  } } })
  const scopedInput = { type: 'binance', name: '分类假资料', consent: true, apiKey: 's'.repeat(32), apiSecret: 'k'.repeat(32) }
  const scoped = await scopedService.upsert(scopedInput), scopedId = scoped.connections[0].id
  assert.equal(scoped.snapshot.holdings[0].positions[0].valueCents, 8000)
  stockScopeState = 'missing'
  const retained = await scopedService.sync(scopedId, true)
  assert.equal(retained.snapshot.holdings[0].positions[0].valueCents, 8000, '本次未返回钱包不能清空旧持仓')
  assert.equal(retained.snapshot.accounts.find(account => account.accountGroup === '股票').status, 'error')
  stockScopeState = 'empty'
  assert.equal((await scopedService.sync(scopedId, true)).snapshot.holdings.length, 0, '明确成功取得空明细才清除旧持仓')

  const service = createConnectionService(folder, dependencies)
  const input = { type: 'binance', name: '模拟币安', consent: true, apiKey: 'a'.repeat(32), apiSecret: 'b'.repeat(32) }
  let state = await service.upsert(input)
  const binanceId = state.connections[0].id
  const original = structuredClone(state.snapshot)
  assert.equal(state.snapshot.accounts.find(account => account.id.endsWith('-spot')).uid, '123456789', 'UID作为字符串保存；旧记录没有UID仍兼容')
  assert.equal(state.snapshot.accounts.length, 2)
  assert.equal(state.snapshot.holdings[0].positions[0].valueCents, 4200000)
  assert.equal(state.snapshot.accounts.reduce((sum, item) => sum + item.pnlCents, 0), -2000)
  assert.equal(statSync(join(folder, 'connections.json')).mode & 0o777, 0o600)
  const raw = readFileSync(join(folder, 'connections.json'), 'utf8')
  assert.ok(!raw.includes(input.apiKey) && !raw.includes(input.apiSecret) && !raw.includes('apiSecret'))
  assert.equal(secrets.get(binanceId).apiSecret, input.apiSecret)
  failBinance = true
  state = await service.sync(binanceId, true)
  assert.equal(state.connections[0].status, 'error')
  assert.deepEqual(state.snapshot.holdings, original.holdings, '断网不能清空已保存余额')
  assert.equal(state.snapshot.accounts[0].updatedAt, stamp)
  assert.equal(state.snapshot.accounts[1].pnlCents, -2000)
  failBinance = false

  state = await service.upsert({ ...input, name: '同账户另一把密钥', apiKey: 'c'.repeat(32) })
  const duplicateId = state.connections[1].id
  assert.equal(state.connections[1].status, 'error')
  assert.equal(state.snapshot.holdings.length, 2, '同一币安账户不能重复计入')
  await service.remove(duplicateId)
  identity = 'different-account'
  state = await service.upsert({ ...input, apiKey: 'd'.repeat(32) }, binanceId)
  assert.equal(state.connections[0].status, 'error')
  assert.deepEqual(state.snapshot.holdings, original.holdings, '换成另一账户的密钥不能混入旧余额')
  identity = 'account-a'

  const wallet = { type: 'wallet', name: '模拟钱包', address: '0x' + '1'.repeat(40), chains: ['eth', 'base'], provider: 'rpc', consent: true }
  state = await service.upsert(wallet)
  const walletId = state.connections.find(item => item.type === 'wallet').id
  assert.equal(state.snapshot.accounts.length, 4)
  await assert.rejects(service.upsert({ ...wallet, chains: ['base'] }), /已经添加/)
  await assert.rejects(service.upsert({ ...wallet, address: '0x' + '2'.repeat(40) }, walletId), /更换地址/)
  failEth = true
  state = await service.sync(walletId, true)
  assert.equal(state.snapshot.accounts.find(item => item.id.endsWith('-eth')).status, 'error')
  assert.ok(state.snapshot.holdings.some(item => item.id === 'evm:1:native'), '单链失败保留该链原余额')
  assert.ok(state.snapshot.holdings.some(item => item.id === 'evm:8453:native'), '其他网络仍可独立成功')
  zeroBinance = true
  state = await service.sync(binanceId, true)
  assert.ok(!state.snapshot.holdings.some(item => item.id.startsWith('binance:')), '成功读到零余额时移除旧持仓')
  assert.ok(state.snapshot.holdings.some(item => item.id.startsWith('evm:')), '币安刷新不影响钱包')
  await service.remove(walletId)
  assert.equal(secrets.has(walletId), false)
  assert.equal(service.list().snapshot.holdings.length, 0)
  assert.deepEqual(createConnectionService(folder, dependencies).list(), service.list(), '重建服务仍读到相同资料')

  // 行情只更新价格，不调用余额读取；多页面合并请求、失败保留和并发移除均使用假资料。
  zeroBinance = false
  let marketReads = 0
  const fakeMarket = async snapshot => {
    marketReads++
    return { holdings: new Map(snapshot.holdings.map(asset => [asset.id, { usdPrice: asset.symbol === 'BTC' ? '65000' : '1', at: Date.now() }])), contracts: new Map() }
  }
  const marketFolder = join(folder, 'market')
  const marketService = createConnectionService(marketFolder, { ...dependencies, marketPrices: fakeMarket })
  const marketInitial = await marketService.upsert(input)
  const marketAccountsBefore = structuredClone(marketInitial.snapshot.accounts)
  const firstRefresh = marketService.refreshMarket(), sameRefresh = marketService.refreshMarket()
  assert.equal(firstRefresh, sameRefresh)
  const marketRefreshed = await firstRefresh
  assert.equal(marketReads, 1)
  assert.equal(marketRefreshed.snapshot.holdings.find(asset => asset.symbol === 'BTC').usdPrice, 65000)
  assert.deepEqual(marketRefreshed.snapshot.accounts, marketAccountsBefore)
  await marketService.refreshMarket()
  assert.equal(marketReads, 1, '一分钟内多次请求不重复读取行情')
  const marketFileBefore = readFileSync(join(marketFolder, 'connections.json'), 'utf8')
  const failedMarketService = createConnectionService(marketFolder, { ...dependencies, marketPrices: async () => { throw new Error('隔离断网') } })
  await assert.rejects(failedMarketService.refreshMarket())
  assert.equal(readFileSync(join(marketFolder, 'connections.json'), 'utf8'), marketFileBefore)
  let releaseMarket
  const concurrentMarket = createConnectionService(marketFolder, { ...dependencies, marketPrices: async snapshot => {
    await new Promise(resolve => { releaseMarket = resolve })
    return fakeMarket(snapshot)
  } })
  const pendingMarket = concurrentMarket.refreshMarket()
  await concurrentMarket.remove(marketInitial.connections[0].id)
  releaseMarket()
  assert.equal((await pendingMarket).snapshot.holdings.length, 0)
  assert.equal(concurrentMarket.list().connections.length, 0, '旧行情不能恢复已移除的账户')

  const empty = { manualAssets: [], customizations: {}, snapshots: [], changes: [] }
  assertWorkspacePortfolio({ ...empty, costs: { 'binance:BTC': { ['live-' + binanceId + '-spot']: { averagePrice: 60000, quantity: .7, currency: 'USD', feeIncluded: false, updatedAt: stamp } } } })
  assert.throws(() => assertWorkspacePortfolio({ ...empty, costs: { bitcoin: { nonexistent: { averagePrice: 1, quantity: 1, currency: 'USD', feeIncluded: false, updatedAt: stamp } } } }), /账户/)
  server = createServer(createWorkspaceApi(join(folder, 'api'), { ...dependencies, marketPrices: fakeMarket }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const headers = { 'X-Investment-App': '1', 'Content-Type': 'application/json' }
  assert.equal((await fetch(url + '/api/connections')).status, 403)
  assert.equal((await fetch(url + '/api/market/refresh', { method: 'POST' })).status, 403)
  assert.equal((await fetch(url + '/api/connections', { method: 'POST', headers: { ...headers, Origin: 'https://outside.example' }, body: JSON.stringify(input) })).status, 403)
  const response = await fetch(url + '/api/connections', { method: 'POST', headers, body: JSON.stringify(input) })
  assert.equal(response.status, 200)
  const returned = await response.text()
  assert.ok(!returned.includes(input.apiKey) && !returned.includes(input.apiSecret))
  const marketResponse = await fetch(url + '/api/market/refresh', { method: 'POST', headers })
  assert.equal(marketResponse.status, 200)
  assert.equal((await marketResponse.json()).snapshot.holdings.find(asset => asset.symbol === 'BTC').usdPrice, 65000)
  assert.equal((await fetch(url + '/api/connections', { method: 'POST', headers, body: '{bad' })).status, 400)
  assert.equal((await fetch(url + '/api/connections', { method: 'POST', headers, body: JSON.stringify({ ...wallet, address: '不是钱包地址' }) })).status, 400)
  const addedId = JSON.parse(returned).connections[0].id
  assert.equal((await fetch(url + '/api/connections/' + addedId, { method: 'DELETE', headers })).status, 200)
  // 走势点只由服务器记录，页面不能再写入。
  assert.equal((await fetch(url + '/api/equity-history', { method: 'POST', headers, body: JSON.stringify({ t: Math.floor(Date.now() / 1000), net: 100, gross: 100, rows: [], prices: [], contracts: [], accounts: [] }) })).status, 404)
  assert.equal((await fetch(url + '/api/equity-history', { headers })).status, 200)
  console.log('隔离模拟检查通过：读取权限、金额精度、重复账户、单链失败、余额保留、零余额和成本兼容。未调用真实平台或系统钥匙串。')
} finally { if (server) await new Promise(resolve => server.close(resolve)); rmSync(folder, { recursive: true, force: true }) }

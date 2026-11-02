import Decimal from 'decimal.js'
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici'
export { Decimal }
Decimal.set({ precision: 60 })
const dispatcher = new EnvHttpProxyAgent()
export class ConnectionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
export function parseResponseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if ((key === 'tranId' || key === 'tradeId') && typeof value === 'number' && !Number.isSafeInteger(value)) {
      // 流水编号必须从原文保留，不能把已舍入的数字再转成字符串。
      if (!context?.source || !/^-?\d{1,30}$/.test(context.source)) throw new ConnectionError('平台流水编号无法精确读取，请保留旧记录并检查运行环境或返回格式。', 502)
      return context.source
    }
    return value
  })
}
export async function requestJson(url, options = {}) {
  let response
  try { response = await proxyFetch(url, { ...options, dispatcher, redirect: 'error', signal: AbortSignal.timeout(18000) }) }
  catch { throw new ConnectionError('连接数据服务失败或超时，请检查网络后重试。', 502) }
  const chunks = []; let size = 0
  for await (const chunk of response.body) { size += chunk.length; if (size > 12 * 1024 * 1024) throw new ConnectionError('数据服务返回内容过大，本次未替换已保存资料。', 502); chunks.push(Buffer.from(chunk)) }
  const text = Buffer.concat(chunks).toString('utf8')
  let value
  try { value = parseResponseJson(text) } catch (error) { if (error instanceof ConnectionError) throw error; throw new ConnectionError('数据服务返回格式无法识别。', 502) }
  if (!response.ok) {
    const code = Number(value?.code)
    const messages = { '-2015': '密钥、读取权限或IP白名单不匹配，请核对后重试，不要打开交易权限。', '-2014': 'API Key格式不正确。', '-1022': '签名未通过，请核对API Secret。', '-1021': '电脑与平台时间不一致，请校准系统时间后重试。' }
    throw new ConnectionError(messages[code] ?? (response.status === 429 || response.status === 418 ? '查询过于频繁，请稍后再试。' : response.status === 401 || response.status === 403 ? '服务拒绝访问，请核对读取密钥、套餐或网络地区限制。' : '数据服务暂时不可用，请稍后再试。'), 502)
  }
  return value
}
export function decimal(value, label = '金额', signed = false) {
  let result
  try { if (typeof value !== 'string' && typeof value !== 'number' && !Decimal.isDecimal(value)) throw new Error(); result = new Decimal(value) } catch { throw new ConnectionError(label + '格式无法识别，已保留原资料。', 502) }
  if (!result.isFinite() || (!signed && result.isNegative()) || result.abs().gt('1e30')) throw new ConnectionError(label + '超出范围，已保留原资料。', 502)
  return result
}
export function cents(value) {
  const n = decimal(value, '估值', true).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  if (!Number.isSafeInteger(n)) throw new ConnectionError('估值过大，无法准确保存。', 502)
  return n
}
export function validChange24h(value) { return typeof value === 'number' && Number.isFinite(value) && value >= -100 && Math.abs(value) <= Number.MAX_SAFE_INTEGER }
export const icons = { BTC: '/icons/btc.png', ETH: '/icons/eth.png', BNB: '/icons/bnb.png', SOL: '/icons/sol.png', USDT: '/icons/usdt.png', USDC: '/icons/usdc.png' }
export function holding(id, accountId, symbol, name, quantity, price, source, extras = {}) {
  const qty = decimal(quantity, '持有数量')
  const usdPrice = price === null ? null : decimal(price, '报价').toNumber()
  const colors = { BTC: '#e0ac62', ETH: '#9faed5', SOL: '#a4b89a', BNB: '#cfbb75', USDT: '#7eb9a5', USDC: '#85adca' }
  const palette = ['#90bcb1', '#c5ad8c', '#9ba8ca', '#a6b390', '#bba1b5', '#91b5c0']
  const color = colors[symbol] ?? palette[[...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % palette.length]
  return { id, symbol: String(symbol).slice(0, 40), name: String(name).slice(0, 120), market: 'crypto', category: ['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'USDE'].includes(symbol) ? '现金与稳定币' : '加密资产', usdPrice, change24h: null, icon: icons[symbol] ?? '', color, source, description: '按成功查询时的余额和报价保存，不含完整历史成本。', ...extras, positions: [{ accountId, quantity: qty.toNumber(), quantityText: qty.toFixed(), valueCents: usdPrice === null ? null : cents(qty.mul(price)) }] }
}
let pricesCache
export function nativeChanges24h() { return pricesCache && Date.now() - pricesCache.at < 60000 ? pricesCache.changes : {} }
export function nativePriceTimes() { return pricesCache?.times ?? {} }
export async function nativePrices(force = false) {
  if (!force && pricesCache && Date.now() - pricesCache.at < 60000) return pricesCache.data
  const data = {}, changes = {}, times = {}
  try {
    const result = await requestJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,binancecoin,polygon-ecosystem-token,tether,usd-coin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true')
    if (result && typeof result === 'object' && !Array.isArray(result)) for (const [id, item] of Object.entries(result)) {
      if (typeof item?.usd !== 'number' || item.usd <= 0 || !Number.isFinite(item.usd) || !Number.isSafeInteger(item.last_updated_at) || Math.abs(Date.now() / 1000 - item.last_updated_at) > (force ? 300 : 3600)) continue
      data[id] = item.usd
      times[id] = item.last_updated_at * 1000
      if (validChange24h(item.usd_24h_change)) changes[id] = item.usd_24h_change
    }
  } catch { /* 不让一个行情来源中断其他来源。 */ }
  await Promise.all([['USDTUSD', 'tether'], ['USDCUSD', 'usd-coin']].map(async ([pair, id]) => {
    if (data[id]) return
    try {
      const result = await requestJson('https://api.kraken.com/0/public/Ticker?pair=' + pair)
      if (!Array.isArray(result?.error) || result.error.length || !result.result) return
      const price = decimal(Object.values(result.result)[0]?.c?.[0], '稳定币美元报价')
      if (price.gt(0)) { data[id] = price.toNumber(); times[id] = Date.now() }
    } catch { /* 两种稳定币分别查询，失败保留未知，不默认当作1美元。 */ }
  }))
  const missingChanges = Object.keys(data).filter(id => changes[id] === undefined)
  if (missingChanges.length) {
    try {
      const result = await requestJson('https://coins.llama.fi/percentage/' + missingChanges.map(id => encodeURIComponent('coingecko:' + id)).join(',') + '?period=24h&lookForward=false')
      for (const id of missingChanges) if (validChange24h(result?.coins?.['coingecko:' + id])) changes[id] = result.coins['coingecko:' + id]
    } catch { /* 缺24小时数据不影响现价和余额读取。 */ }
  }
  pricesCache = { at: Date.now(), data, changes, times }; return data
}
export function remoteIcon(url) {
  if (typeof url !== 'string' || url.length > 1500) return ''
  try {
    const parsed = new URL(url)
    const allowed = ['moralis.io', 'moralis.com', 'coingecko.com', 'coinmarketcap.com']
    const plainPath = !parsed.search && !parsed.hash
    const github = parsed.hostname === 'raw.githubusercontent.com' && plainPath
    const walletIcon = github && /^\/trustwallet\/assets\/master\/blockchains\/[a-z0-9]+\/(?:info|assets\/(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}))\/logo\.png$/.test(parsed.pathname)
    const stockIcon = github && /^\/nvstly\/icons\/main\/ticker_icons\/[A-Z0-9.-]{1,15}\.png$/.test(parsed.pathname) || plainPath && (parsed.hostname === 'www.roundhillinvestments.com' && parsed.pathname === '/assets/img/favicon.png' || parsed.hostname === 'companiesmarketcap.com' && parsed.pathname === '/img/company-logos/256/SPCX.webp' || parsed.hostname === 'financialmodelingprep.com' && (parsed.pathname === '/image-stock/CRCL.png' || /^\/image-stock\/\d{6}\.(SS|SZ|BJ)\.png$/.test(parsed.pathname)))
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !(walletIcon || stockIcon || allowed.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)))) return ''
    return '/api/token-icon?url=' + encodeURIComponent(parsed.href)
  } catch { return '' }
}
export function validIconImage({ buffer, type }) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 512 * 1024) return false
  if (type === 'image/png') return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(16) <= 4096 && buffer.readUInt32BE(20) > 0 && buffer.readUInt32BE(20) <= 4096
  if (type === 'image/jpeg') return buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
  return type === 'image/webp' && buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
}
export async function fetchIcon(url) {
  if (!remoteIcon(url)) throw new ConnectionError('图标来源不受支持。')
  let upstream
  try { upstream = await proxyFetch(url, { dispatcher, redirect: 'error', signal: AbortSignal.timeout(8000) }) } catch { throw new ConnectionError('图标暂不可用。', 502) }
  const type = upstream.headers.get('content-type')?.split(';')[0]
  if (!upstream.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new ConnectionError('图标格式不受支持。')
  const chunks = []; let size = 0
  for await (const chunk of upstream.body) { size += chunk.length; if (size > 512 * 1024) { await upstream.body.cancel().catch(() => {}); throw new ConnectionError('图标过大。') }; chunks.push(Buffer.from(chunk)) }
  const image = { type, buffer: Buffer.concat(chunks) }
  if (!validIconImage(image)) throw new ConnectionError('图标内容无法识别。', 502)
  return image
}
export function sendIcon(image, response) {
  response.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }); response.end(image.buffer)
}
export async function serveIcon(url, response) {
  sendIcon(await fetchIcon(url), response)
}

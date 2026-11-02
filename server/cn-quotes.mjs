// A股行情：东方财富为主，腾讯行情备用；两者都是网页行情使用的公开接口，没有正式文档，失败时保留上次价格。
// 美股行情用腾讯行情，键写成 us:TSLA，价格为美元；A股键是6位代码。
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici'
import { ConnectionError, requestJson } from './connection-http.mjs'

const dispatcher = new EnvHttpProxyAgent()

const CACHE_MS = 300000
const MAX_CODES = 50

// 6位代码判断交易所：沪市 60/68/90，北交所 4/8/92，其余（00/30/20）为深市。
export function cnExchange(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null
  if (/^(60|68|90)/.test(code)) return { em: '1.' + code, qq: 'sh' + code }
  if (/^(4|8|92)/.test(code)) return { em: '0.' + code, qq: 'bj' + code }
  return { em: '0.' + code, qq: 'sz' + code }
}

// 美股代码：1-5位大写字母，可带一位后缀（如 BRK.B）。
export function usSymbol(key) {
  const symbol = typeof key === 'string' ? key.match(/^us:([A-Z]{1,5}(?:\.[A-Z])?)$/)?.[1] : null
  return symbol ?? null
}

const validPrice = value => Number.isFinite(value) && value > 0 && value <= 1e9

export function parseEastmoney(value, code) {
  const data = value?.data
  if (!data || data.f57 !== code || !Number.isInteger(data.f59)) return null
  const scale = 10 ** data.f59, price = data.f43 / scale, prevClose = data.f60 / scale
  if (!validPrice(price) || !validPrice(prevClose) || !Number.isSafeInteger(data.f86)) return null
  return { name: String(data.f58 ?? '').trim().slice(0, 40), price, prevClose, at: data.f86 * 1000 }
}

// 腾讯行情一行：v_sz001309="51~德明利~001309~现价~昨收~...~yyyyMMddHHmmss~..."
export function parseTencent(line, code) {
  const fields = line.match(/="([^"]*)"/)?.[1]?.split('~')
  if (!fields || fields[2] !== code) return null
  const price = Number(fields[3]), prevClose = Number(fields[4]), time = fields[30]
  if (!validPrice(price) || !validPrice(prevClose) || !/^\d{14}$/.test(time ?? '')) return null
  const at = Date.parse(`${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}+08:00`)
  return Number.isFinite(at) ? { name: fields[1].trim().slice(0, 40), price, prevClose, at } : null
}

// 腾讯美股行情时间是美东时间，夏令时 UTC-4、冬令时 UTC-5，两种都试一遍取对得上的。
function newYorkTime(text) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
  if (!match) return NaN
  const local = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])
  for (const hours of [4, 5]) {
    const candidate = local + hours * 3600000
    if (new Date(candidate).toLocaleString('sv-SE', { timeZone: 'America/New_York' }) === text) return candidate
  }
  return NaN
}

// 腾讯美股一行：v_usTSLA="200~特斯拉~TSLA.OQ~现价~昨收~...~2026-10-28 16:00:01~..."
export function parseTencentUs(line, symbol) {
  const fields = line.match(/="([^"]*)"/)?.[1]?.split('~')
  if (!fields || !fields[2]?.startsWith(symbol + '.')) return null
  const price = Number(fields[3]), prevClose = Number(fields[4]), at = newYorkTime(fields[30] ?? '')
  return validPrice(price) && validPrice(prevClose) && Number.isFinite(at) ? { name: fields[1].trim().slice(0, 40), price, prevClose, at } : null
}

export async function gbkText(url) {
  let response
  try { response = await proxyFetch(url, { dispatcher, redirect: 'error', signal: AbortSignal.timeout(8000) }) } catch { throw new ConnectionError('A股行情连接失败。', 502) }
  const buffer = await response.arrayBuffer()
  if (!response.ok || buffer.byteLength > 256 * 1024) throw new ConnectionError('A股行情暂不可用。', 502)
  return new TextDecoder('gbk').decode(buffer)
}

export function createCnQuoteService({ fetchJson = requestJson, fetchText = gbkText, now = () => Date.now() } = {}) {
  const cache = new Map()
  async function read(codes) {
    const wanted = [...new Set(codes)].filter(code => cnExchange(code) || usSymbol(code)).slice(0, MAX_CODES)
    const fresh = wanted.filter(code => !cache.has(code) || now() - cache.get(code).fetchedAt >= CACHE_MS)
    const missing = []
    await Promise.all(fresh.filter(code => cnExchange(code)).map(async code => {
      try {
        const quote = parseEastmoney(await fetchJson(`https://push2.eastmoney.com/api/qt/stock/get?secid=${cnExchange(code).em}&fields=f43,f57,f58,f59,f60,f86`), code)
        if (quote) cache.set(code, { quote, fetchedAt: now() }); else missing.push(code)
      } catch { missing.push(code) }
    }))
    if (missing.length) {
      try {
        const text = await fetchText('https://qt.gtimg.cn/q=' + missing.map(code => cnExchange(code).qq).join(','))
        for (const line of text.split(';')) {
          const code = line.match(/v_(?:sh|sz|bj)(\d{6})=/)?.[1]
          const quote = code && missing.includes(code) ? parseTencent(line, code) : null
          if (quote) cache.set(code, { quote, fetchedAt: now() })
        }
      } catch { /* 两个来源都失败时保留上次价格。 */ }
    }
    const us = fresh.filter(code => usSymbol(code))
    if (us.length) {
      try {
        const text = await fetchText('https://qt.gtimg.cn/q=' + us.map(code => 'us' + usSymbol(code)).join(','))
        for (const line of text.split(';')) {
          const symbol = line.match(/v_us([A-Z.]+)=/)?.[1]
          const quote = symbol && us.includes('us:' + symbol) ? parseTencentUs(line, symbol) : null
          if (quote) cache.set('us:' + symbol, { quote, fetchedAt: now() })
        }
      } catch { /* 取不到时保留上次价格。 */ }
    }
    return Object.fromEntries(wanted.flatMap(code => cache.has(code) ? [[code, cache.get(code).quote]] : []))
  }
  return { read }
}

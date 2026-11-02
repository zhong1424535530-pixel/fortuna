import { canValueReward, futuresRewardLabels } from '../src/data/transaction-rewards.ts'
import { valueRewards } from './reward-valuation.mjs'
import { validTransactionState } from '../src/data/transactions.ts'
import { createHash } from 'node:crypto'
import { createBinanceClient, parseBinanceUid } from './binance-reader.mjs'
import { ConnectionError, decimal, requestJson } from './connection-http.mjs'

const spot = 'https://api.binance.com', futures = 'https://fapi.binance.com'
const day = 86400000
const transfers = {
  MAIN_UMFUTURE: '现货 → U本位合约', UMFUTURE_MAIN: 'U本位合约 → 现货',
  MAIN_FUNDING: '现货 → 资金', FUNDING_MAIN: '资金 → 现货',
  FUNDING_UMFUTURE: '资金 → U本位合约', UMFUTURE_FUNDING: 'U本位合约 → 资金',
  MAIN_MARGIN: '现货 → 全仓杠杆', MARGIN_MAIN: '全仓杠杆 → 现货',
  MAIN_CMFUTURE: '现货 → 币本位合约', CMFUTURE_MAIN: '币本位合约 → 现货',
}
const badData = (detail = '') => new ConnectionError(`平台返回的交易资料无法核对${detail ? '（' + detail + '）' : ''}，本范围未读全，已保留旧记录。`, 502)
const text = (value, limit = 100) => {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f]/.test(value)) throw badData()
  return value
}
const identifier = value => {
  if (!(typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value) && value >= 0)) throw badData()
  return text(String(value))
}
const assetName = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(value)) throw badData(); return value }
const amount = (value, signed = false) => decimal(value, '交易金额', signed).toFixed()
const timestamp = value => { if (!Number.isSafeInteger(value) || value < 1483228800000 || value > Date.now() + 300000) throw badData(); return value }
export function normalizeSpotPairs(value) {
  if (!Array.isArray(value) || value.length > 40 || value.some(symbol => typeof symbol !== 'string' || !/^[A-Z0-9]{2,40}$/.test(symbol))) throw new ConnectionError('请填写最多40个交易对，例如BTCUSDT、ETHUSDC。')
  return [...new Set(value)]
}

// 满页不能当完整；用时间拆分避免同一毫秒有多笔时跳过记录。
export async function readTradeWindow(fetchPage, start, end, onRows) {
  const rows = await fetchPage({ startTime: String(start), endTime: String(end), limit: '1000' })
  if (!Array.isArray(rows) || rows.length > 1000) throw badData('返回的记录列表或条数异常')
  const invalid = rows.findIndex(row => !Number.isSafeInteger(row?.time) || row.time < start || row.time > end)
  onRows(invalid === -1 ? rows : rows.filter(row => Number.isSafeInteger(row?.time) && row.time >= start && row.time <= end))
  if (invalid !== -1) throw badData(`第${invalid + 1}条的交易时间或日期范围异常`)
  if (rows.length < 1000) return
  if (start === end) throw new ConnectionError('同一毫秒记录达到平台上限，本范围未读全；请保留已有记录，后续通过平台账单补全。', 502)
  const mid = Math.floor((start + end) / 2)
  await readTradeWindow(fetchPage, start, mid, onRows)
  await readTradeWindow(fetchPage, mid + 1, end, onRows)
}

export function fundingHistoryWindows(now, previous) {
  const oldest = new Date(now), dayOfMonth = oldest.getUTCDate()
  oldest.setUTCDate(1); oldest.setUTCMonth(oldest.getUTCMonth() - 3)
  const monthEnd = new Date(oldest); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
  oldest.setUTCDate(Math.min(dayOfMonth, monthEnd.getUTCDate()))
  const start = oldest.getTime(), end = now - 7 * day - 1
  const ranges = previous?.status === 'ok' ? [{ start, end: Math.min(end, previous.from - 1) }, { start: Math.max(start, previous.to + 1), end }] : [{ start, end }]
  const windows = []
  for (const range of ranges.reverse()) for (let cursor = range.end; cursor >= range.start; cursor -= 7 * day) windows.push({ start: Math.max(range.start, cursor - 7 * day + 1), end: cursor })
  return { start, windows }
}

export async function readRebateWindow(fetchPage, onRows) {
  let expected = null, received = 0
  for (let page = 1; page <= 10; page++) {
    const response = await fetchPage({ page: String(page) }), data = response?.data
    if (response?.status !== 'OK' || response.code !== '000000000' || !data || data.page !== page || !Number.isSafeInteger(data.totalRecords) || data.totalRecords < 0 || data.totalRecords > 100000 || !Number.isSafeInteger(data.totalPageNum) || data.totalPageNum < 0 || !Array.isArray(data.data) || data.data.length > 200) throw badData()
    if (!expected) expected = { records: data.totalRecords, pages: data.totalPageNum }
    if (data.totalRecords !== expected.records || data.totalPageNum !== expected.pages || received + data.data.length > expected.records) throw badData()
    if (!expected.records) { if (expected.pages > 1 || data.data.length) throw badData(); return }
    if (expected.pages < page || !data.data.length) throw badData()
    onRows(data.data)
    received += data.data.length
    if (page === expected.pages) { if (received !== expected.records) throw badData(); return }
  }
  throw new ConnectionError('奖励记录超过单次10页查询范围，本次未读全，已保留取得的记录。', 502)
}

export async function readBinanceTransactions(connection, credentials, options) {
  const { snapshot, records: priorRecords, previous, fetchJson = requestJson } = options
  const requested = normalizeSpotPairs(options.spotPairs ?? [])
  const deadline = Date.now() + 190000
  let calls = 0, stopped = false
  const limitedFetch = async (...args) => {
    if (stopped || ++calls > 220 || Date.now() > deadline) throw new ConnectionError('本次读取达到时间或请求上限，部分范围未读全，可稍后再次同步。', 502)
    try { return await fetchJson(...args) }
    catch (error) { if (/查询过于频繁/.test(error.message)) stopped = true; throw error }
  }
  const signed = await createBinanceClient(credentials, limitedFetch)
  const clockStart = await limitedFetch(futures + '/fapi/v1/time')
  const now = timestamp(clockStart?.serverTime), initial = now - 7 * day
  const accountData = await signed(spot, '/api/v3/account', { omitZeroBalances: 'true' })
  const uid = parseBinanceUid(accountData?.uid), identity = createHash('sha256').update(uid).digest('hex')
  const own = snapshot.accounts.filter(account => account.sourceId === 'live-' + connection.id)
  if (!own.some(account => account.identity === identity)) throw new ConnectionError('请先成功读取这个币安账户的余额，确认账户身份后再同步交易记录。')
  if (!Array.isArray(accountData.balances)) throw badData()
  const rows = [], syncs = [], rawIncome = []
  const base = (scope, nativeId, time) => ({
    id: `binance:${identity}:${scope}:${nativeId}`, connectionId: connection.id, connectionName: connection.name, identity,
    account: scope === 'spot' ? '现货' : scope === 'usdm' ? 'U本位合约' : '充值提现', scope, time: timestamp(time),
    asset: '', quantity: '0', symbol: '', quoteAsset: '', quoteQuantity: null, price: null, fees: [], realizedPnl: null, pnlAsset: '',
    status: '已完成', orderId: '', txHash: '', network: '', address: '', note: '', relatedTradeId: '',
  })
  const priorScopes = previous.filter(item => item.identity === identity).sort((a, b) => b.at - a.at)
  const coveredRows = (records, key, start, end) => records.filter(row => row.identity === identity && row.time >= start && row.time <= end && (key === 'income' ? row.scope === 'usdm' && row.type === '资金费' : ['spot', 'usdm'].includes(row.scope) && key === row.scope + ':' + row.symbol && ['买入', '卖出'].includes(row.type)))
  const combined = () => [...new Map([...priorRecords, ...rows].map(row => [row.id, row])).values()]
  const addCoverage = (item, start) => {
    const prior = priorScopes.find(old => old.key === item.key), old = prior?.coverage
    const oldRows = old ? coveredRows(priorRecords, item.key, old.from, old.to) : []
    const continuous = old && old.to >= start - 1 && oldRows.length === old.count && (item.key === 'income' || item.key.startsWith('spot:') || oldRows.every(row => row.positionSide))
    if (!continuous && old && old.to < start && oldRows.length === old.count && (item.key === 'income' || item.key.startsWith('spot:') || prior.positionCheck)) {
      const checkpoint = { coverage: old, ...(prior.positionCheck ? { positionCheck: prior.positionCheck } : {}) }
      item.checkpoints = [...new Map([...(prior.checkpoints ?? []), checkpoint].map(part => [part.coverage.from + ':' + part.coverage.to, part])).values()]
    }
    const from = continuous ? Math.min(old.from, start) : start
    item.coverage = { from, to: now, count: coveredRows(combined(), item.key, from, now).length }
    if (item.checkpoints) item.checkpoints = item.checkpoints.filter(part => part.coverage.from < from || part.coverage.to > now)
  }
  const from = key => {
    const prior = priorScopes.find(item => item.key === key)
    return prior?.status === 'ok' && prior.lastSuccess ? Math.max(initial, Math.min(now, prior.lastSuccess) - 600000) : initial
  }
  async function scope(key, label, work, start = from(key)) {
    const item = { connectionId: connection.id, connectionName: connection.name, identity, key, label, status: 'ok', from: start, to: now, at: now, lastSuccess: null, warning: '' }
    const prior = priorScopes.find(old => old.key === key)
    if (prior?.checkpoints) item.checkpoints = prior.checkpoints
    const before = rows.length
    try { await work(start); item.lastSuccess = now; if (key === 'income' || key.startsWith('usdm:') || key.startsWith('spot:')) addCoverage(item, start) }
    catch (error) { item.status = rows.length > before ? 'partial' : 'error'; item.warning = error instanceof ConnectionError ? error.message : '此范围暂时读取失败，已保留旧记录。'; item.lastSuccess = priorScopes.find(old => old.key === key)?.lastSuccess ?? null }
    if (item.status !== 'ok') {
      const prior = priorScopes.find(old => old.key === key)
      if (prior?.coverage) item.coverage = prior.coverage
      if (prior?.positionCheck) item.positionCheck = prior.positionCheck
    }
    syncs.push(item)
    return item
  }
  await scope('deposits', '充值', async start => {
    for (let offset = 0; ; offset += 1000) {
      const page = await signed(spot, '/sapi/v1/capital/deposit/hisrec', { startTime: String(start), endTime: String(now), offset: String(offset), limit: '1000' })
      if (!Array.isArray(page) || page.length > 1000) throw badData()
      const parsed = page.map(item => {
        const status = ({ 0: '处理中', 1: '已完成', 2: '失败', 6: '待确认', 7: '失败', 8: '待确认' })[item.status]
        if (!status) throw badData()
        return { ...base('capital', 'deposit:' + identifier(item.id), item.insertTime), type: '充值', asset: assetName(item.coin), quantity: amount(item.amount), status, txHash: text(item.txId ?? '', 512), network: text(item.network ?? '', 80), address: text(item.address ?? '', 256), account: item.walletType === 1 ? '资金' : '现货', note: status === '待确认' ? '请在平台确认到账或可用状态。' : '' }
      })
      if (parsed.some(row => row.time < start || row.time > now)) throw badData()
      rows.push(...parsed)
      if (page.length < 1000) break
    }
  }, initial)
  await scope('withdrawals', '提现', async start => {
    for (let offset = 0; ; offset += 1000) {
      const page = await signed(spot, '/sapi/v1/capital/withdraw/history', { startTime: String(start), endTime: String(now), offset: String(offset), limit: '1000' })
      if (!Array.isArray(page) || page.length > 1000) throw badData()
      const parsed = page.map(item => {
        const status = ({ 0: '处理中', 1: '失败', 2: '待确认', 3: '失败', 4: '处理中', 5: '失败', 6: '已完成' })[item.status]
        if (!status || typeof item.applyTime !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.applyTime)) throw badData()
        return { ...base('capital', 'withdrawal:' + identifier(item.id), Date.parse(item.applyTime.replace(' ', 'T') + 'Z')), type: '提现', asset: assetName(item.coin), quantity: amount(item.amount), fees: [{ asset: assetName(item.coin), quantity: amount(item.transactionFee) }], status, txHash: text(item.txId ?? '', 512), network: text(item.network ?? '', 80), address: text(item.address ?? '', 256), account: item.walletType === 1 ? '资金' : '现货' }
      })
      if (parsed.some(row => row.time < start || row.time > now)) throw badData()
      rows.push(...parsed)
      if (page.length < 1000) break
    }
  }, initial)
  // 收支同时用于发现已平仓的合约，不能只看当前仓位。
  function parseIncomePage(page, fundingOnly) {
    let failures = 0, firstFailure = ''
    page.forEach((item, index) => {
      if (!fundingOnly && ['TRANSFER', 'INTERNAL_TRANSFER', 'FUNDING_FEE'].includes(item?.incomeType)) return
      try {
        const field = (key, label, parse) => {
          try { return parse(item?.[key]) }
          catch { throw badData(`第${index + 1}条的${label}格式异常`) }
        }
        const nativeId = field('tranId', '流水编号', identifier)
        const incomeType = field('incomeType', '收支类型', value => text(value, 80))
        if (fundingOnly && incomeType !== 'FUNDING_FEE') throw badData(`第${index + 1}条不是资金费记录`)
        const symbol = field('symbol', '交易品种', value => text(value ?? '', 64))
        const type = futuresRewardLabels.has(incomeType) ? '奖励' : ({ FUNDING_FEE: '资金费', REALIZED_PNL: '已实现盈亏', COMMISSION: '手续费' })[incomeType] ?? '其他收支'
        const asset = field('asset', '结算币种', assetName)
        const quantity = field('income', fundingOnly ? '资金费金额' : '收支金额', value => amount(value, true))
        const at = field('time', '交易时间', timestamp)
        const tradeId = ['手续费', '已实现盈亏'].includes(type) && symbol && item.tradeId && String(item.tradeId) !== '0' ? field('tradeId', '关联成交编号', identifier) : ''
        const record = { ...base('usdm', 'income:' + incomeType + ':' + nativeId, at), type, asset, quantity, symbol, relatedTradeId: tradeId ? `binance:${identity}:usdm:${symbol}:${tradeId}` : '', note: incomeType }
        if (!validTransactionState({ records: [record], syncs: [] })) throw badData(`第${index + 1}条的编号长度或金额精度超出保存范围`)
        rows.push(record)
        if (fundingOnly && !/^[A-Z0-9_]{2,40}$/.test(symbol)) throw badData(`第${index + 1}条资金费缺少明确交易品种，金额已保留，不能确认到单笔仓位`)
        if (at >= initial && /^[A-Z0-9_]{2,40}$/.test(symbol)) rawIncome.push({ symbol })
      } catch (error) {
        failures++
        if (!firstFailure) firstFailure = error instanceof ConnectionError ? error.message : `第${index + 1}条内容格式异常`
      }
    })
    if (failures) throw new ConnectionError(`${firstFailure} 本批有${failures}条未通过，合法记录已保留。`, 502)
  }
  const incomeState = await scope('income', 'U本位资金费', async start => {
    await readTradeWindow(params => signed(futures, '/fapi/v1/income', { ...params, incomeType: 'FUNDING_FEE' }), start, now, page => parseIncomePage(page, true))
  }, initial)
  const otherIncomeState = await scope('income:other', 'U本位其他收支 / 奖励', async start => {
    await readTradeWindow(params => signed(futures, '/fapi/v1/income', params), start, now, page => parseIncomePage(page, false))
  }, initial)
  for (const [direction, label] of Object.entries(transfers)) await scope('transfer:' + direction, label, async start => {
    let received = 0
    for (let current = 1; ; current++) {
      const page = await signed(spot, '/sapi/v1/asset/transfer', { type: direction, startTime: String(start), endTime: String(now), current: String(current), size: '100' })
      if (!Array.isArray(page?.rows) || page.rows.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0) throw badData()
      const parsed = page.rows.map(item => {
        const status = ({ CONFIRMED: '已完成', FAILED: '失败', PENDING: '处理中' })[item.status]
        if (!status || item.type !== direction) throw badData()
        return { ...base('transfer', direction + ':' + identifier(item.tranId), item.timestamp), type: '账户间转账', account: label, asset: assetName(item.asset), quantity: amount(item.amount), status, note: '自己账户间划转，不计作投资收益。' }
      })
      if (parsed.some(row => row.time < start || row.time > now)) throw badData()
      rows.push(...parsed); received += page.rows.length
      if (received >= page.total) break
      if (!page.rows.length) throw badData()
    }
  }, initial)
  let metadata = [], marketWarning = ''
  try {
    const data = await limitedFetch(spot + '/api/v3/exchangeInfo')
    if (!Array.isArray(data?.symbols)) throw badData()
    metadata = data.symbols
  } catch { marketWarning = '现货交易对目录未取得，只补查已知或手动填写的品种。' }
  const knownRecords = priorRecords.filter(row => row.identity === identity)
  const ownScopes = priorScopes.filter(item => /^(spot|usdm):/.test(item.key))
  const heldAssets = new Set(accountData.balances.filter(item => decimal(item.free).plus(decimal(item.locked)).gt(0)).map(item => assetName(item.asset)))
  const spotPairs = [...new Set([...requested, ...ownScopes.filter(item => item.key.startsWith('spot:')).map(item => item.key.slice(5)), ...metadata.filter(item => heldAssets.has(item.baseAsset) && item.isSpotTradingAllowed !== false).map(item => item.symbol)])]
  const futuresPairs = [...new Set([...rawIncome.map(item => item.symbol).filter(Boolean), ...ownScopes.filter(item => item.key.startsWith('usdm:')).map(item => item.key.slice(5)), ...snapshot.contracts.filter(item => own.some(account => account.id === item.accountId)).map(item => item.symbol)])]
  const catalog = new Map(metadata.map(item => [item.symbol, { asset: item.baseAsset, quote: item.quoteAsset }]))
  for (const row of knownRecords.filter(item => item.scope === 'spot' && item.symbol && item.quoteAsset)) if (!catalog.has(row.symbol)) catalog.set(row.symbol, { asset: row.asset, quote: row.quoteAsset })
  const candidates = [...futuresPairs.map(symbol => ({ scope: 'usdm', symbol })), ...spotPairs.map(symbol => ({ scope: 'spot', symbol }))]
  // 合约每个品种都要单独查，所以只先读近期有收支或有持仓的品种；久未交易的品种每轮只补少数几个，其余沿用上次结果。
  // 收支流水只回看7天，距上次成功读取超过6天时无法确认谁有动静，这一轮全部重读。
  const recentRead = priorScopes.find(item => item.key === 'income:other')?.lastSuccess
  const activeFutures = new Set(recentRead && now - recentRead < 6 * day ? [...rawIncome.map(item => item.symbol), ...snapshot.contracts.filter(item => own.some(account => account.id === item.accountId)).map(item => item.symbol)] : futuresPairs)
  const slowLane = 10, carried = new Set()
  const priority = task => task.scope === 'usdm' && activeFutures.has(task.symbol) ? -2 : requested.includes(task.symbol) && task.scope === 'spot' ? -1 : priorScopes.find(item => item.key === task.scope + ':' + task.symbol)?.lastSuccess ?? 0
  candidates.sort((a, b) => priority(a) - priority(b))
  let queried = 0, slow = 0
  for (const task of candidates) {
    const { scope: kind, symbol } = task, isSpot = kind === 'spot', key = kind + ':' + symbol
    if (!isSpot && !activeFutures.has(symbol) && ++slow > slowLane) {
      const prior = priorScopes.find(old => old.key === key)
      if (prior) { syncs.push({ ...prior }); carried.add(key) }
      continue
    }
    await scope(key, (isSpot ? '现货 ' : 'U本位合约 ') + symbol, async start => {
      if (++queried > 80) throw new ConnectionError('单次最多补查80个交易对，此品种尚未读全，请稍后再同步。', 502)
      if (!/^[A-Z0-9_]{2,40}$/.test(symbol)) throw badData()
      const meta = isSpot ? catalog.get(symbol) : (() => { const quote = ['USDT', 'USDC'].find(value => symbol.endsWith(value)); return quote ? { asset: symbol.slice(0, -quote.length), quote } : null })()
      if (!meta) throw new ConnectionError('该交易对的资产与计价币尚无法确认，本次未读取；可能已下架或超出支持范围。', 502)
      const path = isSpot ? '/api/v3/myTrades' : '/fapi/v1/userTrades', host = isSpot ? spot : futures
      const parse = page => {
        const parsed = page.map(item => {
          if (item.symbol !== symbol || isSpot && typeof item.isBuyer !== 'boolean' || !isSpot && !['BUY', 'SELL'].includes(item.side)) throw badData()
          const buy = isSpot ? item.isBuyer : item.side === 'BUY'
          const pnlAsset = !isSpot ? assetName(item.marginAsset ?? meta.quote) : ''
          if (!isSpot && (!/^[1-9]\d*$/.test(identifier(item.id)) || !decimal(item.qty).gt(0))) throw badData()
          let note = ''
          if (!isSpot) {
            if (!['LONG', 'SHORT', 'BOTH'].includes(item.positionSide)) throw badData()
            note = item.positionSide === 'BOTH' ? '单向持仓；仅展示买卖方向，不推断开仓或平仓。' : item.positionSide === 'LONG' ? (buy ? '开多 / 增加多仓' : '平多 / 减少多仓') : (buy ? '平空 / 减少空仓' : '开空 / 增加空仓')
          }
          return { ...base(kind, symbol + ':' + identifier(item.id), item.time), type: buy ? '买入' : '卖出', asset: assetName(meta.asset), quantity: amount(item.qty), symbol, quoteAsset: assetName(meta.quote), quoteQuantity: amount(item.quoteQty), price: amount(item.price), fees: [{ asset: assetName(item.commissionAsset), quantity: amount(item.commission, true) }], realizedPnl: isSpot || item.realizedPnl === undefined ? null : amount(item.realizedPnl, true), pnlAsset, orderId: identifier(item.orderId), note, ...(!isSpot ? { positionSide: item.positionSide } : {}) }
        })
        rows.push(...parsed)
      }
      const step = isSpot ? day : 7 * day
      for (let cursor = start; cursor <= now; cursor += step) await readTradeWindow(params => signed(host, path, { ...params, symbol }), cursor, Math.min(now, cursor + step - 1), parse)
    }, !isSpot || requested.includes(symbol) ? initial : from(key))
  }
  // 较晚读取的仓位不能直接套在较早截止的成交上；期间有成交就暂缓确认。
  const completeFutures = syncs.filter(item => item.key.startsWith('usdm:') && item.status === 'ok' && !carried.has(item.key))
  const deferPosition = (item, warning) => {
    item.status = 'partial'; item.warning = warning
    const prior = priorScopes.find(old => old.key === item.key)
    if (prior?.positionCheck && prior.coverage) { item.positionCheck = prior.positionCheck; item.coverage = prior.coverage }
  }
  if (completeFutures.length) {
    try {
      const positions = await signed(futures, '/fapi/v3/positionRisk')
      if (!Array.isArray(positions)) throw badData()
      const quantities = new Map()
      for (const position of positions) {
        if (!/^[A-Z0-9_]{2,40}$/.test(position?.symbol) || !['LONG', 'SHORT', 'BOTH'].includes(position.positionSide)) throw badData()
        const quantity = amount(position.positionAmt, true), id = position.symbol + ':' + position.positionSide
        if (quantities.has(id) || position.positionSide === 'LONG' && decimal(quantity, '', true).lt(0) || position.positionSide === 'SHORT' && decimal(quantity, '', true).gt(0)) throw badData()
        quantities.set(id, quantity)
      }
      const clock = await limitedFetch(futures + '/fapi/v1/time')
      if (!Number.isSafeInteger(clock?.serverTime) || clock.serverTime <= now || clock.serverTime - now > day) throw badData()
      for (const item of completeFutures) {
        try {
          const symbol = item.key.slice(5)
          const recent = await signed(futures, '/fapi/v1/userTrades', { symbol, startTime: String(now + 1), endTime: String(clock.serverTime), limit: '1' })
          if (!Array.isArray(recent) || recent.length > 1) throw badData()
          if (recent.length) { deferPosition(item, '读取期间仍有新成交，暂不确认新的完整轮次；稍后再次同步。'); continue }
          item.positionCheck = { at: now, positions: ['LONG', 'SHORT', 'BOTH'].map(side => ({ side, quantity: quantities.get(symbol + ':' + side) ?? '0' })) }
        } catch { deferPosition(item, '仓位与成交截止时间暂未核对，保留已有结果；稍后再次同步。') }
      }
    } catch { for (const item of completeFutures) deferPosition(item, '当前仓位未能核对，暂不确认新的完整轮次；稍后再次同步。') }
  }
  // 返佣查询每页消耗较多账户额度，按小时补读，不拖累每次余额和交易更新。
  const lastRewardRead = priorScopes.find(item => item.key === 'rewards:spot')
  if (lastRewardRead && now - lastRewardRead.at < 3600000) syncs.push({ ...lastRewardRead, connectionId: connection.id, connectionName: connection.name })
  else await scope('rewards:spot', '现货奖励 / 返佣记录', async start => {
    const occurrences = new Map()
    await readRebateWindow(params => signed(spot, '/sapi/v1/rebate/taxQuery', { ...params, startTime: String(start), endTime: String(now) }), page => {
      const parsed = page.map(item => {
        if (![1, 2].includes(item.type)) throw badData()
        const asset = assetName(item.asset), quantity = amount(item.amount, true), time = timestamp(item.updateTime)
        if (time < start || time > now) throw badData()
        // shortcut: 平台无单笔编号；若改写金额或时间可能保留新旧两条，取得唯一编号后再改用它。
        // 重复项保留次数，编号不依赖分页位置。
        const key = createHash('sha256').update(JSON.stringify([item.type, asset, quantity, time])).digest('hex')
        const occurrence = (occurrences.get(key) ?? 0) + 1
        occurrences.set(key, occurrence)
        return { ...base('spot-rebate', key + ':' + occurrence, time), account: '现货', type: '奖励', asset, quantity, status: '已记录', note: item.type === 1 ? 'SPOT_COMMISSION_REBATE' : 'SPOT_REFERRAL_KICKBACK' }
      })
      rows.push(...parsed)
    })
  }, initial)
  const rewardRows = combined().filter(row => row.identity === identity && canValueReward(row)).sort((a, b) => b.time - a.time)
  if (rewardRows.length) await scope('rewards:valuation', '奖励折算价格', async () => {
    const valued = await valueRewards(rewardRows, knownRecords, limitedFetch)
    rows.push(...valued.records)
    if (valued.missing) throw new ConnectionError(`有${valued.missing}笔奖励缺少对应历史价格，暂不计入USDT合计，原始记录保留；后续自动更新继续补齐。`, 502)
  }, Math.min(initial, rewardRows.at(-1).time))
  // 先完成近期资金费和成交，再用剩余查询预算补历史；未完成不扩大核对范围。
  if (incomeState.status === 'ok') {
    const history = fundingHistoryWindows(now, { status: 'ok', ...incomeState.coverage })
    let coveredFrom = incomeState.coverage.from
    await scope('income:history', 'U本位资金费历史（近3个月）', async () => {
      for (const window of history.windows) {
        await readTradeWindow(params => signed(futures, '/fapi/v1/income', { ...params, incomeType: 'FUNDING_FEE' }), window.start, window.end, page => parseIncomePage(page, true))
        if (window.end >= coveredFrom - 1) coveredFrom = Math.min(coveredFrom, window.start)
      }
    }, history.start)
    if (coveredFrom < incomeState.coverage.from) addCoverage(incomeState, coveredFrom)
    incomeState.from = incomeState.coverage.from
  }
  const spotIssues = syncs.some(item => item.key.startsWith('spot:') && item.status !== 'ok')
  syncs.push({ connectionId: connection.id, connectionName: connection.name, identity, key: 'coverage:spot', label: '现货发现范围', status: 'partial', from: initial, to: now, at: now, lastSuccess: null, warning: [marketWarning, '现货按当前持有、曾查询和手动补充的交易对查询，不能保证包含已经卖光或已下架的全部品种。', spotIssues ? '部分交易对未读全，请查看下方状态。' : '', '杠杆成交、币本位、逐仓/子账户划转、理财及闪兑尚未接入。'].filter(Boolean).join(' ') })
  if (incomeState.status !== 'ok' || otherIncomeState.status !== 'ok') syncs.push({ connectionId: connection.id, connectionName: connection.name, identity, key: 'coverage:usdm', label: '合约发现范围', status: 'partial', from: initial, to: now, at: now, lastSuccess: null, warning: '合约收支未读全，无法确认所有已平仓品种；下次同步继续补查。' })
  else syncs.push({ connectionId: connection.id, connectionName: connection.name, identity, key: 'coverage:usdm', label: '合约发现范围', status: 'ok', from: initial, to: now, at: now, lastSuccess: now, warning: '按近7天合约收支、已知品种和当前仓位发现U本位交易对；逐笔读取状态另列。' })
  return { records: [...new Map(rows.map(row => [row.id, row])).values()], syncs }
}

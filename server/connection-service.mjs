import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createVault } from './secret-vault.mjs'
import { binanceGroups, connectionRefreshMs, emptyLive, exchanges, networks } from '../src/data/live-types.ts'
import { cents, ConnectionError, decimal, requestJson, validChange24h } from './connection-http.mjs'
import { readBinance } from './binance-reader.mjs'
import { readWallet } from './wallet-reader.mjs'
import { walletAddress } from './wallet-addresses.mjs'
import { readExchange } from './exchange-reader.mjs'
import { readBitunix } from './bitunix-reader.mjs'
import { addDailyOpenPrices } from './daily-prices.mjs'
import { validDayOpen } from '../src/data/daily-pnl.ts'
import { calendarToday } from '../src/data/return-range.ts'
import { applyMarketPrices, readMarketPrices } from './market-prices.mjs'
import { stockBidPrice } from './binance-wallets.mjs'
import { valueTransactionFees } from './fee-valuation.mjs'
import { feeRecordKey } from '../src/data/fee-valuation.ts'
import { createTransactionStore } from './transaction-store.mjs'
import { normalizeSpotPairs, readBinanceTransactions } from './binance-transactions.mjs'
import { readWalletTransactions } from './wallet-transactions.mjs'
import { dedupeNativeHoldings } from '../src/data/asset-identity.ts'
import { validMarginPools } from '../src/data/margin-risk.ts'
import { validExitOrders } from '../src/data/contract-protection.ts'
import { getDatabase, getDocument, setDocument, atomicDatabase, assertDatabaseWritable, withDatabaseWriter } from './database.mjs'

const connectionTypes = [...exchanges.map(item => item.id), 'wallet']

export function combineHoldings(rows, accounts = []) {
  const map = new Map(), quoteTimes = new Map()
  const times = new Map(accounts.map(account => [account.id, Date.parse(account.updatedAt ?? '') || 0]))
  const quoteTime = asset => Date.parse(asset.priceUpdatedAt ?? '') || Math.max(0, ...asset.positions.map(position => times.get(position.accountId) ?? 0))
  for (const row of dedupeNativeHoldings(rows)) {
    const existing = map.get(row.id)
    if (existing) {
      const newerPrice = row.usdPrice !== null && quoteTime(row) >= quoteTimes.get(row.id)
      if (newerPrice) { existing.usdPrice = row.usdPrice; existing.change24h = validChange24h(row.change24h) ? row.change24h : null; if (row.priceUpdatedAt) existing.priceUpdatedAt = row.priceUpdatedAt; else delete existing.priceUpdatedAt; quoteTimes.set(row.id, quoteTime(row)) }
      existing.positions.push(...row.positions)
      if (row.usdPrice !== null && validDayOpen(row.dayOpen) && (!validDayOpen(existing.dayOpen) || row.dayOpen.date >= existing.dayOpen.date)) {
        existing.dayOpen = row.dayOpen
      }
    }
    else { map.set(row.id, { ...row, positions: [...row.positions] }); quoteTimes.set(row.id, row.usdPrice === null ? -1 : quoteTime(row)) }
  }
  return [...map.values()].map(asset => asset.usdPrice === null ? asset : { ...asset, positions: asset.positions.map(position => {
    const quantity = decimal(position.quantityText ?? position.quantity, '持有数量')
    if (quantity.toNumber() !== position.quantity) throw new ConnectionError('持仓数量无法核对，已保留原资料。', 502)
    return { ...position, valueCents: cents(quantity.mul(asset.usdPrice)) }
  }) })
}
function validTrackedTokens(value) {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 50 || !value.every(item => item && networks.some(network => network.id === item.chain) && typeof item.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(item.address) && !/^0x0{40}$/i.test(item.address))) return false
  return new Set(value.map(item => item.chain + ':' + item.address.toLowerCase())).size === value.length
}
export function validateState(state) {
  if (!state || !Array.isArray(state.connections) || state.connections.length > 40 || !state.snapshot || !['accounts', 'holdings', 'contracts'].every(key => Array.isArray(state.snapshot[key]))) throw new Error()
  const ids = new Set()
  const validTime = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
  const statuses = ['pending', 'ok', 'partial', 'error']
  for (const item of state.connections) {
    if (!/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id) || !connectionTypes.includes(item.type) || typeof item.name !== 'string' || item.name.length > 80 || !statuses.includes(item.status) || !validTime(item.updatedAt) || typeof item.warning !== 'string' || typeof item.hasCredential !== 'boolean') throw new Error()
    if (item.type === 'wallet') {
      const family = item.walletFamily ?? 'evm'
      if (!['evm', 'btc', 'solana'].includes(family) || walletAddress(item.address, family) !== item.address || !Array.isArray(item.chains) || family === 'evm' && !item.chains.length || item.chains.length > networks.length || new Set(item.chains).size !== item.chains.length || item.chains.some(id => !networks.some(network => network.id === id)) || !['rpc', 'moralis'].includes(item.provider) || !validTrackedTokens(item.trackedTokens)) throw new Error()
      if (family !== 'evm' && (item.chains.length || item.provider !== 'rpc' || item.trackedTokens?.length) || item.trackedTokens?.some(token => !item.chains.includes(token.chain))) throw new Error()
    }
    ids.add(item.id)
  }
  const accountIds = new Set(state.snapshot.accounts.map(item => item.id))
  if (accountIds.size !== state.snapshot.accounts.length || accountIds.size > 400 || state.snapshot.holdings.length > 10000 || state.snapshot.contracts.length > 1000) throw new Error()
  for (const account of state.snapshot.accounts) if (!/^live-/.test(account.id) || !ids.has(account.sourceId?.slice(5)) || !['pending', 'ok', 'partial', 'error'].includes(account.status) || !(account.pnlCents === null || Number.isSafeInteger(account.pnlCents)) || !validTime(account.updatedAt) || typeof account.name !== 'string' || typeof account.warning !== 'string') throw new Error()
  for (const account of state.snapshot.accounts) {
    if (account.marginPools !== undefined && !validMarginPools(account.marginPools)) throw new Error()
    if (account.uid !== undefined && (typeof account.uid !== 'string' || !/^[1-9][0-9]{0,29}$/.test(account.uid))) throw new Error()
    if (account.accountGroup !== undefined && !binanceGroups.includes(account.accountGroup) || account.originName !== undefined && (typeof account.originName !== 'string' || account.originName.length > 80)) throw new Error()
    if (account.walletCoverage !== undefined && (!Array.isArray(account.walletCoverage) || account.walletCoverage.length > 4 || new Set(account.walletCoverage.map(item => item.suffix)).size !== account.walletCoverage.length || account.walletCoverage.some(item => !['funding', 'funding-stocks', 'alpha', 'stocks'].includes(item.suffix) || !binanceGroups.includes(item.group) || !['ok', 'pending', 'error'].includes(item.status) || typeof item.label !== 'string' || item.label.length > 80 || typeof item.warning !== 'string' || item.warning.length > 1000))) throw new Error()
  }
  const assetIds = new Set()
  for (const position of state.snapshot.contracts) if (!validExitOrders(position.exitOrders)) throw new Error()
  for (const asset of state.snapshot.holdings) {
    if (typeof asset.id !== 'string' || asset.id.length > 100 || assetIds.has(asset.id) || typeof asset.name !== 'string' || typeof asset.icon !== 'string' || !(asset.market === 'us' && asset.category === '股票' || asset.market === 'crypto' && ['加密资产', '现金与稳定币'].includes(asset.category)) || typeof asset.symbol !== 'string' || !Array.isArray(asset.positions) || !(asset.usdPrice === null || Number.isFinite(asset.usdPrice) && asset.usdPrice >= 0)) throw new Error()
    assetIds.add(asset.id)
    if (asset.dayOpen !== undefined && !validDayOpen(asset.dayOpen)) throw new Error()
    if (asset.priceUpdatedAt !== undefined && (typeof asset.priceUpdatedAt !== 'string' || !validTime(asset.priceUpdatedAt))) throw new Error()
    if (asset.change24h !== undefined && asset.change24h !== null && !validChange24h(asset.change24h)) throw new Error()
    if (new Set(asset.positions.map(position => position.accountId)).size !== asset.positions.length) throw new Error()
    for (const position of asset.positions) if (!accountIds.has(position.accountId) || !Number.isFinite(position.quantity) || position.quantity < 0 || !(position.valueCents === null || Number.isSafeInteger(position.valueCents))) throw new Error()
  }
  for (const item of state.snapshot.contracts) if (!accountIds.has(item.accountId) || item.priceUpdatedAt !== undefined && (typeof item.priceUpdatedAt !== 'string' || !validTime(item.priceUpdatedAt)) || !(item.unrealizedPnlCents === null || Number.isSafeInteger(item.unrealizedPnlCents)) || !Number.isFinite(item.quantity) || item.quantity < 0 || !(item.markPriceUsd === null || Number.isFinite(item.markPriceUsd) && item.markPriceUsd >= 0) || !(item.entryPriceUsd === null || Number.isFinite(item.entryPriceUsd) && item.entryPriceUsd >= 0) || !['做多', '做空'].includes(item.direction) || !['全仓', '逐仓', '未知'].includes(item.marginMode) || !(item.marginCents === null || Number.isSafeInteger(item.marginCents) && item.marginCents >= 0) || !(item.leverage === null || Number.isFinite(item.leverage) && item.leverage > 0) || !(item.liquidationPriceUsd === null || Number.isFinite(item.liquidationPriceUsd) && item.liquidationPriceUsd >= 0)) throw new Error()
  const sum = state.snapshot.holdings.reduce((total, asset) => total + asset.positions.reduce((subtotal, position) => subtotal + BigInt(position.valueCents ?? 0), 0n), 0n) + state.snapshot.accounts.reduce((total, account) => total + BigInt(account.pnlCents ?? 0), 0n)
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error()
  for (const position of state.snapshot.contracts) if (position.markPriceUsd !== null) cents(decimal(position.quantity).mul(position.markPriceUsd))
  const scan = value => { if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { if (['apiKey', 'apiSecret', 'passphrase', 'providerKey', 'privateKey', 'mnemonic'].includes(key)) throw new Error(); scan(entry) } }
  scan(state)
  return state
}
function normalizeInput(input, prior) {
  const type = prior?.type ?? input.type
  if (!connectionTypes.includes(type) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new ConnectionError('请选择账户类型并填写名称。')
  const connection = { id: prior?.id ?? randomUUID(), type, name: input.name.trim(), status: 'pending', updatedAt: null, warning: '', hasCredential: prior?.hasCredential ?? false }
  const secret = {}
  const field = value => typeof value === 'string' && value.length <= 1024 && !/[\r\n\x00]/.test(value) ? value.trim() : ''
  if (type !== 'wallet') {
    const key = field(input.apiKey), value = field(input.apiSecret), passphrase = field(input.passphrase)
    const needsPassphrase = exchanges.find(item => item.id === type).passphrase
    if (!prior || key || value || passphrase) {
      if (!key || !value || key.length < 8 || value.length < 8 || needsPassphrase && !passphrase) throw new ConnectionError('请填齐此平台的密钥和口令；修改时全部留空可保留。')
      if (type === 'binance' && (!/^[A-Za-z0-9]{16,256}$/.test(key) || !/^[A-Za-z0-9]{16,256}$/.test(value))) throw new ConnectionError('请填写有效的币安API Key和Secret。')
      Object.assign(secret, { apiKey: key, apiSecret: value }, needsPassphrase ? { passphrase } : {})
      connection.hasCredential = true
    }
  } else {
    const family = prior?.walletFamily ?? (prior ? 'evm' : input.walletFamily ?? 'evm')
    if (!['evm', 'btc', 'solana'].includes(family) || input.walletFamily && input.walletFamily !== family) throw new ConnectionError('更换钱包种类请重新添加。')
    const address = walletAddress(input.address, family)
    const chains = family === 'evm' ? input.chains : []
    if (!Array.isArray(chains) || family === 'evm' && !chains.length || chains.length > networks.length || new Set(chains).size !== chains.length || chains.some(id => !networks.some(network => network.id === id))) throw new ConnectionError('请选择支持的网络。')
    if (!['rpc', 'moralis'].includes(input.provider ?? 'rpc') || family !== 'evm' && input.provider === 'moralis') throw new ConnectionError('请选择免费读取方式。')
    if (prior && prior.address !== address) throw new ConnectionError('更换地址请移除后重新添加，避免旧地址余额混入。')
    const trackedTokens = input.trackedTokens ?? prior?.trackedTokens ?? []
    if (!validTrackedTokens(trackedTokens) || family !== 'evm' && trackedTokens.length || trackedTokens.some(token => !chains.includes(token.chain))) throw new ConnectionError('补充代币的网络或识别地址无效。')
    Object.assign(connection, { address, chains, walletFamily: family, provider: input.provider ?? 'rpc', trackedTokens })
    const key = field(input.providerKey)
    if (connection.provider === 'moralis' && !key && !prior?.hasCredential) throw new ConnectionError('旧版查询密钥缺失，请切换免费读取。')
    if (key) { secret.providerKey = key; connection.hasCredential = true }
  }
  return { connection, secret }
}
export function createConnectionService(folder, dependencies = {}) {
  const transactions = createTransactionStore(folder)
  const feeValuer = dependencies.feeValuer ?? valueTransactionFees
  const transactionReader = dependencies.transactionReader ?? readBinanceTransactions
  const walletTransactionReader = dependencies.walletTransactionReader ?? readWalletTransactions
  const path = join(folder, 'connections.json')
  const vault = dependencies.vault ?? createVault(folder)
  const readers = dependencies.readers ?? { binance: readBinance, okx: readExchange, gate: readExchange, bitget: readExchange, bybit: readExchange, bitunix: readBitunix, wallet: readWallet }
  const dailyPrices = dependencies.dailyPrices ?? addDailyOpenPrices
  const marketPrices = dependencies.marketPrices ?? readMarketPrices
  let marketPending = null, marketAttemptAt = 0
  let feeValuationPending = null, feeValuationAt = 0
  const busy = new Set()
  const transactionBusy = new Set()
  const lastAttempt = new Map()
  const automaticFailures = new Map()
  const now = dependencies.now ?? Date.now
  let mutating = false
  function read() {
    const database = getDatabase(folder)
    if (database) {
      try {
        const state = validateState(getDocument(database, 'connections') ?? emptyLive())
        return { ...state, snapshot: { ...state.snapshot, holdings: dedupeNativeHoldings(state.snapshot.holdings) } }
      } catch { throw new ConnectionError('资料库中的账户资料无法读取，已暂停修改，请先保留资料库后处理。', 503) }
    }
    if (!existsSync(path)) return emptyLive()
    try {
      const state = validateState(JSON.parse(readFileSync(path, 'utf8')))
      return { ...state, snapshot: { ...state.snapshot, holdings: dedupeNativeHoldings(state.snapshot.holdings) } }
    } catch { throw new ConnectionError('接入资料文件无法读取，已暂停修改，请先保留原文件再处理。', 503) }
  }
  const save = state => withDatabaseWriter(folder, () => saveState(state))
  function saveState(state) {
    try { validateState(state) } catch { throw new ConnectionError('读取资料不完整，本次未替换已有记录。', 502) }
    assertDatabaseWritable(folder)
    const database = getDatabase(folder)
    // 每分钟的行情和账户快照不再逐次入库：没有页面读取它们，按此速度三年会占满磁盘；历史价格由净值走势点（equity_points）保存。
    if (database) return atomicDatabase(database, () => setDocument(database, 'connections', state))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const temp = path + '.' + randomUUID() + '.tmp'
    let fd
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined; assertDatabaseWritable(folder); renameSync(temp, path) }
    catch { throw new ConnectionError('接入资料无法保存，原文件保留。', 503) }
    finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp) }
  }
  const list = () => read()
  function refreshMarket() {
    if (marketPending) return marketPending
    if (mutating || busy.size || Date.now() - marketAttemptAt < 55000) return Promise.resolve(list())
    const initial = read()
    if (!initial.snapshot.holdings.length && !initial.snapshot.contracts.length) return Promise.resolve(initial)
    marketAttemptAt = Date.now()
    marketPending = (async () => {
      const stockKeys = new Map()
      const stockQuote = async asset => {
        const connection = initial.connections.find(item => item.type === 'binance' && item.hasCredential && asset.positions.some(position => initial.snapshot.accounts.some(account => account.id === position.accountId && account.sourceId === 'live-' + item.id)))
        if (!connection) return null
        if (!stockKeys.has(connection.id)) stockKeys.set(connection.id, vault.get(connection.id))
        const credentials = await stockKeys.get(connection.id)
        return stockBidPrice(await requestJson('https://api.binance.com/sapi/v1/equity/market/quote?symbol=' + encodeURIComponent(asset.symbol), { headers: { 'X-MBX-APIKEY': credentials.apiKey } }), asset.symbol)
      }
      const quotes = await marketPrices(initial.snapshot, { connections: initial.connections, stockQuote })
      let snapshot = applyMarketPrices(initial.snapshot, quotes)
      const parts = snapshot.accounts.map(account => ({ account, contracts: [], holdings: snapshot.holdings.flatMap(asset => { const positions = asset.positions.filter(position => position.accountId === account.id); return positions.length ? [{ ...asset, positions }] : [] }) }))
      try {
        const refs = new Map((await dailyPrices(parts)).flatMap(part => part.holdings.filter(asset => validDayOpen(asset.dayOpen)).map(asset => [asset.id, asset.dayOpen])))
        snapshot = { ...snapshot, holdings: snapshot.holdings.map(asset => refs.has(asset.id) ? { ...asset, dayOpen: refs.get(asset.id) } : asset) }
      } catch { /* 现价仍可更新，缺日初价下一轮重试。 */ }
      const current = read()
      // 网络查询期间账户可能被刷新或移除，旧报价不能把旧持仓写回来。
      if (mutating || busy.size || JSON.stringify(current) !== JSON.stringify(initial)) return current
      if (JSON.stringify(snapshot) !== JSON.stringify(current.snapshot)) save({ ...current, snapshot })
      return list()
    })().finally(() => { marketPending = null })
    return marketPending
  }
  async function sync(id, force = false, automatic = false) {
    if (automatic) {
      if (mutating || marketPending || busy.has(id) || transactionBusy.has(id)) return list()
      const connection = read().connections.find(item => item.id === id)
      if (!connection) return list()
      const time = now(), savedAt = Date.parse(connection.updatedAt ?? '')
      const last = lastAttempt.get(id) ?? (Number.isFinite(savedAt) && savedAt <= time ? savedAt : 0)
      const interval = Math.min(900000, connectionRefreshMs(connection.type) * 2 ** Math.min(4, automaticFailures.get(id) ?? 0))
      if (last && time - last < interval) return list()
    }
    if (mutating || busy.has(id) || transactionBusy.has(id)) throw new ConnectionError('此账户正在处理，请稍后再试。', 409)
    if (!force && now() - (lastAttempt.get(id) ?? 0) < 10000) throw new ConnectionError('请间隔10秒再刷新，避免平台限流。', 429)
    const connection = read().connections.find(item => item.id === id)
    if (!connection) throw new ConnectionError('没有找到该接入。', 404)
    busy.add(id); lastAttempt.set(id, now())
    try {
      let parts, failure = ''
      try { parts = await readers[connection.type](connection, connection.hasCredential ? await vault.get(id) : {}) } catch (error) { failure = error instanceof ConnectionError ? error.message : '接入读取失败，已保留上次资料。' }
      if (parts) { try { parts = await dailyPrices(parts) } catch { /* 24小时行情或日初参考价不可用不影响原余额读取。 */ } }
      const state = read()
      const identity = parts?.find(part => part.account.identity)?.account.identity
      const priorIdentity = state.snapshot.accounts.find(account => account.sourceId === 'live-' + id && account.identity)?.identity
      if (identity && (priorIdentity && priorIdentity !== identity || state.snapshot.accounts.some(account => account.sourceId !== 'live-' + id && account.identity === identity))) {
        failure = priorIdentity && priorIdentity !== identity ? '这把密钥属于另一个账户，请移除后重新添加。' : '这个账户已添加过，未重复计入资产。'
        parts = undefined
      }
      if (parts && !['binance', 'wallet'].includes(connection.type) && parts.some(part => part.account.status === 'error') && state.snapshot.accounts.some(old => old.sourceId === 'live-' + id && old.updatedAt && !parts.some(part => part.account.id === old.id))) {
        failure = '账户分类发生变化，但本次未完整读取，已保留上次资料。'
        parts = undefined
      }
      const sourceId = 'live-' + id
      let accounts = state.snapshot.accounts.filter(item => item.sourceId !== sourceId)
      let holdings = state.snapshot.holdings.flatMap(item => { const positions = item.positions.filter(position => !position.accountId.startsWith(sourceId + '-')); return positions.length ? [{ ...item, positions }] : [] })
      let contracts = state.snapshot.contracts.filter(item => !item.accountId.startsWith(sourceId + '-'))
      if (!parts) {
        parts = state.snapshot.accounts.filter(item => item.sourceId === sourceId).map(account => ({ account: { ...account, status: 'error', warning: failure }, holdings: [], contracts: [] }))
        if (!parts.length) parts = [{ account: { id: sourceId + '-pending', sourceId, name: connection.name, kind: connection.type === 'wallet' ? '钱包' : '交易所', icon: exchanges.find(item => item.id === connection.type)?.icon ?? '', color: '#9aaad3', status: 'error', updatedAt: null, pnlCents: 0, warning: failure }, holdings: [], contracts: [] }]
      }
      const coverage = parts.find(part => part.account.walletCoverage)?.account.walletCoverage ?? []
      for (const old of state.snapshot.accounts.filter(account => account.sourceId === sourceId && !parts.some(part => part.account.id === account.id))) {
        const scope = coverage.find(item => old.id === sourceId + '-' + item.suffix)
        if (scope && scope.status !== 'ok') parts.push({ account: { ...old, status: 'error', warning: scope.warning + ' 保留上次成功读取的资料。' }, holdings: [], contracts: [] })
      }
      for (const part of parts) {
        const old = state.snapshot.accounts.find(item => item.id === part.account.id)
        if (part.account.status === 'error' && old) {
          accounts.push({ ...old, status: 'error', warning: part.account.warning })
          holdings.push(...state.snapshot.holdings.flatMap(item => { const positions = item.positions.filter(position => position.accountId === old.id); return positions.length ? [{ ...item, positions }] : [] }))
          contracts.push(...state.snapshot.contracts.filter(item => item.accountId === old.id))
        } else {
          accounts.push(part.account)
          holdings.push(...part.holdings.map(asset => {
            const prior = state.snapshot.holdings.find(item => item.id === asset.id)?.dayOpen
            const priced = asset.usdPrice !== null && part.account.updatedAt ? { ...asset, priceUpdatedAt: asset.priceUpdatedAt ?? part.account.updatedAt } : asset
            return !priced.dayOpen && validDayOpen(prior) && prior.date === calendarToday() ? { ...priced, dayOpen: prior } : priced
          }))
          contracts.push(...part.contracts)
        }
      }
      const own = accounts.filter(item => item.sourceId === sourceId)
      const usable = own.filter(item => item.updatedAt)
      const scopeWarnings = coverage.filter(item => item.status !== 'ok').map(item => item.label + '：' + item.warning)
      const updated = { ...connection, status: own.every(item => item.status === 'ok') && !scopeWarnings.length ? 'ok' : own.every(item => item.status === 'error') ? 'error' : 'partial', updatedAt: usable.map(item => item.updatedAt).sort().at(-1) ?? null, warning: [...new Set([...own.map(item => item.warning), ...scopeWarnings].filter(Boolean))].join('；').slice(0, 1500) }
      save({ connections: state.connections.map(item => item.id === id ? updated : item), snapshot: { accounts, holdings: combineHoldings(holdings, accounts), contracts } })
      if (updated.status === 'error') automaticFailures.set(id, Math.min(4, (automaticFailures.get(id) ?? 0) + 1))
      else automaticFailures.delete(id)
      return list()
    } finally { busy.delete(id) }
  }
  async function upsert(input, id) {
    if (mutating) throw new ConnectionError('正在保存其他接入，请稍后重试。', 409)
    mutating = true
    let savedId
    try {
    const current = read(), prior = id ? current.connections.find(item => item.id === id) : null
    if (id && !prior) throw new ConnectionError('没有找到该接入。', 404)
    if (id && (busy.has(id) || transactionBusy.has(id))) throw new ConnectionError('账户正在读取，请稍后修改。', 409)
    if (!prior && current.connections.length >= 40) throw new ConnectionError('最多添加40个接入。')
    const { connection, secret } = normalizeInput(input, prior)
    if (connection.type === 'wallet' && current.connections.some(item => item.id !== connection.id && item.type === 'wallet' && item.address === connection.address && (item.walletFamily ?? 'evm') === connection.walletFamily && (connection.walletFamily !== 'evm' || item.chains.some(chain => connection.chains.includes(chain))))) throw new ConnectionError('这个地址的所选网络已经添加过，请修改已有钱包，避免重复计入。')
    const oldSecret = Object.keys(secret).length && prior ? await vault.get(id) : {}
    // shortcut: Bitunix子账户只返回主UID；换密钥需重新添加，避免混入另一子账户余额。
    if (prior?.type === 'bitunix' && secret.apiKey && oldSecret.apiKey !== secret.apiKey) throw new ConnectionError('更换Bitunix密钥请移除后重新添加，避免不同子账户余额混入。')
    if (Object.keys(secret).length) await vault.set(connection.id, { ...oldSecret, ...secret })
    try {
      const latest = read()
      save({ ...latest, connections: prior ? latest.connections.map(item => item.id === id ? connection : item) : [...latest.connections, connection] })
    } catch (error) {
      if (Object.keys(secret).length) { try { if (prior) await vault.set(connection.id, oldSecret); else await vault.remove(connection.id) } catch { /* 不把凭据回退失败输出到日志。 */ } }
      throw error
    }
    savedId = connection.id
    } finally { mutating = false }
    return sync(savedId, true)
  }
  async function syncTransactions(id, input = {}) {
    if (mutating || busy.has(id) || transactionBusy.has(id)) throw new ConnectionError('此账户正在处理，请稍后再同步交易记录。', 409)
    const key = 'transactions:' + id
    if (Date.now() - (lastAttempt.get(key) ?? 0) < 10000) throw new ConnectionError('请间隔10秒再同步交易记录。', 429)
    const state = read(), connection = state.connections.find(item => item.id === id)
    if (!connection || !['binance', 'wallet'].includes(connection.type)) throw new ConnectionError('目前仅支持已添加的币安账户和钱包。', 400)
    const spotPairs = normalizeSpotPairs(input.spotPairs ?? [])
    if (connection.type === 'wallet' && spotPairs.length) throw new ConnectionError('补查交易对只适用于币安现货，请清空后再同步钱包。')
    const prior = transactions.list()
    transactionBusy.add(id); lastAttempt.set(key, Date.now())
    try {
      const result = connection.type === 'wallet'
        ? await walletTransactionReader(connection, { records: prior.records, previous: prior.syncs })
        : await transactionReader(connection, await vault.get(id), { snapshot: state.snapshot, records: prior.records, previous: prior.syncs, spotPairs })
      return transactions.save(result.records, result.syncs)
    } finally { transactionBusy.delete(id) }
  }
  async function valueSavedTransactionFees() {
    if (feeValuationPending) return feeValuationPending
    if (Date.now() - feeValuationAt < 30000) return transactions.list()
    feeValuationAt = Date.now()
    feeValuationPending = (async () => {
      const prior = transactions.list()
      const valued = await feeValuer(prior.records, prior.records)
      const original = new Map(prior.records.map(row => [row.id, feeRecordKey(row)]))
      const quotes = new Map(valued.records.filter(row => row.feeValuations?.length).map(row => [row.id, row.feeValuations]))
      // 只在仍存在且费用未变化的最新交易上补报价，不把查询前的旧记录写回。
      const updates = transactions.list().records.flatMap(row => {
        const feeValuations = quotes.get(row.id)
        return original.get(row.id) === feeRecordKey(row) && feeValuations && JSON.stringify(feeValuations) !== JSON.stringify(row.feeValuations) ? [{ ...row, feeValuations }] : []
      })
      return updates.length ? transactions.save(updates, []) : transactions.list()
    })().finally(() => { feeValuationPending = null })
    return feeValuationPending
  }
  async function remove(id) {
    if (mutating || busy.has(id) || transactionBusy.has(id)) throw new ConnectionError('账户正在处理，请稍后移除。', 409)
    mutating = true
    try {
    const connection = read().connections.find(item => item.id === id)
    if (!connection) throw new ConnectionError('没有找到该接入。', 404)
    const priorSecret = connection.hasCredential ? await vault.get(id) : null
    if (connection.hasCredential) await vault.remove(id)
    const state = read()
    const sourceId = 'live-' + id
    try { save({ connections: state.connections.filter(item => item.id !== id), snapshot: { accounts: state.snapshot.accounts.filter(item => item.sourceId !== sourceId), holdings: state.snapshot.holdings.flatMap(item => { const positions = item.positions.filter(position => !position.accountId.startsWith(sourceId + '-')); return positions.length ? [{ ...item, positions }] : [] }), contracts: state.snapshot.contracts.filter(item => !item.accountId.startsWith(sourceId + '-')) } }) }
    catch (error) { if (priorSecret) { try { await vault.set(id, priorSecret) } catch { /* 系统凭据恢复失败不打印秘密。 */ } }; throw error }
    return list()
    } finally { mutating = false }
  }
  return { list, sync, upsert, remove, refreshMarket, listTransactions: transactions.list, syncTransactions, valueSavedTransactionFees, isBusy: () => mutating || busy.size > 0 || transactionBusy.size > 0 || marketPending !== null || feeValuationPending !== null }
}

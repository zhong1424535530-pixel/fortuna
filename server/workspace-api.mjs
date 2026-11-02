import { gzip } from 'node:zlib'
import { createWorkspaceStore, StorageError } from './workspace-store.mjs'
import { createConnectionService } from './connection-service.mjs'
import { listEquityHistory } from './equity-history.mjs'
import { ConnectionError, serveIcon } from './connection-http.mjs'
import { contractIconAsset, createAssetIconService } from './asset-icons.mjs'
import { createForexService } from './forex.mjs'
import { createCnQuoteService } from './cn-quotes.mjs'
import { startScheduler } from './scheduler.mjs'
import { assertWorkspacePortfolio } from '../src/data/portfolio.ts'
import { readTransactionFeePrices } from './market-prices.mjs'
import { getDatabase, getDocument, recordPrices, assertDatabaseWritable, withDatabaseWriter } from './database.mjs'
import { createTransactionQuery } from './transaction-query.mjs'
import { createDatabaseBackup, FULL_BACKUP_LIMIT } from './database-backup.mjs'
const LIMIT = 12 * 1024 * 1024
async function authRoute(request, send, path, auth) {
  const method = request.method
  if (method === 'GET' && path === '/api/auth/status') return send(200, auth.status(request))
  if (method === 'POST' && path === '/api/auth/logout') return send(200, { ok: true }, { 'Set-Cookie': auth.logout(request) })
  if (!['/api/auth/login', '/api/auth/username'].includes(path) || method !== (path === '/api/auth/login' ? 'POST' : 'PUT')) return send(404, { error: '没有找到该功能。' })
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ConnectionError('请使用登录页面。', 415)
  let size = 0; const chunks = []
  for await (const chunk of request) { size += chunk.length; if (size > 1024) throw new ConnectionError('提交内容过大。', 413); chunks.push(chunk) }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ConnectionError('提交内容无法读取。') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConnectionError('提交内容不完整。')
  if (path === '/api/auth/login') return send(200, { ok: true }, { 'Set-Cookie': auth.login(body, request) })
  if (!auth.check(request)) return send(401, { error: '请先登录。' })
  return send(200, { username: auth.rename(body.username) })
}
export function createWorkspaceApi(folder, dependencies = {}) {
  const auth = dependencies.auth
  const connections = createConnectionService(folder, dependencies)
  const fx = createForexService(folder, dependencies.forex)
  const cnQuotes = createCnQuoteService(dependencies.cnQuotes)
  let activeWrites = 0
  const completeBackup = createDatabaseBackup(folder, { isBusy: () => activeWrites > 0 || connections.isBusy() })
  const transactionPage = createTransactionQuery(folder, connections.listTransactions, () => connections.list().connections, () => ({ funding: store.inspect().data?.contractFunding ?? {}, net: store.inspect().data?.contractNet ?? {} }))
  let feePricesPending = null, feePrices = [], feePricesAt = 0
  const store = createWorkspaceStore(folder, data => {
    let snapshot
    try { snapshot = connections.list().snapshot } catch { /* 接入资料损坏不把人工资料误判成损坏。 */ }
    assertWorkspacePortfolio(data, snapshot)
  })
  const assetIcons = createAssetIconService(folder, id => {
    const state = connections.list(), snapshot = state.snapshot
    const holding = snapshot.holdings.find(asset => asset.id === id)
    if (holding) return holding
    const contract = snapshot.contracts.find(asset => asset.id === id)
    if (contract) {
      const account = snapshot.accounts.find(account => account.id === contract.accountId)
      const exchange = state.connections.find(item => 'live-' + item.id === account?.sourceId)?.type
      return contractIconAsset(contract, exchange)
    }
    const manual = store.inspect().data?.manualAssets.find(asset => asset.id === id)
    if (manual) return manual
    // 已清仓的交易品种沿用同一图标目录，不要求当前仍有持仓。
    if (/^binance:[A-Z0-9]{1,40}$/.test(id)) {
      const trade = connections.listTransactions().records.find(row => ['spot', 'usdm'].includes(row.scope) && ['买入', '卖出'].includes(row.type) && 'binance:' + row.asset === id)
      // 已平仓的股票合约也要按股票找图标，否则会落到同名加密币或通用占位图。
      if (trade) return trade.scope === 'usdm' ? { ...contractIconAsset({ id, baseAsset: trade.asset }, 'binance'), icon: '' } : { id, symbol: trade.asset, market: 'crypto', exchange: 'binance', icon: '' }
    }
    return undefined
  })
  const middleware = async (request, response) => {
    const send = (status, value, headers = {}) => {
      const body = Buffer.from(JSON.stringify(value)), base = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ...headers }
      // 走势、交易记录这类大响应压缩后只有原来的十分之一左右，手机走移动网络时差别很大；异步压缩，不阻塞其他请求。
      if (body.length < 4096 || !/\bgzip\b/.test(request.headers['accept-encoding'] ?? '')) { response.writeHead(status, base); response.end(body); return }
      gzip(body, { level: 4 }, (failure, packed) => {
        if (failure) { response.writeHead(status, base); response.end(body); return }
        response.writeHead(status, { ...base, 'Content-Encoding': 'gzip' }); response.end(packed)
      })
    }
    const port = request.socket.localPort
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
    const path = request.url.split('?')[0]
    const iconRequest = request.method === 'GET' && ['/api/token-icon', '/api/asset-icon'].includes(path) && request.headers['sec-fetch-site'] === 'same-origin'
    // 开启登录后可以用任意地址访问（IP、域名），防跨站改为"来源必须与访问地址一致"；没有登录时仍只允许本机地址。
    const sameHost = origin => { try { return new URL(origin).host === request.headers.host } catch { return false } }
    const placeOk = auth ? !!request.headers.host && (!request.headers.origin || sameHost(request.headers.origin)) : [`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host) && (!request.headers.origin || origins.includes(request.headers.origin))
    if (!placeOk || (request.headers['x-investment-app'] !== '1' && !iconRequest) || request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '只允许本站页面访问资料。' })
    let writing = false
    try {
      if (auth) {
        if (path.startsWith('/api/auth/')) return await authRoute(request, send, path, auth)
        if (!auth.check(request)) return send(401, { error: '请先登录。' })
      } else if (path === '/api/auth/status') return send(200, { bound: true, authenticated: true })
      if (request.method === 'GET' && path === '/api/forex') return send(200, fx.list())
      if (request.method === 'GET' && path === '/api/cn-quotes') return send(200, { quotes: await cnQuotes.read((new URL(request.url, origins[0]).searchParams.get('codes') ?? '').split(',')) })
      if (!path.startsWith('/api/database') && (['POST', 'PUT', 'DELETE'].includes(request.method) || ['/api/asset-icon', '/api/transactions/fee-prices'].includes(path))) {
        assertDatabaseWritable(folder); activeWrites++; writing = true
      }
      if (request.method === 'POST' && path === '/api/forex/refresh') return send(200, await fx.refresh())
      if (request.method === 'GET' && path === '/api/database') return send(200, completeBackup.status())
      if (request.method === 'GET' && path === '/api/database/export') return send(200, await completeBackup.exportBackup())
      if (request.method === 'POST' && ['/api/database/preview', '/api/database/restore'].includes(path)) {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ConnectionError('完整备份格式不正确。', 415)
        if (Number(request.headers['content-length']) > FULL_BACKUP_LIMIT + 1024) throw new ConnectionError('完整备份超过界面处理范围，请保留本地资料库快照。', 413)
        const chunks = []; let size = 0
        for await (const chunk of request) { size += chunk.length; if (size > FULL_BACKUP_LIMIT + 1024) throw new ConnectionError('完整备份过大，请保留本地资料库快照。', 413); chunks.push(chunk) }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ConnectionError('完整备份无法读取。') }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['backup', 'revision'].includes(key))) throw new ConnectionError('完整备份请求格式无效。')
        return send(200, path === '/api/database/preview' ? completeBackup.previewBackup(body.backup) : await completeBackup.restoreBackup(body.backup, body.revision))
      }
      if (request.method === 'GET' && path === '/api/token-icon') return await serveIcon(new URL(request.url, origins[0]).searchParams.get('url'), response)
      if (request.method === 'GET' && path === '/api/asset-icon') return await assetIcons.serve(new URL(request.url, origins[0]).searchParams.get('asset'), response)
      if (request.method === 'GET' && path === '/api/connections') return send(200, connections.list())
      if (request.method === 'GET' && path === '/api/transactions/page') return send(200, transactionPage(new URL(request.url, origins[0]).searchParams))
      if (request.method === 'GET' && path === '/api/transactions') {
        const params = new URL(request.url, origins[0]).searchParams, database = getDatabase(folder)
        if (!database && !params.has('limit') && !params.has('metadata')) return send(200, connections.listTransactions())
        const offset = Number(params.get('offset') ?? '0'), limit = Number(params.get('limit') ?? '5000')
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new ConnectionError('交易记录分页范围无效。')
        const state = connections.listTransactions({ offset, limit: params.has('metadata') ? 1 : limit })
        const count = database ? database.prepare('SELECT COUNT(*) AS n FROM transactions').get().n : connections.listTransactions().records.length
        const revision = database ? getDocument(database, 'transactions-revision') ?? 'migrated' : null
        return send(200, { records: params.has('metadata') ? [] : state.records, syncs: state.syncs, total: count, nextOffset: !params.has('metadata') && offset + state.records.length < count ? offset + state.records.length : null, archive: !!database, storeRevision: revision })
      }
      if (request.method === 'POST' && path === '/api/transactions/value-fees') {
        const state = await connections.valueSavedTransactionFees()
        return send(200, { syncs: state.syncs })
      }
      if (request.method === 'GET' && path === '/api/transactions/fee-prices') {
        if (Date.now() - feePricesAt >= 60000) {
          if (!feePricesPending) feePricesPending = readTransactionFeePrices(connections.listTransactions(), { marketPrices: dependencies.marketPrices }).then(prices => {
            assertDatabaseWritable(folder)
            const database = getDatabase(folder)
            if (database) withDatabaseWriter(folder, () => recordPrices(database, prices, 'USDT', 'summary'))
            feePrices = prices; feePricesAt = Date.now()
          }).finally(() => { feePricesPending = null })
          await feePricesPending
        }
        return send(200, { prices: feePrices })
      }
      const transactionMatch = path.match(/^\/api\/transactions\/([0-9a-f-]{36})\/sync$/)
      if (request.method === 'POST' && transactionMatch) {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ConnectionError('请使用交易记录页面同步。', 415)
        let size = 0; const chunks = []
        for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new ConnectionError('补查交易对过多，请分批填写。', 413); chunks.push(chunk) }
        let input
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ConnectionError('补查交易对无法读取。') }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'spotPairs')) throw new ConnectionError('交易记录查询资料无效。')
        const state = await connections.syncTransactions(transactionMatch[1], input)
        return send(200, getDatabase(folder) ? { records: [], syncs: state.syncs, archive: true } : state)
      }
      if (request.method === 'GET' && path === '/api/equity-history') {
        const params = new URL(request.url, origins[0]).searchParams
        return send(200, { points: listEquityHistory(folder, { start: Number(params.get('start') ?? '0'), end: Number(params.get('end') ?? String(Number.MAX_SAFE_INTEGER)), sample: params.get('raw') !== '1' }) })
      }
      if (request.method === 'POST' && path === '/api/market/refresh') return send(200, await connections.refreshMarket())
      const match = path.match(/^\/api\/connections(?:\/([0-9a-f-]{36})(\/sync)?)?$/)
      if (match && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
        if (request.method === 'DELETE' && match[1] && !match[2]) return send(200, await connections.remove(match[1]))
        if (request.method === 'POST' && match[1] && match[2]) {
          const automatic = new URL(request.url, origins[0]).searchParams.get('automatic')
          if (automatic !== null && automatic !== '1') throw new ConnectionError('自动刷新参数无效。')
          return send(200, await connections.sync(match[1], false, automatic === '1'))
        }
        if (!(request.method === 'POST' && !match[1] || request.method === 'PUT' && match[1] && !match[2])) return send(405, { error: '不支持此操作。' })
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ConnectionError('请使用页面中的添加表单。', 415)
        let size = 0; const chunks = []
        for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new ConnectionError('接入资料过大。', 413); chunks.push(chunk) }
        let input
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ConnectionError('接入资料无法读取。') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('接入资料不完整。')
        return send(200, await connections.upsert(input, match[1]))
      }
      if (request.method === 'GET') {
        if (path === '/api/workspace') return send(200, { ...store.inspect(), ...store.info() })
        if (path === '/api/export') return send(200, store.export())
      }
      if ((request.method === 'PUT' && path === '/api/workspace') || (request.method === 'POST' && path === '/api/restore')) {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new StorageError(415, '请使用资产资料文件格式。')
        if (Number(request.headers['content-length']) > LIMIT) throw new StorageError(413, '资料超过12 MB，请减少图片大小。')
        let size = 0
        const chunks = []
        for await (const chunk of request) { size += chunk.length; if (size > LIMIT) throw new StorageError(413, '资料超过12 MB，请减少图片大小。'); chunks.push(chunk) }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new StorageError(400, '资料文件无法读取，请选择有效备份。') }
        if (!body || (body.revision !== null && typeof body.revision !== 'string') || !body.data) throw new StorageError(400, '资料或保存版本不完整。')
        return send(200, request.method === 'POST' ? store.restore(body.data, body.revision) : store.save(body.data, body.revision))
      }
      send(404, { error: '没有找到该本机功能。' })
    } catch (error) {
      const known = error instanceof StorageError || error instanceof ConnectionError
      // 只记录请求方式、路径和错误原因，不记录请求内容，避免密钥进入日志。
      if (!known || error.status >= 500) console.error(`[接口] ${request.method} ${path} 失败${known ? `（${error.status}）` : '（未预期）'}：${error?.message ?? error}`)
      send(error instanceof StorageError || error instanceof ConnectionError ? error.status : 500, { error: error instanceof StorageError || error instanceof ConnectionError ? error.message : '本机资料读写失败，请保留当前输入，检查保存目录和磁盘空间。' }) }
    finally { if (writing) activeWrites-- }
  }
  // 只由真正运行的服务启动定时任务，测试和打包不会触发。
  middleware.startScheduler = () => startScheduler({ folder, store, connections, fx, cnQuotes })
  return middleware
}

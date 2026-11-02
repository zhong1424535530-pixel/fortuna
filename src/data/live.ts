import { ensureTransactions, syncTransactions, transactionState, waitForTransaction, transactionPending, markTransactionSourceRemoved } from './transaction-client.ts'
import { connectionRefreshMs, emptyLive } from './live-types.ts'
import type { Connection, ConnectionType, DataMode, LiveState, WalletFamily } from './live-types.ts'
export let liveState: LiveState = emptyLive()
// 服务端定时任务用：把服务端的最新接入状态交给同一套估值代码。
export function setLiveState(next: LiveState) { liveState = next }
export const dataMode: DataMode = 'real'
export let liveError = ''
export let marketError = ''
export let balanceError = ''
let connectionWork = 0, liveVersion = 0
let marketWork: Promise<void> | null = null
let balanceWork: Promise<void> | null = null
let transactionWork: Promise<void> | null = null
let balanceQueue: Promise<unknown> = Promise.resolve()
function queueBalance(work: () => Promise<void>): Promise<void> {
  const next = balanceQueue.then(work)
  balanceQueue = next.catch(() => {})
  return next
}
const transactionAttempts = new Map<string, number>()
const transactionFailures = new Map<string, number>()
const manualRefreshes = new Map<string, Promise<void>>()
const automaticAttempts = new Map<string, number>()
export const isReal = () => true
const announce = (detail: string) => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('portfolio-data-change', { detail })) }
async function request(path: string, options: RequestInit = {}): Promise<LiveState> {
  let response: Response
  try { response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Investment-App': '1' }, signal: AbortSignal.timeout(240000) }) } catch { throw new Error('本机服务连接中断或查询超时，请重新打开页面查看保存结果。') }
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || '接入暂时无法处理，请稍后重试。')
  if (!Array.isArray(value.connections) || !value.snapshot || !Array.isArray(value.snapshot.accounts) || !Array.isArray(value.snapshot.holdings) || !Array.isArray(value.snapshot.contracts)) throw new Error('接入资料格式无法识别。')
  return value
}
export async function initializeLiveData() {
  try { liveState = await request('/api/connections'); liveError = '' } catch (error) { liveError = (error as Error).message }
  try { localStorage.setItem('investment-data-mode', 'real') } catch { /* 不影响资产读取。 */ }
}
async function apply(work: Promise<LiveState>) {
  connectionWork++; liveVersion++
  try { liveState = await work; liveError = ''; announce('connection') }
  finally { connectionWork-- }
}
export function refreshMarketData(): Promise<void> {
  if (marketWork) return marketWork
  if (connectionWork || !liveState.snapshot.holdings.length && !liveState.snapshot.contracts.length) return Promise.resolve()
  const version = liveVersion
  marketWork = (async () => {
    try {
      const next = await request('/api/market/refresh', { method: 'POST' })
      if (version !== liveVersion || connectionWork) return
      liveState = next; marketError = ''; announce('market')
    } catch (error) {
      if (version !== liveVersion || connectionWork) return
      marketError = (error as Error).message; announce('market-status')
    }
  })().finally(() => { marketWork = null })
  return marketWork
}
export function refreshAccountData(): Promise<void> {
  if (balanceWork) return balanceWork
  if (connectionWork || !liveState.connections.length) return Promise.resolve()
  balanceWork = (async () => {
    if (marketWork) await marketWork
    const failures: string[] = []
    function refresh(id: string) {
      return queueBalance(async () => {
        const connection = liveState.connections.find(item => item.id === id)
        if (!connection || connectionWork || manualRefreshes.has(id) || transactionPending(id)) return
        const now = Date.now(), savedAt = Date.parse(connection.updatedAt ?? '')
        const last = automaticAttempts.get(id) ?? (Number.isFinite(savedAt) && savedAt <= now ? savedAt : 0)
        if (last && now - last < connectionRefreshMs(connection.type)) return
        automaticAttempts.set(id, now)
        connectionWork++
        const version = ++liveVersion
        try {
          const next = await request('/api/connections/' + id + '/sync?automatic=1', { method: 'POST' })
          if (version !== liveVersion) return
          if (JSON.stringify(next) !== JSON.stringify(liveState)) { liveState = next; announce('balances') }
        } catch (error) {
          if (version === liveVersion) failures.push(connection.name + '：' + (error as Error).message)
        } finally { connectionWork-- }
        await refreshMarketData()
      })
    }
    const ids = liveState.connections.map(item => ({ id: item.id, wallet: item.type === 'wallet' }))
    const exchanges = ids.filter(item => !item.wallet)
    const refreshExchanges = async () => { for (const item of exchanges) await refresh(item.id) }
    await refreshExchanges()
    for (const item of ids.filter(item => item.wallet)) {
      // 钱包扫描可能较慢，下一只钱包开始前先补查到期的交易所。
      await refreshExchanges()
      await refresh(item.id)
    }
    const nextError = failures.join('；')
    if (nextError !== balanceError) { balanceError = nextError; announce('balance-status') }
  })().finally(() => { balanceWork = null })
  return balanceWork
}
export function refreshTransactionData(): Promise<void> {
  if (transactionWork) return transactionWork
  if (connectionWork || !liveState.connections.some(item => ['binance', 'wallet'].includes(item.type))) return Promise.resolve()
  transactionWork = (async () => {
    try { await ensureTransactions() } catch { return }
    for (const connection of [...liveState.connections].sort((a, b) => (transactionAttempts.get(a.id) ?? 0) - (transactionAttempts.get(b.id) ?? 0))) {
      if (connectionWork) break
      if (!['binance', 'wallet'].includes(connection.type) || manualRefreshes.has(connection.id) || !liveState.connections.some(item => item.id === connection.id)) continue
      const saved = Math.max(0, ...transactionState.syncs.filter(item => item.connectionId === connection.id).map(item => item.at))
      const now = Date.now(), last = Math.max(transactionAttempts.get(connection.id) ?? 0, Math.min(saved, now))
      const interval = Math.min(3600000, (connection.type === 'wallet' ? 900000 : 300000) * 2 ** Math.min(4, transactionFailures.get(connection.id) ?? 0))
      if (last && now - last < interval) continue
      transactionAttempts.set(connection.id, now)
      try {
        const next = await syncTransactions(connection.id, [])
        const scopes = next.syncs.filter(item => item.connectionId === connection.id && !item.key.startsWith('coverage:'))
        if (scopes.length && scopes.every(item => item.status === 'error')) transactionFailures.set(connection.id, (transactionFailures.get(connection.id) ?? 0) + 1)
        else transactionFailures.delete(connection.id)
      } catch { transactionFailures.set(connection.id, (transactionFailures.get(connection.id) ?? 0) + 1) }
    }
  })().finally(() => { transactionWork = null })
  return transactionWork
}
export function startLiveUpdates() {
  if (typeof window === 'undefined') return () => {}
  let active = true
  const balances = () => { void refreshAccountData().then(() => { if (active) void refreshTransactionData() }) }
  const refresh = () => { void refreshMarketData(); balances() }
  const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
  refresh()
  const marketTimer = window.setInterval(() => { void refreshMarketData() }, 60000)
  // 这里只检查到期时间，不到1分钟／5分钟不会发出余额查询。
  const balanceTimer = window.setInterval(balances, 15000)
  document.addEventListener('visibilitychange', onVisible)
  return () => { active = false; window.clearInterval(marketTimer); window.clearInterval(balanceTimer); document.removeEventListener('visibilitychange', onVisible) }
}
export type ConnectionInput = { type: ConnectionType; name: string; apiKey?: string; apiSecret?: string; passphrase?: string; address?: string; chains?: string[]; walletFamily?: WalletFamily; trackedTokens?: { chain: string; address: string }[]; provider?: 'rpc' | 'moralis'; providerKey?: string }
export const saveConnection = (input: ConnectionInput, id?: string) => apply(request('/api/connections' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) }))
export function syncConnection(id: string): Promise<void> {
  const current = manualRefreshes.get(id)
  if (current) return current
  const work = (async () => {
    const joined = await waitForTransaction(id)
    await queueBalance(() => apply(request('/api/connections/' + id + '/sync', { method: 'POST' })))
    const connection = liveState.connections.find(item => item.id === id)
    if (!joined && connection && ['binance', 'wallet'].includes(connection.type) && connection.status !== 'error') {
      transactionAttempts.set(id, Date.now())
      try { await syncTransactions(id, []); transactionFailures.delete(id) }
      catch (error) { throw new Error('余额已更新，交易记录暂未更新：' + (error as Error).message) }
    }
  })().finally(() => { manualRefreshes.delete(id) })
  manualRefreshes.set(id, work)
  return work
}
export async function removeConnection(id: string) {
  await apply(request('/api/connections/' + id, { method: 'DELETE' }))
  markTransactionSourceRemoved(id)
}
export const connectionStatus = (connection: Pick<Connection, 'status'>) => ({ pending: '等待读取', ok: '已读取', partial: '部分资料', error: '读取失败' })[connection.status]
export const connectionTime = (time?: string | null) => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '尚无成功记录'

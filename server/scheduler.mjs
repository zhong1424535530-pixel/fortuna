// 服务端定时更新：网页关着也继续更新余额、行情、汇率、交易记录和净资产走势。
// 各项服务自带到期判断（余额1/5分钟、行情55秒、汇率1小时），这里每15秒检查一轮即可。
import { setLiveState } from '../src/data/live.ts'
import { emptyWorkspace, setWorkspaceData } from '../src/data/workspace.ts'
import { forex } from '../src/data/forex.ts'
import { quoteKey, setCnQuotes } from '../src/data/cn-quotes.ts'
import { refreshPortfolio } from '../src/data/portfolio.ts'
import { buildEquitySample } from '../src/data/equity-history.ts'
import { saveEquityPoint } from './equity-history.mjs'

export function startScheduler({ folder, store, connections, fx, cnQuotes, tickMs = 15000, now = () => Date.now() }) {
  const transactionAttempts = new Map(), transactionFailures = new Map()
  let running = false, transactionRunning = false, sampledAt = 0

  // 与网页原有规则相同：币安5分钟、钱包15分钟，连续失败时间隔加倍，最长1小时。
  async function syncTransactions() {
    const saved = connections.listTransactions().syncs
    for (const connection of connections.list().connections.filter(item => ['binance', 'wallet'].includes(item.type))) {
      const time = now(), savedAt = Math.max(0, ...saved.filter(item => item.connectionId === connection.id).map(item => item.at))
      const last = Math.max(transactionAttempts.get(connection.id) ?? 0, Math.min(savedAt, time))
      const interval = Math.min(3600000, (connection.type === 'wallet' ? 900000 : 300000) * 2 ** Math.min(4, transactionFailures.get(connection.id) ?? 0))
      if (last && time - last < interval) continue
      transactionAttempts.set(connection.id, time)
      try {
        const next = await connections.syncTransactions(connection.id, {})
        const scopes = next.syncs.filter(item => item.connectionId === connection.id && !item.key.startsWith('coverage:'))
        if (scopes.length && scopes.every(item => item.status === 'error')) transactionFailures.set(connection.id, (transactionFailures.get(connection.id) ?? 0) + 1)
        else transactionFailures.delete(connection.id)
      } catch (error) {
        // 账户正在读取（409）只是撞车，不算失败，下一轮再试；其余失败才加倍退让并留下日志。
        if (error?.status === 409) { transactionAttempts.delete(connection.id); continue }
        transactionFailures.set(connection.id, (transactionFailures.get(connection.id) ?? 0) + 1)
        console.error(`[定时任务] 交易记录同步失败（${connection.name}）：${error?.message ?? error}`)
      }
    }
  }

  // 用网页同一套估值代码算一个走势点，结果与页面显示一致。
  async function recordEquity() {
    // 走势会把相隔不到50秒的点合并成一个，所以每分钟最多记一次，否则只剩一个不断后移的点。
    if (now() - sampledAt < 60000) return
    const state = store.inspect()
    // 从未手动保存过资料时按空资料计算；资料文件损坏时不记，避免写出错误的走势点。
    if (state.error) return
    const data = state.data ?? emptyWorkspace()
    setWorkspaceData(data)
    setLiveState(connections.list())
    forex.quote = fx.list().quote
    setCnQuotes(await cnQuotes.read(data.manualAssets.flatMap(asset => quoteKey(asset) ?? [])))
    refreshPortfolio()
    const point = buildEquitySample(Math.floor(now() / 1000))
    if (point) { await saveEquityPoint(folder, point); sampledAt = now() }
  }

  // 每一步单独记录失败原因，任何一步出错都不能让进程退出或挡住后面的步骤。
  const step = async (name, work) => { try { await work() } catch (error) { console.error(`[定时任务] ${name}失败：${error?.message ?? error}`) } }
  // 币安交易同步最长约 3 分钟，单独一条线运行，不让余额、行情和走势跟着等。
  async function refresh() {
    if (running) return
    running = true
    try {
      await step('账户读取', async () => { for (const connection of connections.list().connections) await connections.sync(connection.id, false, true).catch(error => console.error(`[定时任务] 账户读取失败：${error?.message ?? error}`)) })
      await step('行情更新', () => connections.refreshMarket())
      await step('汇率更新', () => fx.refresh())
      await step('走势记录', recordEquity)
    } finally { running = false }
  }
  async function transactions() {
    if (transactionRunning) return
    transactionRunning = true
    try { await step('交易记录同步', syncTransactions) } finally { transactionRunning = false }
  }
  const tick = () => Promise.all([refresh(), transactions()]).then(() => {})

  void tick()
  const timer = setInterval(() => { void tick() }, tickMs)
  timer.unref?.()
  return { tick, stop: () => clearInterval(timer) }
}

import { buildTransactionFeed, filterTransactionFeed, groupRewards, transactionCategories } from '../src/data/transaction-feed.ts'
import { summarizeTransactions } from '../src/data/transaction-summary.ts'
import { ConnectionError } from './connection-http.mjs'
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase, getDocument } from './database.mjs'

export function queryTransactionPage(state, connections, query, prepared = null, summaries = new Map()) {
  const filters = { query: query.get('query') ?? '', source: query.get('source') ?? '', start: query.get('start') ?? '', end: query.get('end') ?? '', type: '', account: '' }
  const category = query.get('category') ?? '全部', status = query.get('status') ?? '已平仓', requested = Number(query.get('page') ?? '1')
  const validDate = value => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00+08:00'))
  if (!transactionCategories.includes(category) || !['', '已平仓', '持仓中', '资料不全'].includes(status) || !Number.isSafeInteger(requested) || requested < 1 || filters.query.length > 256 || filters.source.length > 80 || !validDate(filters.start) || !validDate(filters.end) || filters.start && filters.end && filters.start > filters.end) throw new ConnectionError('交易记录查询条件无效。')
  // 合约先使用完整上下文整理，再筛选和分页，跨期的开仓不会被日期过滤截掉。
  const feed = prepared ?? buildTransactionFeed(state), selected = groupRewards(filterTransactionFeed(feed.entries, category, filters, category === '合约' ? status : '已平仓'))
  const pages = Math.max(1, Math.ceil(selected.length / 20)), page = Math.min(requested, pages)
  const entries = selected.slice((page - 1) * 20, page * 20)
  const summaryKey = JSON.stringify([filters.source, filters.start, filters.end, connections.map(item => [item.id, item.type, item.address, item.walletFamily, item.chains])])
  if (!summaries.has(summaryKey)) {
    if (summaries.size >= 20) summaries.delete(summaries.keys().next().value)
    summaries.set(summaryKey, summarizeTransactions(state, feed.entries.flatMap(entry => entry.kind === 'contract' ? [entry.round] : []), filters, connections))
  }
  const totals = summaries.get(summaryKey)
  const sources = [...new Map([...state.records.map(row => [row.connectionId, row.connectionName]), ...state.syncs.map(item => [item.connectionId, item.connectionName]), ...connections.map(item => [item.id, item.name])])]
  const walletPeers = {}
  for (const entry of entries) if (entry.kind === 'transaction' && entry.row.walletOwner) {
    const row = entry.row
    walletPeers[row.id] = [...new Set(state.records.filter(other => other.scope === row.scope && other.txHash === row.txHash && other.walletOwner && other.walletOwner !== row.walletOwner).map(other => other.connectionName))]
  }
  return { entries, totals, sources, walletPeers, recordCount: state.records.length, total: selected.length, page, pages }
}

export function createTransactionQuery(folder, list, connections, fundingFixes = () => ({})) {
  // shortcut: 资料更新时仍用全量历史确认合约上下文；百万级记录再按品种保存整理结果。
  let revision, state, feed, summaries = new Map()
  return query => {
    const database = getDatabase(folder), file = join(folder, 'transactions.json')
    const fixes = fundingFixes()
    const next = JSON.stringify(fixes) + (database ? JSON.stringify([String(statSync(join(folder, 'portfolio.sqlite'), { bigint: true }).ino), getDocument(database, 'transactions-revision'), database.prepare('PRAGMA data_version').get()]) : existsSync(file) ? String(statSync(file, { bigint: true }).mtimeNs) : 'empty')
    if (state === undefined || revision !== next) {
      state = list(); feed = buildTransactionFeed(state, fixes.funding, fixes.net); summaries = new Map(); revision = next
    }
    return queryTransactionPage(state, connections(), query, feed, summaries)
  }
}

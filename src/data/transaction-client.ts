import { emptyTransactions, validTransactionState } from './transactions.ts'
import type { TransactionState } from './transactions.ts'

export let transactionState = emptyTransactions()
export let transactionError = ''
let loaded = false, revision = 0
let loading: Promise<TransactionState> | null = null
let queue: Promise<unknown> = Promise.resolve()
const errors = new Map<string, string>()
const removedSources = new Set<string>()
const notify = () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('transaction-data-change')) }

type TransactionReply = TransactionState & { archive?: boolean; nextOffset?: number | null; storeRevision?: string | null }
const stateOf = (value: TransactionState): TransactionState => ({ records: value.records, syncs: value.syncs })
async function request(path: string, options: RequestInit = {}): Promise<TransactionReply> {
  let response: Response
  try { response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Investment-App': '1' }, signal: AbortSignal.timeout(240000) }) }
  catch { throw new Error('交易记录服务连接中断或超时，已保存的交易记录会继续保留。') }
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || '交易记录暂时无法读取。')
  if (!validTransactionState({ records: value.records, syncs: value.syncs }, { archive: value.archive === true }) || value.nextOffset !== undefined && value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset < 1) || value.storeRevision !== undefined && value.storeRevision !== null && typeof value.storeRevision !== 'string') throw new Error('交易记录格式无法识别，未替换页面已有资料。')
  return value
}
export function loadTransactions(): Promise<TransactionState> {
  if (loading) return loading
  loading = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = revision, first = await request('/api/transactions'), records = [...first.records]
      let offset = first.nextOffset, changed = false
      while (offset !== undefined && offset !== null) {
        const next = await request('/api/transactions?offset=' + offset + '&limit=5000')
        if (next.storeRevision !== first.storeRevision) { changed = true; break }
        if (next.nextOffset !== null && next.nextOffset !== undefined && next.nextOffset <= offset) throw new Error('历史记录分页位置异常，已有资料保留。')
        records.push(...next.records); offset = next.nextOffset
      }
      if (changed || version !== revision) continue
      const next = { records, syncs: first.syncs }
      if (!validTransactionState(next, { archive: first.archive === true })) throw new Error('历史记录核对未通过，已有资料保留。')
      transactionState = next; loaded = true
      return transactionState
    }
    throw new Error('读取期间资料持续更新，请稍后重读本机记录，已有资料保留。')
  })().finally(() => { loading = null })
  return loading
}
let feeValuationPending: Promise<TransactionState> | null = null
// 补价结果会随后整份重读，这里只确认服务端已完成，不再下载并核对一份用不到的完整记录。
async function valueFees() {
  let response: Response
  try { response = await fetch('/api/transactions/value-fees', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Investment-App': '1' }, body: '{}', signal: AbortSignal.timeout(240000) }) }
  catch { throw new Error('交易记录服务连接中断或超时，已保存的交易记录会继续保留。') }
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '交易记录暂时无法读取。')
}
export function valueSavedTransactionFees(): Promise<TransactionState> {
  if (!feeValuationPending) feeValuationPending = valueFees().then(() => loadTransactions()).finally(() => { feeValuationPending = null })
  return feeValuationPending
}

export async function ensureTransactions(): Promise<TransactionState> {
  if (loaded) return transactionState
  const version = revision, next = await request('/api/transactions')
  if (!loaded && version === revision) { transactionState = stateOf(next); loaded = true }
  return transactionState
}
// 离开页面后，同一来源仍复用原请求，避免重复点击造成并行补查。
const pending = new Map<string, Promise<TransactionState>>()
export function syncTransactions(id: string, spotPairs: string[]) {
  const existing = pending.get(id)
  if (existing) return existing
  // 自动更新与账户刷新共用队列，防止多个来源同时占用免费查询额度。
  const work = queue.then(() => removedSources.has(id) ? transactionState : request('/api/transactions/' + id + '/sync', { method: 'POST', body: JSON.stringify({ spotPairs }) })).then(next => {
    transactionState = 'archive' in next && next.archive === true ? { records: transactionState.records, syncs: next.syncs } : stateOf(next); loaded = true; revision++
    errors.delete(id); transactionError = [...errors.values()].join('；'); notify()
    return next
  }).catch(error => {
    if (!removedSources.has(id)) { errors.set(id, (error as Error).message); transactionError = [...errors.values()].join('；'); notify() }
    throw error
  }).finally(() => { pending.delete(id) })
  queue = work.catch(() => {})
  pending.set(id, work)
  return work
}
export const waitForTransaction = async (id: string) => { try { return await pending.get(id) } catch { /* 新一轮账户刷新可以重试，旧记录仍保留。 */ } }

export const transactionPending = (id: string) => pending.has(id)

export function markTransactionSourceRemoved(id: string) {
  removedSources.add(id)
  if (errors.delete(id)) { transactionError = [...errors.values()].join('；'); notify() }
}

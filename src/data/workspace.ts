import { emptyWorkspace, validIcon, validateWorkspace, removeRetiredDemoData, WORKSPACE_KEY } from './workspace-schema.ts'
import type { WorkspaceData, PortfolioChange, CostBasis } from './workspace-schema.ts'
export * from './workspace-schema.ts'

export function readWorkspace(): { data: WorkspaceData; error: string; raw: string | null } {
  if (typeof window === 'undefined') return { data: emptyWorkspace(), error: '', raw: null }
  try {
    const raw = window.localStorage.getItem(WORKSPACE_KEY)
    if (raw === null) return { data: emptyWorkspace(), error: '', raw: null }
    const data: unknown = JSON.parse(raw)
    if (!validateWorkspace(data)) throw new Error('资料格式无法识别')
    return { data: removeRetiredDemoData(data), error: '', raw }
  } catch {
    return { data: emptyWorkspace(), error: '本机资料暂时无法读取。为保护原记录，已暂停写入，请先检查浏览器保存权限或备份原资料。', raw: null }
  }
}
const initial = readWorkspace()
export let workspace = initial.data
// 服务端定时任务用：直接使用已保存的资料。
export function setWorkspaceData(data: WorkspaceData) { workspace = removeRetiredDemoData(data) }
export let workspaceError = initial.error
export let storageInfo = { connected: false, filePath: '', backupPath: '', updatedAt: null as string | null }
export let legacyPending = false
let revision: string | null = null
let saving = false
const MIGRATION_KEY = `${WORKSPACE_KEY}.file-migration`
const LIMIT = 12 * 1024 * 1024

type FileState = { data: WorkspaceData | null; revision: string | null; updatedAt: string | null; filePath?: string; backupPath?: string; error?: string }
export type BackupFile = { format: 'personal-investment-dashboard'; version: 1; exportedAt?: string; updatedAt?: string; data: WorkspaceData }

export async function localRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(path, { ...options, cache: 'no-store', headers: { 'X-Investment-App': '1', 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) }) }
  catch { throw new Error('本机保存服务未连接或保存结果未确认。请保留输入，刷新后核对，当前不会清空原资料。') }
  let value: unknown
  try { value = await response.json() } catch { throw new Error('本机服务未返回有效资料，请确认通过本项目的本机地址打开。') }
  if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : '本机资料读写失败，请保留当前输入。')
  return value as T
}
function acceptState(value: FileState) {
  if (!value || (value.revision !== null && typeof value.revision !== 'string') || (value.data !== null && !validateWorkspace(value.data)) || (value.updatedAt !== null && !Number.isFinite(Date.parse(value.updatedAt)))) throw new Error('本机资料格式无法识别，已暂停保存。')
  revision = value.revision
  if (value.data) workspace = removeRetiredDemoData(value.data)
  storageInfo = { connected: true, filePath: value.filePath ?? storageInfo.filePath, backupPath: value.backupPath ?? storageInfo.backupPath, updatedAt: value.updatedAt }
  if (value.error) throw new Error(value.error)
}
async function legacyHash(raw: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function markLegacy() {
  if (initial.raw !== null) { try { window.localStorage.setItem(MIGRATION_KEY, await legacyHash(initial.raw)) } catch { /* 文件已保存；浏览器标记失败不影响落盘。 */ } }
  legacyPending = false
}
export async function initializeWorkspace() {
  try {
    const state = await localRequest<FileState>('/api/workspace')
    acceptState(state)
    workspaceError = ''
    if (state.data === null) {
      if (initial.error) throw new Error(initial.error)
      if (initial.raw !== null) {
        const migrated = await localRequest<FileState>('/api/workspace', { method: 'PUT', body: JSON.stringify({ revision, data: initial.data }) })
        acceptState(migrated); await markLegacy()
      } else workspace = emptyWorkspace()
    } else if (initial.raw !== null && !initial.error) {
      let marked = false
      try { marked = window.localStorage.getItem(MIGRATION_KEY) === await legacyHash(initial.raw) } catch { /* 可在设置里手动核对旧资料。 */ }
      legacyPending = !marked && JSON.stringify(initial.data) !== JSON.stringify(state.data)
      if (!legacyPending) await markLegacy()
    }
  } catch (reason) { workspaceError = reason instanceof Error ? reason.message : '本机资料读取失败，已暂停保存。' }
  if (!workspaceError && adoptDefaultManualAccount(workspace) !== workspace) {
    try { await commitWorkspace(workspace, 'profile') } catch { /* 转换失败时保留默认分组，下次保存会再尝试。 */ }
  }
}
// "所属账户：手动账户"原本只是没有记录的默认分组，不能添加资产或改名；保存前转成名为"手动账户"的普通手动账户。
export function adoptDefaultManualAccount(data: WorkspaceData): WorkspaceData {
  const used = data.manualAssets.some(asset => asset.accountId === 'manual') || Object.values(data.costs ?? {}).some(entries => Object.hasOwn(entries, 'manual'))
  if (!used) return data
  const prior = data.manualAccounts ?? []
  const existing = prior.find(account => account.name === '手动账户')
  const account = existing ?? { id: 'manual-account-' + crypto.randomUUID(), name: '手动账户', updatedAt: new Date().toISOString() }
  const swap = (id: string) => id === 'manual' ? account.id : id
  const moveCosts = (entries: Record<string, CostBasis>) => {
    const moved: Record<string, CostBasis> = {}
    for (const [id, entry] of Object.entries(entries)) if (id !== 'manual') moved[id] = entry
    if (entries.manual && !moved[account.id]) moved[account.id] = entries.manual // 目标账户已有成本时保留原有的，不覆盖
    return moved
  }
  return {
    ...data,
    manualAccounts: existing ? prior : [...prior, account],
    manualAssets: data.manualAssets.map(asset => asset.accountId === 'manual' ? { ...asset, accountId: account.id } : asset),
    ...(data.costs ? { costs: Object.fromEntries(Object.entries(data.costs).map(([assetId, entries]) => [assetId, moveCosts(entries)])) } : {}),
    snapshots: data.snapshots.map(snapshot => ({ ...snapshot, assets: snapshot.assets.map(asset => asset.positions ? { ...asset, positions: asset.positions.map(position => ({ ...position, accountId: swap(position.accountId) })) } : asset) })),
    changes: existing ? data.changes : [portfolioChange('默认分组转为手动账户', '手动账户'), ...data.changes].slice(0, 500),
  }
}

export async function commitWorkspace(next: WorkspaceData, change: 'valuation' | 'cost' | 'profile' = 'valuation') {
  next = adoptDefaultManualAccount(next)
  if (workspaceError) throw new Error(workspaceError)
  if (!storageInfo.connected) throw new Error('本机保存服务尚未连接，请刷新后再试。')
  if (saving) throw new Error('上一份资料仍在保存，请稍后再试。')
  if (!validateWorkspace(next)) throw new Error('资料不完整或超出保存范围，请检查数量、价格、图标及成本。')
  saving = true
  try {
    acceptState(await localRequest<FileState>('/api/workspace', { method: 'PUT', body: JSON.stringify({ revision, data: next }) }))
    window.dispatchEvent(new CustomEvent('portfolio-data-change', { detail: change }))
  } finally { saving = false }
}
export function validateBackup(value: unknown): BackupFile {
  if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== 'personal-investment-dashboard' || !('version' in value) || value.version !== 1 || !('data' in value) || !validateWorkspace(value.data)) throw new Error('这不是可识别的资产备份，请选择本项目导出的文件。')
  return { ...(value as BackupFile), data: removeRetiredDemoData((value as BackupFile).data) }
}
export async function readBackupFile(file: File) {
  if (file.size > LIMIT) throw new Error('备份超过12 MB，请选择较小的备份。')
  try { return validateBackup(JSON.parse(await file.text())) } catch (reason) { throw new Error(reason instanceof SyntaxError ? '备份文件无法读取，请选择有效的备份。' : reason instanceof Error ? reason.message : '备份读取失败。') }
}
export function readIcon(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return Promise.reject(new Error('请选择 PNG、JPEG 或 WEBP 图片。'))
  if (file.size > 1024 * 1024) return Promise.reject(new Error('图片不能超过1 MB，请先缩小后再上传。'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'))
    reader.onabort = () => reject(new Error('图片读取已取消，请重新选择。'))
    reader.onload = () => validIcon(reader.result) ? resolve(reader.result) : reject(new Error('这张图片无法保存，请换一张图片。'))
    reader.readAsDataURL(file)
  })
}
export function browserLegacyBackup(): BackupFile {
  if (initial.error || initial.raw === null) throw new Error('没有可读取的旧浏览器资料。')
  return { format: 'personal-investment-dashboard', version: 1, data: initial.data }
}
export async function restoreWorkspace(data: WorkspaceData) {
  if (saving) throw new Error('上一份资料仍在保存，请稍后再试。')
  saving = true
  try {
    acceptState(await localRequest<FileState>('/api/restore', { method: 'POST', body: JSON.stringify({ revision, data }) }))
    workspaceError = ''; await markLegacy()
    window.dispatchEvent(new CustomEvent('portfolio-data-change', { detail: 'valuation' }))
  } finally { saving = false }
}
export async function downloadBackup() {
  const backup = validateBackup(await localRequest<BackupFile>('/api/export'))
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `个人资产备份-${new Date().toISOString().replaceAll(':', '-')}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function portfolioChange(action: string, assetName: string): PortfolioChange {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), action, assetName }
}

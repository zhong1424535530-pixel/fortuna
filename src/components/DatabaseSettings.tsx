import { useEffect, useRef, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { locale, t, useLang } from '../i18n'
import { localRequest, storageInfo, workspaceError } from '../data/workspace'
import { Button, Modal, Panel, IssueHint } from './ui'
import ManualBackup from './ManualBackup'
import '../database-settings.css'

type DatabaseInfo = { mode: 'legacy' | 'database'; path: string; backupPath?: string; counts: Record<string, number>; revision: string | null; warning: string; maintenance?: boolean }
type Preview = { counts: Record<string, number>; icons: number; createdAt: string; earliestAt: number | null; latestAt: number | null; revision: string }
const LIMIT = 256 * 1024 * 1024
const labels: Record<string, string> = { documents: '当前业务资料', transactions: '交易与收支', transaction_syncs: '查询进度', equity_points: '资产曲线采样', observations: '持仓与人工历史', price_observations: '价格依据', workspace_backups: '原有人工备份' }
const time = (value: number | string | null) => value === null ? t('暂无记录') : new Date(value).toLocaleString(locale())

async function fullRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(path, { ...options, cache: 'no-store', headers: { 'X-Investment-App': '1', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(240000) }) }
  catch { throw new Error(t('本机服务未连接或操作结果尚未确认。请保留备份文件，刷新查看最新状态后再操作。')) }
  let value: unknown
  try { value = await response.json() } catch { throw new Error(t('本机服务未返回有效资料，请刷新核对操作结果。')) }
  if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : t('完整备份操作未完成，请保留原资料。'))
  return value as T
}

export default function DatabaseSettings() {
  useLang()
  const [info, setInfo] = useState<DatabaseInfo | null>(null)
  const [pending, setPending] = useState<{ label: string; backup: unknown; preview: Preview } | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const load = async () => setInfo(await localRequest<DatabaseInfo>('/api/database'))
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : t('资料库状态读取失败。'))) }, [])
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); 
    try { await work() } catch (reason) { setError(reason instanceof Error ? reason.message : t('完整备份操作失败，请保留原资料。')) }
    finally { setBusy(false) }
  }
  const preview = async (backup: unknown, label: string) => {
    const result = await fullRequest<Preview>('/api/database/preview', { method: 'POST', body: JSON.stringify({ backup }) })
    setPending({ label, backup, preview: result }); setConfirmed(false)
  }
  const select = async (file?: File) => {
    if (!file) return
    await run(async () => {
      if (file.size > LIMIT) throw new Error(t('备份超过256 MB，本次未导入；原资料保留。'))
      let value: unknown
      try { value = JSON.parse(await file.text()) } catch { throw new Error(t('备份文件无法读取，请选择本项目导出的备份文件。')) }
      await preview(value, file.name)
    })
    if (input.current) input.current.value = ''
  }
  const exportFile = () => run(async () => {
    const backup = await fullRequest<unknown>('/api/database/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${t('完整业务备份')}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)

  })
  const restore = () => {
    if (!pending || !confirmed) return
    void run(async () => {
      const result = await fullRequest<{ restored: boolean; warning: string }>('/api/database/restore', { method: 'POST', body: JSON.stringify({ backup: pending.backup, revision: pending.preview.revision }) })
      if (!result.restored) throw new Error(t('恢复结果尚未确认，请刷新核对。'))
      setPending(null); setRestored(true); 
      await load()
    })
  }
  const disabled = busy || info?.mode !== 'database' || !!info.maintenance || restored
  return <div className="database-settings">
    <Panel title={t('资料与备份')}>
      {info?.mode === 'legacy' ? <ManualBackup /> : <div className="database-settings-body">
        <div className="database-status"><HardDrive size={25} /><div><strong>{info ? info.mode === 'database' && storageInfo.connected && !workspaceError ? t('本机资料库已启用') : info.mode === 'database' ? t('本机保存暂不可用') : t('尚未迁移，继续使用原文件') : t('正在读取资料库状态')}{info?.warning && <IssueHint important message={info.warning} />}</strong>{workspaceError && <p>{workspaceError}</p>}<small className="database-saved">{t('最近保存：')}{storageInfo.updatedAt ? new Date(storageInfo.updatedAt).toLocaleString(locale()) : t('尚无保存记录')}</small></div></div>
        {info?.maintenance && <p role="status">{t('维护中')}</p>}
        {error && !pending && <p className="settings-error" role="alert">{error}</p>}
        <div className="settings-actions"><Button variant="primary" disabled={disabled} onClick={() => void exportFile()}>{t('导出备份')}</Button><label className={`settings-import ${disabled ? 'disabled' : ''}`}>{t('导入备份')}<input ref={input} type="file" accept="application/json,.json" aria-label={t('选择备份文件')} disabled={disabled} onChange={event => void select(event.target.files?.[0])} /></label>{restored && <Button variant="primary" onClick={() => window.location.reload()}>{t('重新载入恢复后的资料')}</Button>}</div>
        {info && <details className="database-path"><summary>{t('数据条数与保存位置')}</summary>{info.mode === 'database' && <dl className="database-counts">{Object.entries(labels).map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{t('{n} 条', { n: (info.counts[key] ?? 0).toLocaleString(locale()) })}</dd></div>)}</dl>}<p>{t('资料库')}</p><code>{info.path}</code>{info.backupPath && <><p>{t('导入前的保护备份')}</p><code>{info.backupPath}</code></>}</details>}
      </div>}
    </Panel>
    <Modal open={pending !== null} onClose={() => { if (!busy) { setPending(null); setError('') } }} title={t('恢复完整业务资料前确认')} description={t('将替换全部业务资料，导入前的当前资料会留一份。备份不含密钥。')}>
      <div className="database-settings-body"><p className="settings-file-label">{pending?.label}</p>{pending && <><p>{t('备份时间：')}{time(pending.preview.createdAt)}</p><p>{t('业务记录时间：')}{time(pending.preview.earliestAt)} {t('至')} {time(pending.preview.latestAt)}</p><dl className="database-counts">{Object.entries(labels).map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{t('{n} 条', { n: (pending.preview.counts[key] ?? 0).toLocaleString(locale()) })}</dd></div>)}<div><dt>{t('自定义图标')}</dt><dd>{t('{n} 个', { n: pending.preview.icons })}</dd></div></dl></>}<label className="database-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t('我确认用这份备份替换全部业务资料')}</label>{error && <p className="settings-error" role="alert">{error}</p>}<div className="settings-actions"><Button disabled={busy} onClick={() => { setPending(null); setError('') }}>{t('取消')}</Button><Button variant="primary" disabled={busy || !confirmed} onClick={restore}>{busy ? t('正在处理，请稍候') : t('确认恢复全部业务资料')}</Button></div></div>
    </Modal>
  </div>
}

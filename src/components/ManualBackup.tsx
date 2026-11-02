import { useRef, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { locale, t, useLang } from '../i18n'
import { assertWorkspacePortfolio } from '../data/portfolio'
import { browserLegacyBackup, downloadBackup, legacyPending, readBackupFile, restoreWorkspace, storageInfo, validateBackup, workspaceError } from '../data/workspace'
import type { BackupFile } from '../data/workspace'
import { Button, Modal } from './ui'

// 资料库尚未迁移时的备份：只备份人工资料（头像、手动资产、负债、价格、成本、图标）。
export default function ManualBackup() {
  useLang()
  const [pending, setPending] = useState<{ label: string; file: BackupFile } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const preview = (value: unknown, label: string) => {
    const file = validateBackup(value); assertWorkspacePortfolio(file.data)
    setPending({ file, label }); setError('')
  }
  const selectFile = async (file?: File) => {
    if (!file) return
    setBusy(true); setError('')
    try { preview(await readBackupFile(file), file.name) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('备份文件无法读取。')) }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const restore = async () => {
    if (!pending) return
    setBusy(true); setError('')
    try {
      assertWorkspacePortfolio(pending.file.data)
      await restoreWorkspace(pending.file.data)
      setPending(null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('恢复未完成，原资料仍保留。')) }
    finally { setBusy(false) }
  }
  const exportFile = async () => {
    setBusy(true); setError('')
    try { await downloadBackup() }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('导出失败，请稍后再试。')) }
    finally { setBusy(false) }
  }
  const previewData = pending?.file.data
  const unavailable = busy || !storageInfo.connected || !!workspaceError
  return <div className="database-settings-body">
    <div className="database-status"><HardDrive size={25} /><div><strong>{storageInfo.connected && !workspaceError ? t('本机文件保存已连接') : t('本机保存暂不可用')}</strong>{workspaceError && <p>{workspaceError}</p>}<small className="database-saved">{t('最近保存：')}{storageInfo.updatedAt ? new Date(storageInfo.updatedAt).toLocaleString(locale()) : t('尚无保存记录')}</small></div></div>
    {error && !pending && <p className="settings-error" role="alert">{error}</p>}
    <div className="settings-actions"><Button variant="primary" disabled={unavailable} onClick={() => void exportFile()}>{t('导出备份')}</Button><label className={`settings-import ${busy || !storageInfo.connected ? 'disabled' : ''}`}>{t('导入备份')}<input ref={fileInput} type="file" accept="application/json,.json" aria-label={t('选择备份文件')} disabled={busy || !storageInfo.connected} onChange={event => void selectFile(event.target.files?.[0])} /></label>
      {legacyPending && <Button disabled={busy} onClick={() => { try { preview(browserLegacyBackup(), t('旧浏览器资料')) } catch (reason) { setError(reason instanceof Error ? reason.message : t('旧资料无法读取。')) } }}>{t('预览旧浏览器资料')}</Button>}</div>
    <details className="database-path"><summary>{t('保存位置')}</summary><p>{t('资料文件')}</p><code>{storageInfo.filePath || t('连接后显示')}</code><p>{t('导入前的资料（每次导入会留一份）')}</p><code>{storageInfo.backupPath || t('连接后显示')}</code></details>
    <Modal open={pending !== null} onClose={() => { if (!busy) { setPending(null); setError('') } }} title={t('恢复备份前确认')} description={t('将替换头像、手动资产、负债、价格、成本和图标。导入前的当前资料会留一份。')}>
      <div className="database-settings-body"><p className="settings-file-label">{pending?.label}</p>{previewData && <dl className="database-counts"><div><dt>{t('个人头像')}</dt><dd>{previewData.avatar ? t('已设置') : t('默认')}</dd></div><div><dt>{t('手动资产')}</dt><dd>{t('{n} 项', { n: previewData.manualAssets.length })}</dd></div><div><dt>{t('负债记录')}</dt><dd>{t('{n} 条', { n: previewData.liabilities?.length ?? 0 })}</dd></div><div><dt>{t('价格或图标设置')}</dt><dd>{t('{n} 项', { n: Object.keys(previewData.customizations).length })}</dd></div><div><dt>{t('账户成本')}</dt><dd>{Object.values(previewData.costs ?? {}).reduce((sum, entries) => sum + Object.keys(entries).length, 0)} {t('条')}</dd></div></dl>}{error && <p className="settings-error" role="alert">{error}</p>}<div className="settings-actions"><Button disabled={busy} onClick={() => setPending(null)}>{t('取消')}</Button><Button variant="primary" disabled={busy} onClick={() => void restore()}>{busy ? t('正在恢复') : t('确认恢复')}</Button></div></div>
    </Modal>
  </div>
}

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleUserRound, LogOut, Upload } from 'lucide-react'
import { authStatus, changeUsername, logout } from '../data/auth'
import { t, useLang } from '../i18n'
import { commitWorkspace, readIcon, storageInfo, workspace, workspaceError } from '../data/workspace'
import { Avatar, Button, Panel } from './ui'
import DatabaseSettings from './DatabaseSettings'
import '../settings-page.css'

export default function SettingsPage() {
  useLang()
  const [busy, setBusy] = useState(false)
  const [avatarDraft, setAvatarDraft] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState('')
  const avatarInput = useRef<HTMLInputElement>(null)
  const avatar = avatarDraft ?? workspace.avatar ?? ''
  const selectAvatar = async (file?: File) => {
    if (!file) return
    setBusy(true); setAvatarError('')
    try { setAvatarDraft(await readIcon(file)) }
    catch (reason) { setAvatarError(reason instanceof Error ? reason.message : t('图片读取失败。')) }
    finally { setBusy(false); if (avatarInput.current) avatarInput.current.value = '' }
  }
  const saveAvatar = async () => {
    if (avatarDraft === null) return
    setBusy(true); setAvatarError('')
    try { await commitWorkspace({ ...workspace, avatar: avatarDraft }, 'profile'); setAvatarDraft(null) }
    catch (reason) { setAvatarError(reason instanceof Error ? reason.message : t('头像保存失败，请重试。')) }
    finally { setBusy(false) }
  }
  const [loginName, setLoginName] = useState<string | null>(null)
  const [usernameDraft, setUsernameDraft] = useState(workspace.username ?? '')
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountNote, setAccountNote] = useState('')
  const [accountFailed, setAccountFailed] = useState(false)
  useEffect(() => { authStatus().then(status => { setLoginName(status.username ?? null); setUsernameDraft(current => current || status.username || '') }).catch(() => { setAccountFailed(true); setAccountNote(t('登录信息读取失败，请刷新后再试。')) }) }, [])
  const saveUsername = async (event: FormEvent) => {
    event.preventDefault()
    setAccountBusy(true); setAccountNote(''); setAccountFailed(false)
    try {
      // 已绑定动态码时，登录名与显示名保持一致。
      const name = loginName === null ? usernameDraft.trim() : (await changeUsername(usernameDraft.trim())).username
      if (loginName !== null) setLoginName(name)
      await commitWorkspace({ ...workspace, username: name }, 'profile')
      setUsernameDraft(name); setAccountNote(loginName === null ? t('用户名已保存。') : t('用户名已更新，下次登录请使用新用户名。'))
    }
    catch (reason) { setAccountFailed(true); setAccountNote(reason instanceof Error ? reason.message : t('用户名保存失败，请重试。')) }
    finally { setAccountBusy(false) }
  }
  // 退出后整页重载，页面里已读取的资料不会留在内存里。
  const signOut = async () => {
    setAccountBusy(true)
    try { await logout(); window.location.reload() }
    catch (reason) { setAccountBusy(false); setAccountFailed(true); setAccountNote(reason instanceof Error ? reason.message : t('退出失败，请重试。')) }
  }
  return <div className="settings-page">
    <Panel title={t('个人头像')}>
      <div className="settings-panel-body">
        <div className="settings-avatar-row"><span className="personal-avatar settings-avatar-preview" aria-label={t('头像预览')}>{avatar ? <Avatar src={avatar} name={t('个人头像')} size={64} /> : <CircleUserRound size={36} strokeWidth={1.3} />}</span><div className="settings-avatar-actions">
          <label className={`settings-import ${busy || !storageInfo.connected || workspaceError ? 'disabled' : ''}`}><Upload size={15} />{t('选择图片')}<input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('选择头像，支持PNG、JPEG、WEBP，最大1 MB')} disabled={busy || !storageInfo.connected || !!workspaceError} onChange={event => void selectAvatar(event.target.files?.[0])} /></label>
          <Button variant="primary" disabled={busy || !storageInfo.connected || !!workspaceError || avatarDraft === null || avatarDraft === (workspace.avatar ?? '')} onClick={() => void saveAvatar()}>{t('保存头像')}</Button>
          {avatar && <Button disabled={busy} onClick={() => { setAvatarDraft(''); setAvatarError('') }}>{t('恢复默认')}</Button>}
        </div></div>
        {avatarError && <p className="settings-error" role="alert">{avatarError}</p>}
      </div>
    </Panel>
    <Panel title={t('登录与安全')}>
      <div className="settings-panel-body">
        <form className="settings-account" onSubmit={event => void saveUsername(event)}>
          <label><span>{t('登录用户名')}</span><input value={usernameDraft} onChange={event => { setUsernameDraft(event.target.value); setAccountNote('') }} maxLength={32} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={accountBusy || !storageInfo.connected || !!workspaceError} /></label>
          <Button type="submit" variant="primary" disabled={accountBusy || !storageInfo.connected || !!workspaceError || usernameDraft.trim() === (workspace.username ?? '')}>{t('保存用户名')}</Button>
        </form>
        {accountNote && <p className={accountFailed ? 'settings-error' : 'settings-success'} role={accountFailed ? 'alert' : 'status'}>{accountNote}</p>}
        <p className="settings-description">{t('用户名显示在右上角头像菜单里，2–32 位，可用中文、字母、数字、下划线、点、短横线。')}</p>
        <p className="settings-description">{t('换手机或重新绑定动态码：在服务器上运行')} <code>sudo investment-bind</code>{t('，扫码绑定后所有已登录设备会退出登录。')}</p>
        <div className="settings-actions"><Button disabled={accountBusy} onClick={() => void signOut()}><LogOut size={14} />{t('退出登录')}</Button></div>
      </div>
    </Panel>
    <DatabaseSettings />
  </div>
}

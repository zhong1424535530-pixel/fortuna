import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CircleUserRound, Eye, EyeOff, LogOut, Settings2, Tags } from 'lucide-react'
import { logout } from '../data/auth'
import { workspace } from '../data/workspace'
import { setLang, t, useLang } from '../i18n'
import { Avatar } from './ui'
import '../profile-menu.css'

// 右上角头像：点开后可切换语言、隐藏金额、进入设置、退出登录。
export default function ProfileMenu({ hidden, onToggleHidden, onSettings, onManage }: { hidden: boolean; onToggleHidden: () => void; onSettings: () => void; onManage: () => void }) {
  const lang = useLang()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey) }
  }, [open])

  // 退出后整页重载，页面里已读取的资料不会留在内存里。
  const signOut = async () => {
    setBusy(true)
    try { await logout() } catch { /* 退出请求失败也重载：重载后会按服务器的登录状态显示。 */ }
    window.location.reload()
  }
  const avatar = (size: number) => workspace.avatar ? <Avatar src={workspace.avatar} name={t('个人头像')} size={size} /> : <CircleUserRound size={size * .6} strokeWidth={1.3} />

  return <div className="profile-menu" ref={root}>
    <button type="button" className="profile-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={t('账户菜单')} onClick={() => setOpen(value => !value)}>
      <span className="personal-avatar" aria-hidden>{avatar(36)}</span>
      {workspace.username && <strong className="profile-name">{workspace.username}</strong>}
      <ChevronDown size={12} className="profile-caret" aria-hidden />
    </button>
    {open && <div className="profile-popover" role="menu">
      <div className="profile-head"><span className="personal-avatar" aria-hidden>{avatar(40)}</span><strong>{workspace.username ?? t('我的账户')}</strong></div>
      <div className="profile-row" role="none"><span>{t('语言')}</span>
        <div className="profile-lang" role="group" aria-label={t('语言')}>{(['zh', 'en'] as const).map(item => <button type="button" key={item} className={lang === item ? 'active' : ''} aria-pressed={lang === item} onClick={() => setLang(item)}>{item === 'zh' ? '中文' : 'EN'}</button>)}</div>
      </div>
      <button type="button" role="menuitemcheckbox" aria-checked={hidden} className="profile-item" onClick={onToggleHidden}>{hidden ? <EyeOff size={16} /> : <Eye size={16} />}<span>{t('隐藏金额')}</span><span className={`profile-switch${hidden ? ' on' : ''}`} aria-hidden /></button>
      <button type="button" role="menuitem" className="profile-item mobile-only" onClick={() => { setOpen(false); onManage() }}><Tags size={16} /><span>{t('资产与价格')}</span></button>
      <button type="button" role="menuitem" className="profile-item" onClick={() => { setOpen(false); onSettings() }}><Settings2 size={16} /><span>{t('设置')}</span></button>
      <button type="button" role="menuitem" className="profile-item danger" disabled={busy} onClick={() => void signOut()}><LogOut size={16} /><span>{t('退出登录')}</span></button>
    </div>}
  </div>
}

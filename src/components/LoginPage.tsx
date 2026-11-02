import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { MotionConfig, motion } from 'motion/react'
import { RefreshCw } from 'lucide-react'
import { login } from '../data/auth'
import { setLang, t, useLang } from '../i18n'
import { Button } from './ui'
import Wordmark, { Mark } from './Wordmark'
import '../login-page.css'

const NAME_KEY = 'login-username'
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? '' } catch { return '' } }

function Brand() {
  return <div className="login-brand">
    <span className="login-mark" aria-hidden><Mark /></span>
    <h1><Wordmark className="login-wordmark" /></h1>
    <p>{t('资管宝')}</p>
  </div>
}

export function LoginShell({ children }: { children: ReactNode }) {
  const lang = useLang()
  return <MotionConfig reducedMotion="user"><div className="login-page"><div className="login-lang profile-lang" role="group" aria-label={t('语言')}>{(['zh', 'en'] as const).map(item => <button type="button" key={item} className={lang === item ? 'active' : ''} aria-pressed={lang === item} onClick={() => setLang(item)}>{item === 'zh' ? '中文' : 'EN'}</button>)}</div><motion.main className="login-card" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .45, ease: [.2, .8, .2, 1] }}>{children}</motion.main></div></MotionConfig>
}

export function LoginLoading({ text }: { text: string }) {
  useLang()
  return <LoginShell><Brand /><p className="login-status" role="status"><RefreshCw size={14} className="login-spin" />{text}</p></LoginShell>
}

export function LoginFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  useLang()
  return <LoginShell><Brand /><p className="login-error" role="alert">{message}</p><Button className="login-submit" onClick={onRetry}>{t('重试')}</Button></LoginShell>
}

export default function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  useLang()
  const [username, setUsername] = useState(readName)
  const [code, setCode] = useState('')
  const [focused, setFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shake, setShake] = useState(0)
  const codeInput = useRef<HTMLInputElement>(null)
  const ready = username.trim().length > 0 && code.length === 6

  useEffect(() => { if (username) codeInput.current?.focus() }, [])
  // 输满 6 位自动提交；失败后清空，不会重复提交同一个码。
  useEffect(() => { if (ready && !busy) void submit() }, [code])

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!ready || busy) return
    setBusy(true); setError('')
    try {
      await login(username.trim(), code)
      try { localStorage.setItem(NAME_KEY, username.trim()) } catch { /* 记不住用户名不影响登录。 */ }
      onLoggedIn()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('登录未完成，请稍后重试。'))
      setCode(''); setShake(value => value + 1); setBusy(false)
    }
  }
  // 失败后输入框会重新挂载（为了重播抖动），等它挂好再把光标放回去。
  useEffect(() => { if (shake) codeInput.current?.focus() }, [shake])

  return <LoginShell>
    <Brand />
    <form className="login-form" onSubmit={event => void submit(event)}>
      <label className="login-field"><span>{t('用户名')}</span>
        <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={32} disabled={busy} />
      </label>
      <div className="login-field"><span id="login-code-label">{t('动态验证码')}</span>
        <div className={`login-code${shake ? ' shake' : ''}`} key={shake} onClick={() => codeInput.current?.focus()}>
          <input ref={codeInput} value={code} inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} aria-labelledby="login-code-label" disabled={busy}
            onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
          {Array.from({ length: 6 }, (_, index) => <span key={index} aria-hidden className={`login-cell${code[index] ? ' filled' : ''}${focused && index === Math.min(code.length, 5) ? ' active' : ''}`}>{code[index] ?? ''}</span>)}
        </div>
        <small>{t('打开谷歌验证器，输入当前显示的 6 位数字。')}</small>
      </div>
      {error && <p className="login-error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" className="login-submit" disabled={!ready || busy}>{busy ? <><RefreshCw size={14} className="login-spin" />{t('验证中')}</> : t('进入')}</Button>
    </form>
  </LoginShell>
}

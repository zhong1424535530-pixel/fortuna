import { useCallback, useEffect, useRef, useState } from 'react'
import App from '../App'
import { authStatus } from '../data/auth'
import { initializeWorkspace } from '../data/workspace'
import { initializeLiveData } from '../data/live'
import { refreshPortfolio } from '../data/portfolio'
import { initializeForex } from '../data/forex'
import { t, useLang } from '../i18n'
import LoginPage, { LoginFailed, LoginLoading } from './LoginPage'

type Phase = 'checking' | 'login' | 'loading' | 'ready' | 'failed'

// 登录后才读取资料并显示页面；任何接口提示登录失效时回到登录页。
export default function AuthGate() {
  useLang()
  const [phase, setPhase] = useState<Phase>('checking')
  const [message, setMessage] = useState('')
  const expired = useRef(false), started = useRef(false)

  const enter = useCallback(async () => {
    expired.current = false
    setPhase('loading')
    await Promise.all([initializeLiveData(), initializeForex()])
    await initializeWorkspace()
    refreshPortfolio()
    setPhase(expired.current ? 'login' : 'ready')
  }, [])
  const check = useCallback(async () => {
    setPhase('checking')
    try {
      const next = await authStatus()
      if (next.authenticated) await enter(); else setPhase('login')
    } catch (error) { setMessage(error instanceof Error ? error.message : t('无法连接服务。')); setPhase('failed') }
  }, [enter])

  useEffect(() => { if (!started.current) { started.current = true; void check() } }, [check])
  useEffect(() => {
    const onExpired = () => { expired.current = true; setPhase(current => current === 'ready' ? 'login' : current) }
    window.addEventListener('auth-required', onExpired)
    return () => window.removeEventListener('auth-required', onExpired)
  }, [])

  if (phase === 'ready') return <App />
  if (phase === 'login') return <LoginPage onLoggedIn={() => void enter()} />
  if (phase === 'failed') return <LoginFailed message={message} onRetry={() => void check()} />
  return <LoginLoading text={phase === 'loading' ? t('正在读取资料…') : t('正在连接…')} />
}

import { t } from '../i18n'

export type AuthStatus = { bound: boolean; authenticated: boolean; username?: string }

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Investment-App': '1' }, signal: AbortSignal.timeout(15000) }) }
  catch { throw new Error(t('无法连接服务，请检查网络后重试。')) }
  let value: unknown = null
  try { value = await response.json() } catch { /* 没有内容时按状态码提示。 */ }
  if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? t(String(value.error)) : t('请求未完成，请稍后重试。'))
  return value as T
}

export const authStatus = () => call<AuthStatus>('/api/auth/status')
export const login = (username: string, code: string) => call<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, code }) })
export const logout = () => call<{ ok: true }>('/api/auth/logout', { method: 'POST' })
export const changeUsername = async (username: string) => {
  const result = await call<{ username: string }>('/api/auth/username', { method: 'PUT', body: JSON.stringify({ username }) })
  try { localStorage.setItem('login-username', result.username) } catch { /* 记不住用户名不影响使用。 */ }
  return result
}

// 任何资料接口返回 401（登录过期或被退出）都通知页面回到登录页，不用每个请求各自处理。
export function watchAuthExpiry() {
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (response.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('auth-required'))
    return response
  }
}

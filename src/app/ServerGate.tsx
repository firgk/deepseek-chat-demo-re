import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSettings } from '../services/settings.js'
import { loadServerSettings, serverRequest, useServerState } from '../services/serverState.js'
import { Button } from '../components/base/Button.js'
import styles from './ServerGate.module.css'

export const ServerGate = ({ children }: { children: ReactNode }) => {
  const auth = useServerState((state) => state.auth)
  const zh = useSettings((state) => state.locale) === 'zh-CN'
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const password = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      const { authenticated } = await serverRequest<{ authenticated: boolean }>('/api/auth/session')
      if (!authenticated) {
        useServerState.setState({ auth: 'signed-out' })
        return
      }
      await loadServerSettings()
      useServerState.setState({ auth: 'signed-in' })
    })().catch(() => {
      setError(zh ? '无法连接到服务，请刷新重试。' : 'Cannot reach the server. Reload to retry.')
    })
    // Startup only. The login form cannot change the locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (auth === 'signed-in') {
    return children
  }

  return (
    <main className={styles.page}>
      {auth === 'checking' ? (
        <p role="status">{error || (zh ? '正在检查登录状态…' : 'Checking sign-in…')}</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            if (!password.current?.value || busy) {
              return
            }
            setBusy(true)
            setError('')
            void serverRequest('/api/login', {
              method: 'POST',
              body: JSON.stringify({ password: password.current.value }),
            })
              .then(() => location.reload())
              .catch(() => {
                setError(
                  zh
                    ? '登录失败，请检查密码或稍后重试。'
                    : 'Sign-in failed. Check the password or try again later.'
                )
                setBusy(false)
              })
          }}
        >
          <h1>
            <img src="./logo.svg" width={48} height={48} alt="" />
            <span>deepseek-chat-demo-re</span>
          </h1>
          <label htmlFor="site-password">{zh ? '站点密码' : 'Site password'}</label>
          <input
            ref={password}
            id="site-password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {zh ? '登录' : 'Sign in'}
          </Button>
          {error ? <span role="alert">{error}</span> : null}
        </form>
      )}
    </main>
  )
}

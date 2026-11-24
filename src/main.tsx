import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { ServerGate } from './app/ServerGate.js'
import { serverEnabled } from './services/serverState.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  serverEnabled() ? (
    <ServerGate>
      <App />
    </ServerGate>
  ) : (
    <App />
  )
)

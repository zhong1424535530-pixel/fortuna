import React from 'react'
import ReactDOM from 'react-dom/client'
import AuthGate from './components/AuthGate'
import './styles.css'
import './glass.css'
import { watchAuthExpiry } from './data/auth'
import { startDomTranslation } from './i18n-dom'

watchAuthExpiry()
startDomTranslation()
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>,
)

import React from 'react'
import { createRoot } from 'react-dom/client'
import { connectPanelPort } from '../lib/panelPort'
import App from './App'
import './styles.css'

// Let the browser-wide toggle shortcut close this panel (see background.ts).
connectPanelPort()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

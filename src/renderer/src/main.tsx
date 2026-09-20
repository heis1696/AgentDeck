import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './tokens.css'
import './polish/foundation.css'
import './polish/page-shell.css'
import './polish/issue-home.css'
import './polish/board.css'
import './polish/detail.css'
import './polish/usage.css'
import './polish/team.css'
import './polish/dock.css'
import './polish/operations.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

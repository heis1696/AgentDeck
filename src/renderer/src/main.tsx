import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './tokens.css'
import './polish/foundation.css'
import './polish/issue-home.css'
import './polish/board.css'
import './polish/detail.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

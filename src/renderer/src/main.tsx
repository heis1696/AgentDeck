import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bridge } from './api'
import { setSharedPathKeyPlatform } from '../../shared/path-key'
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

// 渲染页没有 process：平台语义（sharedPathKey 的 win32 折叠/posix 精确分支）只能
// 用 preload 白名单注入的字面量，必须在首次渲染前落位
setSharedPathKeyPlatform(bridge?.platform)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

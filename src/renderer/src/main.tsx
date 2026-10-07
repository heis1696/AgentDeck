import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bridge } from './api'
import { dismissSplash } from './splash'
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
import './polish/confirm.css'

// 渲染页没有 process：平台语义（sharedPathKey 的 win32 折叠/posix 精确分支）只能
// 用 preload 白名单注入的字面量，必须在首次渲染前落位
setSharedPathKeyPlatform(bridge?.platform)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 开机动画兜底：数据就绪的快路径在 App（tasksReady 即淡出），但 React 树若在
// 装载期崩溃（effect 不执行，splash 会永远盖住空页面），这里在 bundle 顶层
// 保底收场——动画最长多停留 10 秒，不把故障界面挡死
window.setTimeout(dismissSplash, 10_000)

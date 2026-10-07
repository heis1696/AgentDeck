import { useEffect, useMemo, useState } from 'react'
import { bridge, useIssues, useSettings, useTasks, waitForTaskListed } from './api'
import { TASK_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from './labels'
import { TaskDetail } from './components/TaskDetail'
import { SettingsView } from './components/SettingsView'
import { UsageView } from './components/UsageView'
import { WorkspaceView } from './components/WorkspaceView'
import { TabBar } from './components/TabBar'
import { BoardView } from './components/BoardView'
import { AutomationView } from './components/AutomationView'
import { ExtensionsView } from './components/ExtensionsView'
import { IssuesView } from './components/IssuesView'
import { AgentsView } from './components/AgentsView'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { ListTodo, Kanban, Gauge, Settings, Search, Plus, Command, AlarmClock, Layers, Users } from 'lucide-react'
import { ToastHost } from './ui/Toasts'
import { ConfirmHost } from './ui/Confirm'
import { Palette, type PaletteCommand } from './ui/Palette'
import { PageHeader } from './ui/PageHeader'
import { ui, rootTabsOf, type UiView } from './ui/interaction-center'
import { useInteractionSelector } from './hooks/useInteraction'
import { PetStage } from './pet/PetStage'
import { PetSettingsPage } from './pet/PetSettingsPage'
import type { Task } from '../../shared/types'
import { extendRecentWorkspaces, pushRecentWorkspace } from '../../shared/path-key'
import { publicTasksOf } from '../../shared/task-visibility'
import { dismissSplash } from './splash'
import { useMeetings } from './hooks/useMeetings'
import { MeetingDetail } from './components/meeting/MeetingDetail'
import { isMeetingInternalTask, meetingForNavigation, meetingNavigationCatalog, meetingNavigationEntries, meetingNavigationTasks, meetingRootId } from './components/meeting/meetingViewState'

type View = UiView
/** 最近工作区列表的上限（切换器下拉里展示） */
const MAX_RECENT_WORKSPACES = 8

export function App() {
  // 小助理（桌宠）复用同一 renderer 入口的两个 hash 路由：#/pet 透明舞台、#/pet-settings 独立设置窗。
  //（hash 每窗固定，早退在所有 hook 之前，不违反 hooks 规则）
  // 兼容 #/pet（dev 拼接与新版 loadFile '/pet'）与 #pet（旧主进程 loadFile 'pet'——热更错峰期防主 UI 误入宠物窗）
  if (/^#\/?pet$/.test(window.location.hash)) return <PetStage />
  if (/^#\/?pet-settings$/.test(window.location.hash)) return <PetSettingsPage />
  const { tasks, refresh, ready, error: tasksError } = useTasks()
  const { settings, update } = useSettings()
  const { issues } = useIssues()
  const { meetings, ready: meetingsReady, error: meetingsError, refresh: refreshMeetings } = useMeetings()
  const navigationEntries = useMemo(() => meetingNavigationEntries(tasks, meetings, issues), [tasks, meetings, issues])
  // 界面交互状态（视图/页签/面板/设置分区）全部来自交互中心：宿主只订阅，不再各持一份
  const view = useInteractionSelector((state) => state.view)
  const activeId = useInteractionSelector((state) => state.activeId)
  const tabs = useInteractionSelector((state) => state.tabs)
  const unresolvedMeetingTabs = meetingsReady ? '' : tabs.filter((id) => id.startsWith('meeting:')).join('\n')
  const navigationTasks = useMemo(() => {
    const listed = meetingNavigationTasks(tasks, meetings, issues)
    if (meetingsReady) return listed
    const knownIds = new Set(listed.map((task) => task.id))
    const unresolved = [...new Set([...unresolvedMeetingTabs.split('\n'), ...ui.tasks().map((task) => task.id)])].filter((id) => id.startsWith('meeting:') && !knownIds.has(id))
    return [...listed, ...unresolved.map((id): Task => ({
      id, title: ui.tasks().find((task) => task.id === id)?.title ?? '会议目录待加载',
      prompt: '', workdir: '', backend: 'meeting', status: 'queued', createdAt: 0, eventCount: 0,
      meetingId: id.slice('meeting:'.length), meetingTaskRole: 'container'
    }))]
  }, [tasks, meetings, issues, meetingsReady, unresolvedMeetingTabs])
  const catalog = useMemo(() => meetingNavigationCatalog(navigationTasks.filter((task) => !meetings.some((meeting) => task.id === meetingRootId(meeting.id))), meetings, issues), [navigationTasks, meetings, issues])
  const paletteOpen = useInteractionSelector((state) => state.paletteOpen)
  const settingsSection = useInteractionSelector((state) => state.settingsSection)
  const [workspaceDir, setWorkspaceDir] = useState(() => localStorage.getItem('agentdeck:workspace-dir') ?? '')
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
    // 持久化列表读入即按路径键去重：历史版本可能存过同一目录的别名写法（大小写差异），
    // 不去重会一直重复展示（与主进程路径等价判定同语义）
    try {
      const stored = JSON.parse(localStorage.getItem('agentdeck:recent-workspaces') ?? '[]') as string[]
      return Array.isArray(stored) ? extendRecentWorkspaces([], stored, MAX_RECENT_WORKSPACES) : []
    } catch { return [] }
  })
  const selected = navigationTasks.find((task) => task.id === activeId) ?? null
  const selectedMeeting = meetingForNavigation(activeId ?? '', tasks, meetings)
  // 顶部页签条只列「普通页签」：子任务（祖先链完整）在领队详情的右侧分页里。
  // 判定与 openTask 的路由同源（rootTabsOf）：祖先链断裂的任务是普通页签，不能再按
  // parentTaskId 一刀切过滤——那会把它们从页签条上藏掉，只剩一个看不见的激活项。
  const rootTabs = useMemo(() => rootTabsOf(catalog, tabs), [catalog, tabs])

  useEffect(() => {
    const theme = settings?.theme ?? 'light'
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => document.documentElement.classList.toggle('light', theme === 'light' || (theme === 'system' && mq.matches))
    apply()
    if (theme === 'system') { mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply) }
  }, [settings?.theme])

  // 开机动画（index.html 静态层，盖住 bundle 加载与首屏数据装载期的白屏）收场：
  // 任务目录拿到第一份真实快照即淡出让首屏接棒；加载故障/渲染崩溃的兜底在
  // main.tsx 顶层（不随 React 树陪葬），桌宠窗在 index.html 解析期就 display:none
  useEffect(() => {
    if (ready) dismissSplash()
  }, [ready])

  // 界面字号：只改 --ui-font-size 这一个变量（字阶令牌全部由它推导），
  // 绝不动 html 自身 font-size——图标/间距/圆角不随字号缩放。
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font-size', `${settings?.uiFontSize ?? 14}px`)
  }, [settings?.uiFontSize])

  // 中心持有最新任务目录：祖先链解析（子任务→领队）、删除清理、dock 桶剪枝都以它为准。
  // 首份真实列表到达前不喂（ready 门控）：启动瞬间的空目录是「未加载」不是「没有任务」，
  // 喂进去会把待决路由乐观页签全部剪掉。
  useEffect(() => {
    if (ready) ui.setTasks(catalog)
  }, [catalog, ready])
  useEffect(() => { if (tasksError) ui.toast.error(`读取任务失败：${tasksError}`) }, [tasksError])

  const openTask = (id: string) => {
    const meeting = meetingForNavigation(id, tasks, meetings)
    ui.openTask(meeting ? meetingRootId(meeting.id) : id)
  }
  /** 草稿创建只广播 Issue 更新，必须把新任务写入页面目录后再导航。 */
  const openCreatedTask = async (id: string) => {
    await waitForTaskListed(id)
    const list = await refresh()
    if (!list?.some((task) => task.id === id)) {
      ui.toast.error('任务已创建，目录暂未刷新，请稍后从看板打开')
      return
    }
    const latestMeetings = await refreshMeetings()
    if (!latestMeetings && list.find((task) => task.id === id)?.meetingId) {
      ui.toast.error('会议已创建，会议目录暂未刷新，请重试打开')
      return
    }
    ui.setTasks(meetingNavigationCatalog(list, latestMeetings ?? meetings, issues))
    ui.openTask(id)
  }
  /** Ctrl+N/侧栏「新建任务」：导航到 Issue 主页（新建表单即主页主体）并请求聚焦输入框 */
  const goWorkspace = () => { ui.focusComposer() }
  /** 切到某个最近用过的工作区：新任务默认目录随之变化。最近列表按路径键上浮去重：
   *  别名写法（大小写/分隔符差异）是同一目录，不重复展示与持久化 */
  const chooseWorkspace = (dir: string) => {
    if (!dir) return
    setWorkspaceDir(dir)
    localStorage.setItem('agentdeck:workspace-dir', dir)
    setRecentWorkspaces((current) => {
      const next = pushRecentWorkspace(current, dir, MAX_RECENT_WORKSPACES)
      localStorage.setItem('agentdeck:recent-workspaces', JSON.stringify(next))
      return next
    })
  }
  const pickWorkspace = async () => { const dir = await bridge.pickDir(); if (dir) chooseWorkspace(dir) }
  // 任务里出现过的工作目录自动进最近列表（新装/清缓存后不用手动重选）；别名写法不重复并入
  useEffect(() => {
    const dirs = tasks.map((task) => task.workdir.trim()).filter(Boolean)
    if (!dirs.length) return
    setRecentWorkspaces((current) => {
      const next = extendRecentWorkspaces(current, dirs, MAX_RECENT_WORKSPACES)
      if (next.length === current.length && next.every((dir, index) => dir === current[index])) return current
      localStorage.setItem('agentdeck:recent-workspaces', JSON.stringify(next))
      return next
    })
  }, [tasks])
  useEffect(() => bridge.tasks.onDeleted((id) => ui.closeTab(id)), [])
  useEffect(() => bridge.tasks.onFocusTask((id) => ui.openTask(id)), [])
  // 全局快捷键：解析与执行都在交互中心（输入法组合中/可编辑元素/浮层打开时让路）
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = ui.handleKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        target: event.target as HTMLElement | null
      })
      if (action) event.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const nav = (next: View) => { ui.navigate(next) }
  const navIssues = () => ui.navigate('issues')
  const openSettings = (section?: string) => { ui.openSettings(section) }

  const commands: PaletteCommand[] = useMemo(() => [
    ...[['Issue', navIssues], ['看板', () => nav('board')], ['Agent 管理', () => nav('agents')], ['自动化', () => nav('automation')], ['扩展', () => nav('skills')], ['用量', () => nav('usage')], ['设置', () => openSettings('general')], ['设置 · 运行时', () => openSettings('runtime')]].map(([label, run]) => ({ id: String(label), group: '跳转', label: String(label), run: run as () => void })),
    { id: 'new', group: '操作', label: '新建任务', hint: 'Ctrl+N', run: goWorkspace },
    { id: 'theme', group: '操作', label: '切换深浅主题', run: () => void update({ theme: (settings?.theme ?? 'light') === 'dark' ? 'light' : 'dark' }) },
    ...publicTasksOf(navigationEntries).map((task) => {
      const parked = isParkedQueued(task)
      const issue = issues.find((item) => item.taskId === task.id || item.id === task.issueId)
      return {
        id: task.id,
        group: '任务',
        label: task.title,
        hint: parked ? `${PARKED_QUEUED_LABEL} · 打开详情` : TASK_STATUS_LABELS[task.status],
        keywords: [
          task.id,
          task.issueId,
          issue?.id,
          issue?.identifier,
          task.prompt,
          task.backend,
          task.workdir,
          task.status,
          TASK_STATUS_LABELS[task.status],
          issue?.status,
          ...(issue?.labels ?? [])
        ].filter(Boolean).join(' '),
        run: () => openTask(task.id)
      }
    })
  ], [issues, navigationEntries, settings?.theme])

  const detailContent = selectedMeeting
    ? <MeetingDetail key={selectedMeeting.id} meeting={selectedMeeting} tasks={tasks} onDeleted={(id) => ui.closeTab(meetingRootId(id))} />
    : selected?.meetingId || (selected && isMeetingInternalTask(selected)) || activeId?.startsWith('meeting:')
      ? <div className="data-state-banner" role="status"><span>{meetingsError ? `会议目录读取失败：${meetingsError}` : meetingsReady ? '会议记录不存在，不能替换为普通任务详情。' : '正在读取会议目录…'}</span><button className="btn" onClick={() => void refreshMeetings()}>重试</button></div>
      : selected ? <TaskDetail task={selected} tasks={tasks} onSelect={openTask} /> : null

  return <div className="app" data-view={view}>
    <ToastHost /><ConfirmHost /><Palette open={paletteOpen} onClose={() => ui.palette.close()} commands={commands} />
    <aside className="sidebar">
      <div className="brand" aria-label="AgentDeck"><span className="brand-mark">A</span><span className="brand-name">AgentDeck</span><span className="brand-status" aria-hidden="true" title="本地工作区已连接" /></div>
      <WorkspaceSwitcher dir={workspaceDir} recent={recentWorkspaces} onChoose={chooseWorkspace} onPick={pickWorkspace} />
      <button className="new-task-btn" type="button" onClick={goWorkspace} title="新建任务（Ctrl+N）"><Plus size={15} /> 新建任务 <kbd>Ctrl+N</kbd></button>
      {/* title 兼作图标轨（≤560px）下的悬浮说明：窄侧栏里 .nav-label 视觉隐藏但仍在可访问树中 */}
      <nav className="nav" aria-label="主导航">
        <button className={view === 'issues' || view === 'detail' ? 'active' : ''} aria-current={view === 'issues' || view === 'detail' ? 'page' : undefined} onClick={navIssues} title="新建及已打开的 Issue"><ListTodo /><span className="nav-label">Issue</span></button>
        <button className={view === 'board' ? 'active' : ''} aria-current={view === 'board' ? 'page' : undefined} onClick={() => nav('board')} title="看板"><Kanban /><span className="nav-label">看板</span></button>
        <button className={view === 'agents' ? 'active' : ''} aria-current={view === 'agents' ? 'page' : undefined} onClick={() => nav('agents')} title="Agent 管理"><Users /><span className="nav-label">Agent</span></button>
        <button className={view === 'automation' ? 'active' : ''} aria-current={view === 'automation' ? 'page' : undefined} onClick={() => nav('automation')} title="自动化"><AlarmClock /><span className="nav-label">自动化</span></button>
        <button className={view === 'skills' ? 'active' : ''} aria-current={view === 'skills' ? 'page' : undefined} onClick={() => nav('skills')} title="扩展"><Layers /><span className="nav-label">扩展</span></button>
        <button className={view === 'usage' ? 'active' : ''} aria-current={view === 'usage' ? 'page' : undefined} onClick={() => nav('usage')} title="用量"><Gauge /><span className="nav-label">用量</span></button>
        <button className={view === 'settings' ? 'active' : ''} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => openSettings()} title="设置"><Settings /><span className="nav-label">设置</span></button>
      </nav>
      <div className="sidebar-footer"><span className="connection-dot" aria-hidden="true" /> 本地引擎就绪</div>
    </aside>
    <main className="main">
      {meetingsError && <div className="data-state-banner" role="status"><span>会议目录读取失败，普通任务仍可使用：{meetingsError}</span><button type="button" className="btn" data-meetings-retry onClick={() => void refreshMeetings()}>重试会议目录</button></div>}
      {view === 'agents' ? <AgentsView /> : view === 'automation' ? <AutomationView /> : view === 'skills' ? <ExtensionsView /> : view === 'settings' ? <SettingsView section={settingsSection} onSection={(section) => ui.openSettings(section)} /> : view === 'usage' ? <UsageView /> : view === 'board' ? <div className="tasks-column"><PageHeader title="看板" icon={<Kanban size={16} />} actions={<button className="command-trigger" type="button" onClick={() => ui.palette.open()} title="搜索任务（Ctrl+K）" aria-label="搜索任务" aria-keyshortcuts="Control+K Meta+K"><Search size={14} /> 搜索任务 <kbd><Command size={10} /> K</kbd></button>} /><BoardView tasks={tasks} onOpen={openTask} /></div> : view === 'detail' && (selected || selectedMeeting || activeId?.startsWith('meeting:')) ? <div className="tasks-column detail-page"><Chrome title={selected?.title ?? selectedMeeting?.topic ?? '会议'} onBack={() => ui.navigate('issues')} />{rootTabs.length > 0 && <TabBar tabs={rootTabs} tasks={navigationTasks} activeId={activeId} onSelect={openTask} onClose={(id) => ui.closeTab(id)} />}{detailContent}</div> : <IssuesView tasks={navigationEntries} tabs={tabs} onOpen={openTask} onClose={(id) => ui.closeTab(id)} onBrowseAll={() => ui.navigate('board')}><WorkspaceView onCreated={(task) => openCreatedTask(task.id)} workspaceDir={workspaceDir} onPickWorkspace={pickWorkspace} /></IssuesView>}
    </main>
  </div>
}

/** 详情页顶栏：返回 + 面包屑（从属上下文；主标题由 TaskDetail 的共享页头承担，不在这里重复大标题） */
function Chrome({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="workspace-topbar">
    <div className="breadcrumb"><span>个人工作区</span><i>/</i><strong>{title}</strong></div>
    <div className="topbar-actions"><button className="icon-btn" type="button" onClick={onBack} title="返回任务列表" aria-label="返回任务列表"><ListTodo size={16} /></button></div>
  </div>
}

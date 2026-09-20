import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, Copy, FileText, FolderOpen, History, Info, ListChecks,
  Pencil, Play, RefreshCw, Square, Trash2, Users, Waypoints
} from 'lucide-react'
import { bridge, fmtDuration, fmtTime, fmtTokens } from '../api'
import { taskService } from '../task-service'
import { GOAL_STATUS_LABELS, PARKED_QUEUED_LABEL, TASK_STATUS_LABELS, isParkedQueued } from '../labels'
import { Markdown } from './Markdown'
import { ui, isComposingKey } from '../ui/interaction-center'
import { IssueIdChip } from '../ui/IssueIdChip'
import { PageHeader } from '../ui/PageHeader'
import { useTaskEvents } from '../hooks/useTaskEvents'
import { useTurnModel } from '../hooks/turnModel'
import { useIssueDetails } from '../hooks/useIssueDetails'
import { PermissionPrompt } from './task/PermissionPrompt'
import { FOLLOW_EPSILON, TurnTimeline } from './task/TurnTimeline'
import { SkillMenu, buildMenuItems, parseSkillDirective, wrapSkillDirective, SKILL_MENU_LISTBOX_ID, skillMenuOptionId, type LocalCommandKey } from './task/SkillMenu'
import { ActionMenu, type ActionMenuItem } from './task/ActionMenu'
import { usePromptHistory } from '../hooks/usePromptHistory'
import { taskDraftSlot, useTaskDraftField, useTaskScopedState } from '../hooks/taskDrafts'
import { SideDock } from '../ui/SideDock'
import { scrollElementTo } from '../ui/motion'
import { useInteractionLayer } from '../hooks/useInteractionLayer'
import { ActivityTimeline } from './task/ActivityTimeline'
import { GitSummary } from './task/GitSummary'
import { WorkerOverview } from './task/WorkerOverview'
import { buildWorkerRounds } from './task/workerRounds'
import { FloatWindow } from '../ui/FloatWindow'
import { GoalPanel } from './goal/GoalPanel'
import { MeetingPanel } from './meeting/MeetingPanel'
import { MEETING_STATUS_LABEL } from './meeting/MeetingCard'
import type { Goal, IssueStatus, Task } from '../../../shared/types'
import type { Meeting } from '../../../shared/meeting'
import type { SkillMeta } from '../../../shared/skills'
import { currentGitChanges, currentGitSnapshot } from '../../../shared/git-snapshot'

type Tab = 'activity' | 'log' | 'result' | 'git'
const TAB_ITEMS: ReadonlyArray<{ key: Tab; label: string; hint: string }> = [
  { key: 'log', label: '执行记录', hint: '回合对话与工具调用（←/→ 切换）' },
  { key: 'git', label: 'Git 改动', hint: 'git stat 与统一 diff' },
  { key: 'activity', label: '动态', hint: 'Run 报告与 Agent 通知' },
  { key: 'result', label: '结果', hint: '最终结果 Markdown' }
]
const WORKFLOW_OPTIONS: Array<{ value: IssueStatus; label: string }> = [
  { value: 'backlog', label: '待梳理' }, { value: 'todo', label: '待办' }, { value: 'in_progress', label: '进行中' },
  { value: 'in_review', label: '审查中' }, { value: 'done', label: '已完成' }, { value: 'blocked', label: '受阻' },
  { value: 'cancelled', label: '已取消' }
]

/**
 * 任务详情：头部 chrome（标题 + 一行 meta + 动作区）、运行檐（执行中实时回报）、
 * 视图页签（WAI-ARIA tabs：←/→/Home/End + Ctrl+1..4）、队员条、正文（动态/执行记录/结果/Git）
 * 与底部追问区。所有状态机、桥调用与交互中心契约保持不变：动作仍走 taskService/ui。
 */
export function TaskDetail({ task, tasks, onSelect }: { task: Task; tasks: Task[]; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('log')
  // 追问草稿与 busy 按任务分槽（会话内保留，不做持久化）：切任务立即换成新任务自己的值，
  // A→B→A 取回 A 的草稿；写入带任务归属，迟到的响应不会改到新任务的界面上。
  const [followUp, setFollowUp] = useTaskDraftField(task.id, 'prompt')
  const [busy, setBusy] = useTaskDraftField(task.id, 'busy')
  const [now, setNow] = useState(() => Date.now())
  // 就地重命名会话：随任务切换作废（不许把 A 的编辑框/草稿挂到 B 的标题上）
  const [titleEdit, setTitleEdit] = useTaskScopedState<{ draft: string } | null>(task.id, null)
  const [activeNav, setActiveNav] = useTaskScopedState(task.id, -1)
  const [following, setFollowing] = useTaskScopedState(task.id, true)
  const [infoOpen, setInfoOpen] = useTaskScopedState(task.id, false)
  // 目标/会议浮窗：同一时刻至多开一个；goal/meeting 数据由面板上报（驱动 header 状态芯片）。
  // 芯片数据也按任务分槽：面板是**异步**上报的，只用 effect 清会先画出上一个任务的芯片。
  const [float, setFloat] = useTaskScopedState<'goal' | 'meeting' | 'workers' | null>(task.id, null)
  const [goal, setGoal] = useTaskScopedState<Goal | null>(task.id, null)
  const [meeting, setMeeting] = useTaskScopedState<Meeting | null>(task.id, null)
  const logRef = useRef<HTMLDivElement>(null)
  /** 贴底跟随（审查项 2）：同步判定用 ref（事件回调里立刻可读），渲染用 following state */
  const stickRef = useRef(true)
  const followRef = useRef<HTMLTextAreaElement>(null)
  const infoRef = useRef<HTMLDivElement>(null)
  const infoPopRef = useRef<HTMLDivElement>(null)
  const titleEditBtnRef = useRef<HTMLButtonElement>(null)
  /** 重命名会话归属：正在编辑的任务 id（null = 没有会话）。切任务后残留的 Enter/blur 据此作废 */
  const titleSessionRef = useRef<string | null>(null)
  const editingTitle = !!titleEdit
  const titleDraft = titleEdit?.draft ?? ''
  const navFrameRef = useRef(0)
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>())
  const { events, permission, permissionBusy, permissionError, permissionNotice, refreshPermissions, refreshEvents, answerPermission } = useTaskEvents(task.id)
  const turns = useTurnModel(events, task.prompt)
  // 追问框：↑↓ 历史重写 + / 命令菜单（本地命令 + 技能；技能列表首按 / 时懒加载一次）
  const history = usePromptHistory(task.id)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const skillsLoadedRef = useRef(false)
  const [skillMenuOpen, setSkillMenuOpen] = useTaskScopedState(task.id, false)
  const [skillIndex, setSkillIndex] = useTaskScopedState(task.id, 0)
  const isZcode = task.backend === 'zcode'
  const skillQuery = followUp.startsWith('/') ? followUp.slice(1).split(/\s/)[0] ?? '' : ''
  const menuItems = useMemo(() => buildMenuItems(skills, skillQuery, isZcode), [skills, skillQuery, isZcode])
  useEffect(() => { setSkillIndex(0) }, [skillQuery])
  // 组合框展开态（审查项 5）：菜单开着且真有条目才算展开——SkillMenu 无条目时不渲染 listbox，
  // 此时 aria-expanded 必须是 false，否则指向了不存在的 aria-controls。
  const skillMenuExpanded = skillMenuOpen && menuItems.length > 0
  const skillActiveOptionId = skillMenuExpanded ? skillMenuOptionId(Math.min(skillIndex, menuItems.length - 1)) : undefined
  // 首次打开菜单才拉技能清单；此后复用（安装/卸载技能后重开 Issue 即刷新）
  useEffect(() => {
    if (!skillMenuOpen || skillsLoadedRef.current) return
    skillsLoadedRef.current = true
    void bridge.skills.list().then((result) => setSkills(result.skills)).catch(() => { skillsLoadedRef.current = false })
  }, [skillMenuOpen])
  const issueId = task.issueId ?? `iss_${task.id}`
  const { issue, comments, runs, loading: issueLoading, error: issueError, refreshIssue, updateWorkflow } = useIssueDetails(issueId, `${task.status}:${task.result ?? ''}:${task.eventCount}`)
  const workers = useMemo(() => tasks.filter((item) => item.parentTaskId === task.id), [tasks, task.id])
  const activeWorkers = workers.filter((item) => item.status === 'running' || item.status === 'queued')
  const hasRunningWorkers = workers.some((item) => item.status === 'running')
  const workerRounds = useMemo(() => buildWorkerRounds(workers, turns, events), [workers, turns, events])
  const workerStateSummary = [
    [workers.filter((worker) => worker.status === 'running').length, '执行中'],
    [workers.filter((worker) => worker.status === 'queued' && !worker.parked).length, '排队'],
    [workers.filter(isParkedQueued).length, '等待启动']
  ].filter(([count]) => Number(count) > 0).map(([count, label]) => `${count} ${label}`).join(' · ')
  const parent = task.parentTaskId ? tasks.find((item) => item.id === task.parentTaskId) : null
  const relayPred = task.continuesFrom ? tasks.find((item) => item.id === task.continuesFrom) : null
  const relaySucc = tasks.find((item) => item.continuesFrom === task.id)
  const relayStage = relayNumber(task, tasks)
  const isRelay = task.trigger === 'handoff' || !!relayPred || !!relaySucc
  const turnActive = task.status === 'running'
  const goalActive = !!goal && !['completed', 'cancelled'].includes(goal.status)
  const goalChipSummary = goal ? `${goal.runCount}/${goal.maxRuns} 轮 · ${GOAL_STATUS_LABELS[goal.status]}${goal.currentRunId ? ' · 执行中' : ''}` : ''
  const stateLabel = isParkedQueued(task) ? PARKED_QUEUED_LABEL : TASK_STATUS_LABELS[task.status]
  const elapsed = task.startedAt ? Math.max(0, (task.endedAt ?? now) - task.startedAt) : 0
  const lastEventAt = events.length ? events[events.length - 1].ts : 0
  const agentCommentCount = comments.filter((comment) => comment.author.type === 'agent').length
  const gitChanges = currentGitChanges(task)
  const integration = currentGitSnapshot(task)?.scope === 'integration' ? task.integration : undefined
  const gitFileCount = (gitChanges?.stat ?? '').split('\n').filter((line) => line.includes('|')).length
  const tabCount = (key: Tab): number | null => key === 'activity' ? runs.length + agentCommentCount : key === 'log' ? turns.length : key === 'git' ? gitFileCount : null
  const enabledTabs = TAB_ITEMS.map((item) => item.key)
  const canDelete = task.status !== 'running' && task.status !== 'queued'
  const workdir = task.workdir

  useLayoutEffect(() => {
    if (followRef.current) autoGrow(followRef.current)
  }, [task.id, followUp])

  useEffect(() => {
    if (!turnActive && !hasRunningWorkers) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [task.id, turnActive, hasRunningWorkers])

  // 跨任务隔离收尾：切任务即作废重命名会话令牌（ref 表达不了「按任务作用域」，故在此显式清），
  // 并把贴底跟随复位到新任务的末尾。其余瞬态会话（ℹ 弹层、命令菜单、目标/会议浮窗与芯片、
  // 日志高亮、重命名编辑框）由 useTaskScopedState 在渲染期结算，本帧就已经是初始值；
  // 追问草稿/历史/busy 走 per-task 槽，必须跨任务保留，不在这里清（清了就退回「重挂载丢草稿」的错解）。
  useEffect(() => {
    titleSessionRef.current = null
    stickRef.current = true
  }, [task.id])

  // ℹ 弹层：统一浮层（外点收起 + 最上层 Escape），原 window mousedown 监听已收敛
  useInteractionLayer<HTMLDivElement>({ open: infoOpen, onClose: () => setInfoOpen(false), kind: 'popover', name: 'task-info', closeOnOutside: true, autoFocus: false, layerRef: infoRef })

  // ℹ 弹层几何：打开时、窗口缩放、Dock 开合或拖宽（.detail-left 尺寸变化）、祖先滚动后都重新测量。
  // 只写内联几何；层栈（useInteractionLayer）与焦点契约（Escape / 外点收起）完全不动。
  useLayoutEffect(() => {
    if (!infoOpen) return
    const anchor = infoRef.current
    const pop = infoPopRef.current
    if (!anchor || !pop) return
    const place = () => placeInfoPopover(anchor, pop)
    place()
    const observer = new ResizeObserver(place)
    observer.observe(anchor)
    const column = anchor.closest<HTMLElement>('.detail-left')
    if (column) observer.observe(column)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [infoOpen])

  const scrollEl = () => {
    const element = logRef.current
    if (!element) return null
    return element.scrollHeight > element.clientHeight + 1 ? element : element.closest<HTMLElement>('.detail-main') ?? element
  }
  /** 贴底判定：与 TurnTimeline.FOLLOW_EPSILON 同源（滚到底 = 正在跟随流式末尾） */
  const atBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_EPSILON
  const syncFollowing = () => {
    const element = scrollEl()
    if (!element) return
    const next = atBottom(element)
    stickRef.current = next
    setFollowing((current) => (current === next ? current : next))
  }
  const updateActiveNav = () => {
    const element = scrollEl()
    if (!element) return
    const nodes = element.querySelectorAll<HTMLElement>('.turn')
    if (!nodes.length) { setActiveNav(0); return }
    // 滚到底（含新消息后自动跟随最新内容）时，当前回合就是最新回合——
    // 否则短的新回合在视口下半部永远够不着顶部门线，高亮会卡在上一条
    if (atBottom(element)) {
      setActiveNav(nodes.length - 1)
      return
    }
    const top = element.getBoundingClientRect().top
    let active = 0
    nodes.forEach((node, index) => { if (node.getBoundingClientRect().top - top <= 80) active = index })
    setActiveNav(active)
  }
  const onLogScroll = () => {
    // 贴底判定要立刻反映到「回到最新」按钮上，不等下一帧；activeNav 仍按帧节流
    syncFollowing()
    if (navFrameRef.current) return
    navFrameRef.current = requestAnimationFrame(() => { navFrameRef.current = 0; updateActiveNav() })
  }
  useEffect(() => {
    if (tab !== 'log') return
    const element = scrollEl()
    // 贴底跟随（审查项 2）：只有用户在底部时才把流式新内容滚进视野；
    // 已滚上去读旧内容时，新事件到达不抢滚动位置
    if (element && stickRef.current) element.scrollTop = element.scrollHeight
    updateActiveNav()
  }, [events, tab, turns.length])
  const scrollToTurn = (index: number) => {
    const element = scrollEl()
    const target = element?.querySelector<HTMLElement>(`#turn-${index}`)
    if (!element || !target) return
    const delta = target.getBoundingClientRect().top - element.getBoundingClientRect().top
    // 跳到历史回合 = 暂时不再跟随流式末尾（滚到底部时滚动事件会把它同步回 true）
    stickRef.current = false
    setFollowing(false)
    scrollElementTo(element, Math.max(0, element.scrollTop + delta - 8))
    setActiveNav(index)
  }
  /** 「回到最新」：滚到流式末尾并把跟随状态打开（滚动本身尊重 prefers-reduced-motion） */
  const followLatest = () => {
    const element = scrollEl()
    stickRef.current = true
    setFollowing(true)
    if (element) scrollElementTo(element, element.scrollHeight)
    if (turns.length) setActiveNav(turns.length - 1)
  }

  const doRewind = async (index: number) => {
    const turn = turns[index]
    if (!turn || index === 0) return
    const ok = await ui.confirm({ title: '回退到这里？', body: `将删除第 ${index + 1} 回合及其之后的所有消息记录，并按剩余内容重算任务结果与用量。该操作只影响本地日志，不会改动后端会话上下文，且不可撤销。`, danger: true, confirmText: '回退' })
    if (!ok) return
    const result = await taskService.rewind(task.id, turn.firstSeq - 1)
    if (!result.ok) ui.toast.error(result.error ?? '回退失败')
    else { ui.toast.success('已回退'); void refreshEvents() }
  }
  const doAction = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    try {
      const result = await action()
      if (!result.ok && result.error) ui.toast.error(result.error)
    } finally {
      setBusy(false)
    }
  }
  const doCancel = () => doAction(() => taskService.cancel(task.id))
  const doRetry = () => doAction(() => taskService.retry(task.id))
  const doStart = () => doAction(() => taskService.start(task.id))
  const doDelete = async () => {
    if (!(await ui.confirm({ title: '删除该任务及其日志？', body: task.title, danger: true, confirmText: '删除' }))) return
    const result = await taskService.delete(task.id)
    if (!result.ok) ui.toast.error(result.error ?? '删除失败')
  }
  const doDuplicate = async () => {
    const copy = await taskService.duplicate(task)
    if (copy) onSelect(copy.id)
  }
  const beginTitleEdit = () => { titleSessionRef.current = task.id; setTitleEdit({ draft: task.title }) }
  const cancelTitleEdit = () => { titleSessionRef.current = null; setTitleEdit(null) }
  // 就地重命名也是「浮层」：Escape 由统一交互层消费（最上层），关闭后焦点回到重命名按钮。
  // 编辑框把触发按钮**替换**掉了，所以显式给出归还目标（restoreFocusRef）。
  const titleEditRef = useInteractionLayer<HTMLInputElement>({
    open: editingTitle,
    onClose: cancelTitleEdit,
    kind: 'popover',
    name: 'title-edit',
    restoreFocusRef: titleEditBtnRef
  })
  const saveTitle = async () => {
    // 重命名会话只在它开始的那个任务上结算：切走任务后残留的 Enter/blur（含输入框随切换卸载时的
    // 失焦）一律作废，既不提交 A 的草稿，也不会改到 B 的标题上。
    const owner = titleSessionRef.current
    if (!owner || owner !== task.id) return
    titleSessionRef.current = null
    const title = (titleEdit?.draft ?? '').trim()
    setTitleEdit(null)
    if (!title || title === task.title) return
    const next = await taskService.rename(task.id, title)
    if (next) ui.toast.success('标题已更新')
  }
  /** 本地命令（/goal /meeting）：打开对应浮窗/创建流程，不发给后端 */
  const openLocalCommand = (key: LocalCommandKey) => {
    setSkillMenuOpen(false)
    setFollowUp('')
    if (followRef.current) followRef.current.style.height = 'auto'
    setFloat(key)
  }
  const sendFollowUp = async (preset?: string, opts?: { relay?: boolean }) => {
    const raw = (preset ?? followUp).trim()
    if (!raw || taskDraftSlot(task.id).busy) return
    // 输入的 /goal /meeting 不下发：转成本地浮窗/创建流程
    const local = /^\/(goal|meeting)\b/.exec(raw)
    if (local) { openLocalCommand(local[1] as LocalCommandKey); return }
    if (turnActive || task.status === 'queued') return
    // zcode 会话支持 Skill 工具：/技能名 开头的输入包装成显式技能指令再下发
    const directive = isZcode ? parseSkillDirective(raw, skills) : null
    const content = directive ? wrapSkillDirective(directive.skill, directive.rest) : raw
    const submittedRevision = taskDraftSlot(task.id).promptRevision
    setBusy(true)
    try {
      // wait:false：IPC 在回合开跑即返回，busy 不锁整轮追问——否则「停止」会禁用到回合结束
      const result = await taskService.followUp(task.id, content, { ...opts, wait: false })
      if (!result.ok) ui.toast.error(result.error ?? '续聊失败')
      else {
        history.push(raw)
        // A late acknowledgement cannot erase edits made while sending.
        if (preset === undefined && taskDraftSlot(task.id).promptRevision === submittedRevision) setFollowUp('')
      }
    } catch (cause) {
      ui.toast.error(cause instanceof Error ? cause.message : '续聊失败')
    } finally {
      setBusy(false)
    }
  }
  const copyResult = async () => {
    const parts = [`# ${task.title}`, '', task.result ?? '']
    if (gitChanges?.stat) parts.push('', '## 改动', '```', gitChanges.stat, '```')
    if (integration?.branch) parts.push('', `集成分支：\`${integration.branch}\``)
    await navigator.clipboard.writeText(parts.join('\n')); ui.toast.success('结果已复制为 Markdown')
  }
  const copyPrBody = async () => {
    const branch = integration?.branch
    const files = (gitChanges?.stat ?? '').split('\n').filter((line) => line.includes('|')).length
    const body = ['## 摘要', '', (task.result ?? '').slice(0, 2000), '', '## 改动', '', files ? `${files} 个文件有改动。` : '见提交记录。', branch ? `\n> 由 AgentDeck 队员在隔离分支 \`${branch}\` 上完成。` : ''].join('\n')
    await navigator.clipboard.writeText(`**${task.title}**\n\n${body}`); ui.toast.success('PR 描述已复制（标题 + 摘要 + 改动）')
  }
  const copyPrompt = async () => { await navigator.clipboard.writeText(task.prompt); ui.toast.success('原始指令已复制') }
  const openWorker = (id: string, title: string) => ui.dock.open({ id: `task:${id}`, kind: 'task', title, payload: { taskId: id } })
  const selectTab = (key: Tab, moveFocus = true) => {
    setTab(key)
    if (moveFocus) tabRefs.current.get(key)?.focus()
  }

  const actionItems: ActionMenuItem[] = [
    { key: 'copy-result', label: '复制结果', hint: 'Markdown', icon: <Copy size={13} aria-hidden="true" />, disabled: busy || !task.result, run: () => void copyResult() },
    { key: 'copy-pr', label: '复制 PR 描述', hint: '标题 + 摘要 + 改动', icon: <Copy size={13} aria-hidden="true" />, disabled: busy || !task.result, run: () => void copyPrBody() },
    { key: 'copy-prompt', label: '复制原始指令', icon: <Copy size={13} aria-hidden="true" />, run: () => void copyPrompt() },
    { key: 'duplicate', label: '复制为新任务', icon: <ListChecks size={13} aria-hidden="true" />, disabled: busy, run: () => void doDuplicate() },
    ...(workdir ? [{ key: 'open-dir', label: '打开工作目录', hint: workdir, icon: <FolderOpen size={13} aria-hidden="true" />, run: () => void bridge.openPath(workdir) }] : []),
    ...(canDelete ? [{ key: 'delete', label: '删除任务与日志', icon: <Trash2 size={13} aria-hidden="true" />, danger: true, run: () => void doDelete() }] : [])
  ]

  return <div
    className="detail"
    onKeyDown={(event) => {
      // Ctrl/Cmd+1..4：视图页签直达（全局快捷键表未占用这组组合）
      if (!(event.ctrlKey || event.metaKey) || !/^[1-9]$/.test(event.key)) return
      const key = enabledTabs[Number(event.key) - 1]
      if (!key) return
      event.preventDefault()
      selectTab(key)
    }}
  >
    <div className="detail-left">
    <PageHeader
      title={editingTitle ? <input ref={titleEditRef} className="title-edit-input" value={titleDraft} autoFocus onChange={(event) => setTitleEdit({ draft: event.target.value })} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter') { event.preventDefault(); void saveTitle() } }} onBlur={() => void saveTitle()} /> : <><span className="task-title-text" title={task.title}>{task.title}</span><button ref={titleEditBtnRef} className="title-edit" type="button" title="重命名" onClick={beginTitleEdit}><Pencil size={13} aria-hidden="true" /></button></>}
      metadata={<div className="detail-meta">
        <span className="meta-group meta-identity"><span className="detail-eyebrow">{parent ? '队员任务' : '工作任务'}</span>{parent && <a className="mini link" role="button" tabIndex={0} onClick={() => onSelect(parent.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(parent.id) } }}>↩ 领队任务: {parent.title}</a>}</span>
        {workers.length > 0 && <button type="button" className="worker-overview-trigger meta-chip" aria-haspopup="dialog" aria-expanded={float === 'workers'} aria-controls={float === 'workers' ? 'worker-overview' : undefined} title={`队员概览：${workerStateSummary || '全部已结束'}`} onClick={() => setFloat((current) => current === 'workers' ? null : 'workers')}><Users size={13} aria-hidden="true" /> 队员 {workers.length}<span className="worker-overview-count">{workers.length - activeWorkers.length} 已结束</span></button>}
        <IssueIdChip id={issueId} />
        <select className="meta-workflow" title="工作流" aria-label="工作流" value={issue?.status ?? 'todo'} onChange={(event) => void updateWorkflow(event.target.value as IssueStatus)}>
          {WORKFLOW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="meta-group meta-status"><span className={`status-chip status-${task.status}`}>{stateLabel}</span>{turnActive && <span className="active-duration" aria-hidden="true">工作中 · {fmtDuration(elapsed)}</span>}</span>
        <span className="meta-divider" aria-hidden="true" />
        <span className="meta-group meta-source"><span className="badge backend-chip" title={`执行后端 ${task.backend}`}>{task.backend}</span>{workdir && <button className="workspace-chip" type="button" title={workdir} onClick={() => void bridge.openPath(workdir)}><FolderOpen size={13} aria-hidden="true" /><span>{workdir.split(/[\\/]/).filter(Boolean).pop()}</span></button>}<span className="meta-chip" title={`${task.startedAt ? fmtTime(task.startedAt) : '未开始'} → ${task.endedAt ? fmtTime(task.endedAt) : turnActive ? '进行中' : '—'}`}>⏱ {elapsed > 0 ? fmtDuration(elapsed) : '—'}</span>{task.usage && <span className="meta-chip" title={`输入 ${task.usage.inputTokens.toLocaleString()} · 输出 ${task.usage.outputTokens.toLocaleString()} · 回合 ${task.usage.turns}${task.usage.costUsd > 0 ? ` · 成本 $${task.usage.costUsd.toFixed(4)}` : ''}`}>{fmtTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens{task.usage.costUsd > 0 ? ` · $${task.usage.costUsd.toFixed(4)}` : ''}</span>}{integration?.branch && <span className="meta-chip mono" title={`集成分支 ${integration.branch}`}>⎇ {integration.branch.replace('agentdeck/task-', '#')}</span>}{!!task.attempt && <span className="retry-chip" title={`自动重试 ${task.attempt}/2`}>⟳ 重试 {task.attempt}/2</span>}</span>
        <div className="meta-info-wrap" ref={infoRef}>
          <button type="button" className={`meta-chip meta-info-btn ${infoOpen ? 'open' : ''}`} title="原始指令、交接备注与详细信息" aria-expanded={infoOpen} onClick={() => setInfoOpen((value) => !value)}><Info size={12} aria-hidden="true" /></button>
          {infoOpen && <div className="meta-info-pop" ref={infoPopRef}>
            <div className="meta-info-sec"><div className="meta-info-head"><span className="meta-info-label">原始指令</span><button type="button" className="meta-info-copy" onClick={() => void copyPrompt()}>复制</button></div><pre className="meta-info-prompt">{task.prompt}</pre></div>
            {task.handoff && <div className="meta-info-sec"><span className="meta-info-label">交接备注</span><p>{task.handoff}</p></div>}
            {task.usage && <div className="meta-info-sec"><span className="meta-info-label">用量明细</span><p>输入 {task.usage.inputTokens.toLocaleString()} · 输出 {task.usage.outputTokens.toLocaleString()} · 回合 {task.usage.turns}{task.usage.costUsd > 0 ? ` · 成本 $${task.usage.costUsd.toFixed(4)}` : ''}</p></div>}
            {task.sessionId && <div className="meta-info-sec"><span className="meta-info-label">会话 ID</span><code className="meta-info-mono">{task.sessionId}</code></div>}
            {isRelay && <div className="meta-info-sec"><span className="meta-info-label"><Waypoints size={12} /> 阶段接力 · 第 {relayStage} 阶段</span>{relayPred && <p><a className="mini link" role="button" tabIndex={0} title={relayPred.title} onClick={() => onSelect(relayPred.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(relayPred.id) } }}>接力自：{relayPred.title}</a></p>}{relaySucc && <p><a className="mini link" role="button" tabIndex={0} title={relaySucc.title} onClick={() => onSelect(relaySucc.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(relaySucc.id) } }}>{relaySucc.status === 'queued' && relaySucc.parked ? '⏸ ' : '已接力 → '}{relaySucc.title.replace(/^▶ /, '')}</a></p>}{!relayPred && <p>触发：上一阶段接力（同 Issue 新会话）</p>}</div>}
            {!workdir && <div className="meta-info-sec"><span className="meta-info-label">工作目录</span><p className="dim">未绑定</p></div>}
          </div>}
        </div>
      </div>}
      actions={<>{goalActive && <button type="button" className="meta-chip float-chip is-goal" title={`${goal!.text}\n点击打开目标模式浮窗`} onClick={() => setFloat((cur) => (cur === 'goal' ? null : 'goal'))}>🎯 {goalChipSummary}</button>}{meeting && <button type="button" className="meta-chip float-chip is-meeting" title={`${meeting.topic}\n点击打开会议浮窗`} onClick={() => setFloat((cur) => (cur === 'meeting' ? null : 'meeting'))}>💬 {MEETING_STATUS_LABEL[meeting.status]}{meeting.round ? ` · 第 ${meeting.round}/${meeting.maxRounds} 轮` : ''}</button>}{task.status === 'queued' && <button className="btn primary" disabled={busy} onClick={() => void doStart()}><Play size={13} aria-hidden="true" /> 开始执行</button>}{turnActive && <button className="btn danger" disabled={busy} onClick={() => void doCancel()}><Square size={12} aria-hidden="true" /> 停止</button>}{(task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') && <><button className="btn detail-btn-emphasis" disabled={busy} onClick={() => void doRetry()}><RefreshCw size={13} aria-hidden="true" /> 重新运行</button>{task.status === 'done' && <button className="btn detail-btn-ghost" title="复制结果为 Markdown" disabled={busy || !task.result} onClick={() => void copyResult()}><Copy size={13} aria-hidden="true" /> 复制结果</button>}</>}<ActionMenu items={actionItems} label="更多操作" /></>}
    />
    {(turnActive || task.status === 'queued') && <div className={`run-rail status-${task.status}${turnActive ? ' is-live' : ''}`} role="status" aria-live="polite">
      <span className="run-rail-pulse" aria-hidden="true" />
      <strong className="run-rail-state">{stateLabel}</strong>
      {/* 每秒刷新的计时对读屏是噪音：视觉可见、不进无障碍树 */}
      <span className="run-rail-item" aria-hidden="true">{turnActive ? `已用 ${fmtDuration(elapsed)}` : isParkedQueued(task) ? '等你启动' : '等待调度'}</span>
      <span className="run-rail-sep" aria-hidden="true">·</span>
      <span className="run-rail-item">{turns.length} 回合</span>
      {lastEventAt > 0 && <><span className="run-rail-sep" aria-hidden="true">·</span><span className="run-rail-item" aria-hidden="true">最近事件 {fmtTime(lastEventAt)}</span></>}
      {activeWorkers.length > 0 && <><span className="run-rail-sep" aria-hidden="true">·</span><span className="run-rail-item is-squad" aria-hidden="true"><Users size={11} aria-hidden="true" /> 队员 {workerStateSummary}</span></>}
      <span className="run-rail-bar" aria-hidden="true"><i /></span>
    </div>}

    <div className="detail-columns"><div className="detail-main" onScroll={onLogScroll}>
      {task.status === 'failed' && task.error && <div className="error-banner"><div className="error-head"><span className="error-icon" aria-hidden="true">⚠</span><span className="error-title">{task.failure?.title ?? '执行失败'}</span>{task.failure?.code && <span className="failure-code">{task.failure.code}</span>}{task.failure?.retryable && <span className="failure-retryable">可重试</span>}<button type="button" className="error-copy" onClick={() => { void navigator.clipboard.writeText(task.error ?? ''); ui.toast.success('错误原文已复制') }}>复制错误</button></div>{task.failure?.hint && <div className="error-hint">{task.failure.hint}</div>}<details className="failure-raw"><summary>错误原文</summary><pre>{task.error}</pre></details></div>}
      {integration?.note && <div className={`integration-banner ${integration.note.includes('未完成') ? 'warn' : ''}`}>🔀 {integration.note}{integration.branch && workdir && <a className="mini link" role="button" tabIndex={0} onClick={() => void bridge.openPath(workdir)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void bridge.openPath(workdir) } }}>打开仓库</a>}</div>}
      {permission && <PermissionPrompt key={permission.requestToken ?? permission.requestId} permission={permission} busy={permissionBusy} onAnswer={(choice) => void answerPermission(choice)} />}
      {permissionError && <div className="data-state-banner" role="alert"><span>{permissionError}</span><button type="button" className="btn" onClick={() => void refreshPermissions()}><RefreshCw size={13} /> 刷新审批</button></div>}
      {permissionNotice && <div className="data-state-banner" role="status">{permissionNotice}</div>}
      <div className="tabs" role="tablist" aria-label="任务详情视图" aria-orientation="horizontal" onKeyDown={(event) => {
        // IME 组合中不抢 ←/→（候选选择）
        if (isComposingKey(event.nativeEvent)) return
        const index = enabledTabs.indexOf(tab)
        if (index < 0) return
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          selectTab(enabledTabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + enabledTabs.length) % enabledTabs.length])
          return
        }
        if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); selectTab(event.key === 'Home' ? enabledTabs[0] : enabledTabs[enabledTabs.length - 1]) }
      }}>
        {TAB_ITEMS.map((item, index) => {
          const count = tabCount(item.key)
          const secondary = item.key === 'activity' || item.key === 'result'
          return <button
            key={item.key}
            ref={(node) => { if (node) tabRefs.current.set(item.key, node); else tabRefs.current.delete(item.key) }}
            type="button"
            role="tab"
            id={`detail-tab-${item.key}`}
            aria-controls="detail-tabpanel"
            aria-label={item.label}
            aria-selected={tab === item.key}
            tabIndex={tab === item.key ? 0 : -1}
            className={`${tab === item.key ? 'active' : ''}${item.key === 'result' && task.result ? ' has-content' : ''} ${item.key === 'activity' || item.key === 'result' ? 'tab-secondary' : 'tab-primary'}`}
            title={`${item.label} · ${item.hint}（Ctrl+${index + 1}）`}
            onClick={() => setTab(item.key)}
          >
            {item.key === 'activity' ? <History size={15} aria-hidden="true" /> : item.key === 'result' ? <FileText size={15} aria-hidden="true" /> : item.label}
            {!secondary && count != null && count > 0 && <span className="tab-count">{count}</span>}
            {item.key === 'result' && task.result && <span className="tab-flag-dot" aria-hidden="true" />}
          </button>
        })}
      </div>
      <div className="detail-body" role="tabpanel" id="detail-tabpanel" aria-labelledby={`detail-tab-${tab}`}>{tab === 'activity' && <ActivityTimeline task={task} issueIdentifier={issue?.identifier} runs={runs} comments={comments} loading={issueLoading} error={issueError} onRetry={() => void refreshIssue()} onShowLog={() => setTab('log')} />}{tab === 'log' && <TurnTimeline task={task} turns={turns} activeNav={activeNav} following={following} onFollowLatest={followLatest} onNavigate={scrollToTurn} onRewind={(index) => void doRewind(index)} logRef={logRef} onScroll={onLogScroll} />}{tab === 'result' && <div className="result" tabIndex={0} aria-label="最终结果">{task.result ? <Markdown text={task.result} /> : turnActive ? <div className="list-empty">执行中，暂无最终结果</div> : <div className="list-empty">（无结果）</div>}</div>}{tab === 'git' && <GitSummary task={task} />}</div>
      {task.sessionId && task.status !== 'queued' && <footer className="followup">
        {skillMenuOpen && <SkillMenu items={menuItems} activeIndex={skillIndex} onHover={setSkillIndex} onPickCommand={openLocalCommand} onPickSkill={(skill) => { setFollowUp(`/${skill.name} `); setSkillMenuOpen(false); followRef.current?.focus() }} />}
        <div className="followup-row">
        <textarea ref={followRef} value={followUp} placeholder="追问 / 继续这个会话…（Enter 发送，Shift+Enter 换行，↑↓ 翻历史，/ 命令与技能）" rows={1} aria-label="追问内容"
          aria-describedby="followup-hint"
          /* WAI-ARIA 1.2 组合框（审查项 5）：焦点始终留在 textarea，选项只通过 aria-activedescendant 指认 */
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={skillMenuExpanded}
          aria-controls={skillMenuExpanded ? SKILL_MENU_LISTBOX_ID : undefined}
          aria-activedescendant={skillActiveOptionId}
          onChange={(event) => {
            setFollowUp(event.target.value); autoGrow(event.target)
            const startsSlash = event.target.value.startsWith('/')
            setSkillMenuOpen(startsSlash)
            if (!startsSlash) history.exitBrowse()
          }}
          onKeyDown={(event) => {
            // IME 组合中（isComposing / keyCode 229）：Enter 上屏、Esc 取消候选、↑↓ 选候选、
            // Tab 上屏——全部属于输入法，追问框与命令菜单都不抢键
            if (isComposingKey(event.nativeEvent)) return
            // 命令/技能菜单开着时先服务菜单导航
            if (skillMenuOpen && menuItems.length > 0) {
              if (event.key === 'ArrowDown') { event.preventDefault(); setSkillIndex((i) => Math.min(menuItems.length - 1, i + 1)); return }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSkillIndex((i) => Math.max(0, i - 1)); return }
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault()
                const item = menuItems[skillIndex]
                if (!item) return
                if (item.kind === 'command') openLocalCommand(item.key)
                else { setFollowUp(`/${item.skill.name} `); setSkillMenuOpen(false); followRef.current?.focus() }
                return
              }
              if (event.key === 'Escape') { event.preventDefault(); setSkillMenuOpen(false); return }
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              // 历史重写（反馈三轮2）：只有**空框**（或已在历史里浏览）时 ↑ 才翻历史——
              // 框里有内容时 ↑/↓ 就是普通光标移动，不打断正在编辑的草稿
              const element = event.currentTarget
              const atLastLine = element.selectionEnd >= followUp.length || !followUp.slice(element.selectionEnd).includes('\n')
              if (event.key === 'ArrowUp' && (history.index >= 0 || !followUp.trim())) {
                event.preventDefault()
                const text = history.navigate(-1)
                if (text != null) { setFollowUp(text); requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = text.length; autoGrow(element) }) }
              } else if (event.key === 'ArrowDown' && history.index >= 0 && atLastLine) {
                event.preventDefault()
                const text = history.navigate(1)
                if (text != null) { setFollowUp(text); requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = text.length; autoGrow(element) }) }
              }
              return
            }
            if (event.key === 'Escape' && history.index >= 0) { event.preventDefault(); setFollowUp(history.navigate(1) ?? ''); return }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendFollowUp(); setSkillMenuOpen(false) }
          }} />
        <button className="btn" disabled={busy || !!task.parentTaskId || (task.status !== 'done' && task.status !== 'failed')} title={task.parentTaskId ? '委派子任务不参与阶段接力' : '让本执行交出下一阶段简报，并在同一 Issue 上硬切新会话'} onClick={() => void sendFollowUp('执行下一阶段', { relay: true })}><Waypoints size={13} aria-hidden="true" /><span className="btn-text">接力下一阶段</span></button>
        <button className="btn primary" disabled={busy || turnActive || !followUp.trim()} onClick={() => { void sendFollowUp(); setSkillMenuOpen(false) }}>发送</button>
        </div>
        <div className="followup-hint" id="followup-hint">
          <span><b>Enter</b> 发送</span><span><b>Shift+Enter</b> 换行</span><span><b>↑↓</b> 历史</span><span><b>/</b> 命令与技能</span>
          {!!task.parentTaskId && <span className="is-warn">子任务不参与阶段接力</span>}
          {turnActive && <span className="is-warn">任务执行中，停止或完成后可发送</span>}
          {busy && <span className="is-live">正在发送…</span>}
          {skillMenuOpen && menuItems.length === 0 && <span className="is-warn">没有匹配的命令或技能</span>}
          {skillMenuOpen && menuItems.length > 0 && <span className="is-live">{menuItems.length} 项可选<ChevronDown size={11} aria-hidden="true" /></span>}
        </div>
      </footer>}
    </div>
    </div>
    </div>
    {float === 'workers' && <FloatWindow title="队员概览" icon={<Users size={14} />} width={480} onClose={() => setFloat(null)}>
      <WorkerOverview rounds={workerRounds} now={now} onOpen={(id) => { openWorker(id, tasks.find((item) => item.id === id)?.title ?? id); setFloat(null) }} />
    </FloatWindow>}
    <SideDock key={task.id} taskId={task.id} tasks={tasks} onOpen={onSelect} />
    {/* 目标/会议浮窗（队员任务不挂）：面板常驻挂载以持续上报状态，浮窗本体仅 open 时渲染。
        key={issueId}：面板数据按 Issue 归属，而面板是**异步**读数据、且 onGoal/onMeeting 每次
        渲染都换引用（它的上报 effect 因此每次都会跑）——切任务时旧面板会先把上一个 Issue 的目标/会议
        再上报一次。按 Issue 重挂面板从源头断掉这条串味：新面板从空状态起步，只上报自己 Issue 的数据。
        这里没有用户草稿可丢（追问草稿在 TaskDetail 的 per-task 槽里，TaskDetail 本身刻意不挂 key）。 */}
    {!task.parentTaskId && <>
      <GoalPanel key={`goal:${issueId}`} task={task} issueId={issueId} open={float === 'goal'} onToggle={(next) => setFloat((cur) => (next ? 'goal' : cur === 'goal' ? null : cur))} onGoal={setGoal} />
      <MeetingPanel key={`meeting:${issueId}`} issueId={issueId} open={float === 'meeting'} onToggle={(next) => setFloat((cur) => (next ? 'meeting' : cur === 'meeting' ? null : cur))} onMeeting={setMeeting} />
    </>}
  </div>
}

function relayNumber(task: Task, tasks: Task[]) {
  let count = 1
  let cursor = task.continuesFrom ? tasks.find((item) => item.id === task.continuesFrom) : undefined
  const seen = new Set([task.id])
  while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); count++; cursor = cursor.continuesFrom ? tasks.find((item) => item.id === cursor?.continuesFrom) : undefined }
  return count
}

function autoGrow(element: HTMLTextAreaElement, max = 200) {
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, max)}px`
}

/** ℹ 弹层定位常量：与边界审查同源的内缩 7px / 锚点间距 8px；宽度上限同 CSS 的 min(420px, 100vw - 64px) */
const POPOVER_EDGE = 7
const POPOVER_GAP = 8
const POPOVER_WIDTH = 420
const POPOVER_MIN_WIDTH = 180

/**
 * ℹ 弹层：按**实际详情列（.detail-left）+ 视口**测量后内联定位。
 * 样式表里的 `right: 0` 只相对 .meta-info-wrap：meta 行一换行，420px 的弹层就整个越过详情列
 * 压住侧栏导航（1440 带 Dock 与 980 两档都复现）。这里不改 CSS，只写内联 left/top/width/max-height：
 * - 横向：优先右对齐锚点（与 CSS 现状一致），列左边界放不下改左对齐，最后夹进详情列内缩后的区间；
 * - 纵向：优先锚点下方，下方放不下翻到上方，上方也放不下就压 max-height（scrollHeight 不受 max-height 限制）；
 * 弹层因此始终留在详情列与视口内；层栈顺序与焦点契约不受影响（外点/Escape 仍由交互中心代管）。
 */
function placeInfoPopover(anchor: HTMLElement, pop: HTMLElement) {
  const column = anchor.closest<HTMLElement>('.detail-left') ?? anchor.parentElement ?? anchor
  const anchorRect = anchor.getBoundingClientRect()
  const columnRect = column.getBoundingClientRect()
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight
  // 详情列内的可用区间（列宽下限 340，正常情况都够放 420px 弹层；列极窄时才收窄）
  const leftBound = Math.ceil(Math.max(columnRect.left, 0) + POPOVER_EDGE)
  const rightBound = Math.floor(Math.min(columnRect.right || viewportWidth, viewportWidth) - POPOVER_EDGE)
  const width = Math.floor(Math.min(POPOVER_WIDTH, viewportWidth - 64, Math.max(POPOVER_MIN_WIDTH, rightBound - leftBound)))
  // 先落宽度再量高度：宽度变了换行数也变，先量会拿到旧高度
  pop.style.width = `${width}px`
  const natural = pop.scrollHeight
  // 横向定位：右对齐锚点放不下就改成左对齐，仍越界则夹回区间
  const aligned = anchorRect.right - width < leftBound ? anchorRect.left : anchorRect.right - width
  const left = Math.max(Math.min(Math.round(aligned), rightBound - width), leftBound)
  // 纵向定位：下方 → 上方 → 压高度
  const below = anchorRect.bottom + POPOVER_GAP
  const roomBelow = viewportHeight - POPOVER_EDGE - below
  const roomAbove = anchorRect.top - POPOVER_GAP - POPOVER_EDGE
  let top = below
  let maxHeight = ''
  if (natural > roomBelow) {
    if (natural <= roomAbove) top = anchorRect.top - POPOVER_GAP - natural
    else if (roomAbove > roomBelow) { top = POPOVER_EDGE; maxHeight = `${Math.floor(roomAbove)}px` }
    else maxHeight = `${Math.floor(Math.max(roomBelow, 120))}px`
  }
  // 兜底：锚点被滚出视口等极端情形下也把弹层压在视口内（高度已由 maxHeight 限定）
  const height = Math.min(natural, maxHeight ? parseFloat(maxHeight) : natural)
  top = Math.min(Math.max(top, POPOVER_EDGE), Math.max(POPOVER_EDGE, viewportHeight - POPOVER_EDGE - height))
  // 内联 left/top 是包含块（offsetParent 内边距盒）坐标，不是视口坐标；jsdom/无定位祖先时退化为列坐标
  const box = pop.offsetParent as HTMLElement | null
  const boxRect = box?.getBoundingClientRect() ?? columnRect
  const boxStyle = box ? getComputedStyle(box) : null
  const originLeft = boxRect.left + (parseFloat(boxStyle?.borderLeftWidth ?? '') || 0)
  const originTop = boxRect.top + (parseFloat(boxStyle?.borderTopWidth ?? '') || 0)
  pop.style.maxHeight = maxHeight
  pop.style.right = 'auto'
  pop.style.left = `${Math.round(left - originLeft)}px`
  pop.style.top = `${Math.round(top - originTop)}px`
}

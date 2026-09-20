import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Info, Pencil, Waypoints } from 'lucide-react'
import { bridge, fmtDuration, fmtTokens } from '../api'
import { taskService } from '../task-service'
import { GOAL_STATUS_LABELS, isParkedQueued, PARKED_QUEUED_LABEL } from '../labels'
import { Markdown } from './Markdown'
import { ui } from '../ui/interaction-center'
import { IssueIdChip } from '../ui/IssueIdChip'
import { useTaskEvents } from '../hooks/useTaskEvents'
import { useTurnModel } from '../hooks/turnModel'
import { useIssueDetails } from '../hooks/useIssueDetails'
import { PermissionPrompt } from './task/PermissionPrompt'
import { TurnTimeline } from './task/TurnTimeline'
import { SkillMenu, buildMenuItems, parseSkillDirective, wrapSkillDirective, type LocalCommandKey } from './task/SkillMenu'
import { usePromptHistory } from '../hooks/usePromptHistory'
import { SideDock } from '../ui/SideDock'
import { useInteractionLayer } from '../hooks/useInteractionLayer'
import { ActivityTimeline } from './task/ActivityTimeline'
import { GitSummary } from './task/GitSummary'
import { GoalPanel } from './goal/GoalPanel'
import { MeetingPanel } from './meeting/MeetingPanel'
import { MEETING_STATUS_LABEL } from './meeting/MeetingCard'
import type { Goal, IssueStatus, Task } from '../../../shared/types'
import type { Meeting } from '../../../shared/meeting'
import type { SkillMeta } from '../../../shared/skills'

type Tab = 'activity' | 'log' | 'result' | 'git'
const STATUS_META: Record<Task['status'], string> = { queued: '排队中', running: '执行中', done: '完成', failed: '失败', cancelled: '已取消' }
const WORKFLOW_OPTIONS: Array<{ value: IssueStatus; label: string }> = [
  { value: 'backlog', label: '待梳理' }, { value: 'todo', label: '待办' }, { value: 'in_progress', label: '进行中' },
  { value: 'in_review', label: '审查中' }, { value: 'done', label: '已完成' }, { value: 'blocked', label: '受阻' },
  { value: 'cancelled', label: '已取消' }
]

export function TaskDetail({ task, tasks, onSelect }: { task: Task; tasks: Task[]; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('activity')
  const [followUp, setFollowUp] = useState('')
  const [busy, setBusy] = useState(false)
  const [, setClock] = useState(0)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [activeNav, setActiveNav] = useState(-1)
  const [infoOpen, setInfoOpen] = useState(false)
  // 目标/会议浮窗：同一时刻至多开一个；goal/meeting 数据由面板上报（驱动 header 状态芯片）
  const [float, setFloat] = useState<'goal' | 'meeting' | null>(null)
  const [goal, setGoal] = useState<Goal | null>(null)
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const followRef = useRef<HTMLTextAreaElement>(null)
  const infoRef = useRef<HTMLDivElement>(null)
  const editingTitleRef = useRef(false)
  const navFrameRef = useRef(0)
  const { events, permission, refreshEvents, answerPermission } = useTaskEvents(task.id)
  const turns = useTurnModel(events, task.prompt)
  // 追问框：↑↓ 历史重写 + / 命令菜单（本地命令 + 技能；技能列表首按 / 时懒加载一次）
  const history = usePromptHistory(task.id)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const skillsLoadedRef = useRef(false)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [skillIndex, setSkillIndex] = useState(0)
  const isZcode = task.backend === 'zcode'
  const skillQuery = followUp.startsWith('/') ? followUp.slice(1).split(/\s/)[0] ?? '' : ''
  const menuItems = useMemo(() => buildMenuItems(skills, skillQuery, isZcode), [skills, skillQuery, isZcode])
  useEffect(() => { setSkillIndex(0) }, [skillQuery])
  // 首次打开菜单才拉技能清单；此后复用（安装/卸载技能后重开 Issue 即刷新）
  useEffect(() => {
    if (!skillMenuOpen || skillsLoadedRef.current) return
    skillsLoadedRef.current = true
    void bridge.skills.list().then((result) => setSkills(result.skills)).catch(() => { skillsLoadedRef.current = false })
  }, [skillMenuOpen])
  const issueId = task.issueId ?? `iss_${task.id}`
  const { issue, comments, runs, updateWorkflow } = useIssueDetails(issueId, `${task.status}:${task.result ?? ''}:${task.eventCount}`)
  const workers = tasks.filter((item) => item.parentTaskId === task.id).sort((a, b) => (a.workerIndex ?? 0) - (b.workerIndex ?? 0))
  const activeWorkers = workers.filter((item) => item.status === 'running' || item.status === 'queued')
  const parent = task.parentTaskId ? tasks.find((item) => item.id === task.parentTaskId) : null
  const relayPred = task.continuesFrom ? tasks.find((item) => item.id === task.continuesFrom) : null
  const relaySucc = tasks.find((item) => item.continuesFrom === task.id)
  const relayStage = relayNumber(task, tasks)
  const isRelay = task.trigger === 'handoff' || !!relayPred || !!relaySucc
  const turnActive = task.status === 'running'
  const goalActive = !!goal && !['completed', 'cancelled'].includes(goal.status)
  const goalChipSummary = goal ? `${goal.runCount}/${goal.maxRuns} 轮 · ${GOAL_STATUS_LABELS[goal.status]}${goal.currentRunId ? ' · 执行中' : ''}` : ''

  useEffect(() => {
    if (!turnActive) return
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [task.id, turnActive])

  // ℹ 弹层：统一浮层（外点收起 + 最上层 Escape），原 window mousedown 监听已收敛
  useInteractionLayer<HTMLDivElement>({ open: infoOpen, onClose: () => setInfoOpen(false), kind: 'popover', name: 'task-info', closeOnOutside: true, autoFocus: false, layerRef: infoRef })

  const scrollEl = () => {
    const element = logRef.current
    if (!element) return null
    return element.scrollHeight > element.clientHeight + 1 ? element : element.closest<HTMLElement>('.detail-main') ?? element
  }
  const updateActiveNav = () => {
    const element = scrollEl()
    if (!element) return
    const nodes = element.querySelectorAll<HTMLElement>('.turn')
    if (!nodes.length) { setActiveNav(0); return }
    // 滚到底（含新消息后自动跟随最新内容）时，当前回合就是最新回合——
    // 否则短的新回合在视口下半部永远够不着顶部门线，高亮会卡在上一条
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 40) {
      setActiveNav(nodes.length - 1)
      return
    }
    const top = element.getBoundingClientRect().top
    let active = 0
    nodes.forEach((node, index) => { if (node.getBoundingClientRect().top - top <= 80) active = index })
    setActiveNav(active)
  }
  const onLogScroll = () => {
    if (navFrameRef.current) return
    navFrameRef.current = requestAnimationFrame(() => { navFrameRef.current = 0; updateActiveNav() })
  }
  useEffect(() => {
    if (tab !== 'log') return
    const element = scrollEl()
    if (element) element.scrollTop = element.scrollHeight
    updateActiveNav()
  }, [events, tab, turns.length])
  const scrollToTurn = (index: number) => {
    const element = scrollEl()
    const target = element?.querySelector<HTMLElement>(`#turn-${index}`)
    if (!element || !target) return
    const delta = target.getBoundingClientRect().top - element.getBoundingClientRect().top
    element.scrollTo({ top: Math.max(0, element.scrollTop + delta - 8), behavior: 'smooth' })
    setActiveNav(index)
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
  const beginTitleEdit = () => { setTitleDraft(task.title); editingTitleRef.current = true; setEditingTitle(true) }
  const cancelTitleEdit = () => { editingTitleRef.current = false; setEditingTitle(false) }
  const saveTitle = async () => {
    if (!editingTitleRef.current) return
    editingTitleRef.current = false
    setEditingTitle(false)
    const title = titleDraft.trim()
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
    if (!raw || busy) return
    // 输入的 /goal /meeting 不下发：转成本地浮窗/创建流程
    const local = /^\/(goal|meeting)\b/.exec(raw)
    if (local) { openLocalCommand(local[1] as LocalCommandKey); return }
    // zcode 会话支持 Skill 工具：/技能名 开头的输入包装成显式技能指令再下发
    const directive = isZcode ? parseSkillDirective(raw, skills) : null
    const content = directive ? wrapSkillDirective(directive.skill, directive.rest) : raw
    setBusy(true); setFollowUp('')
    history.push(raw)
    if (followRef.current) followRef.current.style.height = 'auto'
    try {
      // wait:false：IPC 在回合开跑即返回，busy 不锁整轮追问——否则「停止」会禁用到回合结束
      const result = await taskService.followUp(task.id, content, { ...opts, wait: false })
      if (!result.ok) ui.toast.error(result.error ?? '续聊失败')
    } finally {
      setBusy(false)
    }
  }
  const copyResult = async () => {
    const parts = [`# ${task.title}`, '', task.result ?? '']
    if (task.gitStat) parts.push('', '## 改动', '```', task.gitStat, '```')
    if (task.integration?.branch) parts.push('', `集成分支：\`${task.integration.branch}\``)
    await navigator.clipboard.writeText(parts.join('\n')); ui.toast.success('结果已复制为 Markdown')
  }
  const copyPrBody = async () => {
    const branch = task.integration?.branch
    const files = (task.gitStat || '').split('\n').filter((line) => line.includes('|')).length
    const body = ['## 摘要', '', (task.result ?? '').slice(0, 2000), '', '## 改动', '', files ? `${files} 个文件有改动。` : '见提交记录。', branch ? `\n> 由 AgentDeck 队员在隔离分支 \`${branch}\` 上完成。` : ''].join('\n')
    await navigator.clipboard.writeText(`**${task.title}**\n\n${body}`); ui.toast.success('PR 描述已复制（标题 + 摘要 + 改动）')
  }
  const duration = task.startedAt ? (task.endedAt ?? Date.now()) - task.startedAt : 0

  return <div className="detail">
    <div className="detail-left">
    <header className="detail-header page-header-bar"><div className="detail-title-wrap">
      {editingTitle ? <input className="title-edit-input" value={titleDraft} autoFocus onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTitle() } else if (event.key === 'Escape') cancelTitleEdit() }} onBlur={() => void saveTitle()} /> : <h1 className="detail-title">{task.title}<button className="title-edit" type="button" title="重命名" onClick={beginTitleEdit}><Pencil size={13} aria-hidden="true" /></button></h1>}
      <div className="detail-meta">
        <span className="meta-group meta-identity"><span className="detail-eyebrow">{parent ? '队员任务' : '工作任务'}</span>{parent && <a className="mini link" role="button" tabIndex={0} onClick={() => onSelect(parent.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(parent.id) } }}>↩ 领队任务: {parent.title}</a>}{workers.length > 0 && <button type="button" className="badge badge-squad link-badge" title="在右侧分页打开子任务" onClick={() => { const target = workers.find((item) => item.status === 'running') ?? workers[0]; if (target) ui.dock.open({ id: `task:${target.id}`, kind: 'task', title: target.title, payload: { taskId: target.id } }) }}>⚡ 子任务 {workers.filter((worker) => worker.status === 'done').length}/{workers.length}</button>}</span>
        <IssueIdChip id={issueId} />
        <select className="meta-workflow" title="工作流" aria-label="工作流" value={issue?.status ?? 'todo'} onChange={(event) => void updateWorkflow(event.target.value as IssueStatus)}>
          {WORKFLOW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="meta-group meta-status"><span className={`status-chip status-${task.status}`}>{isParkedQueued(task) ? PARKED_QUEUED_LABEL : STATUS_META[task.status]}</span>{turnActive && <span className="active-duration" aria-live="polite">工作中 · {fmtDuration(Date.now() - (task.startedAt ?? Date.now()))}</span>}</span>
        <span className="meta-divider" aria-hidden="true" />
        <span className="meta-group meta-source"><span className="badge backend-chip" title={`执行后端 ${task.backend}`}>{task.backend}</span>{task.workdir && <button className="workspace-chip" type="button" title={task.workdir} onClick={() => void bridge.openPath(task.workdir)}><FolderOpen size={13} aria-hidden="true" /><span>{task.workdir.split(/[\\/]/).filter(Boolean).pop()}</span></button>}<span className="meta-chip" title="总用时">⏱ {duration > 0 ? fmtDuration(duration) : '—'}</span>{task.usage && <span className="meta-chip" title={`输入 ${task.usage.inputTokens.toLocaleString()} · 输出 ${task.usage.outputTokens.toLocaleString()} · 回合 ${task.usage.turns}${task.usage.costUsd > 0 ? ` · 成本 $${task.usage.costUsd.toFixed(4)}` : ''}`}>{fmtTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens{task.usage.costUsd > 0 ? ` · $${task.usage.costUsd.toFixed(4)}` : ''}</span>}{task.integration?.branch && <span className="meta-chip mono" title={`集成分支 ${task.integration.branch}`}>⎇ {task.integration.branch.replace('agentdeck/task-', '#')}</span>}{!!task.attempt && <span className="retry-chip" title={`自动重试 ${task.attempt}/2`}>⟳ 重试 {task.attempt}/2</span>}</span>
        <div className="meta-info-wrap" ref={infoRef}>
          <button type="button" className={`meta-chip meta-info-btn ${infoOpen ? 'open' : ''}`} title="原始指令、交接备注与详细信息" aria-expanded={infoOpen} onClick={() => setInfoOpen((value) => !value)}><Info size={12} aria-hidden="true" /></button>
          {infoOpen && <div className="meta-info-pop">
            <div className="meta-info-sec"><span className="meta-info-label">原始指令</span><pre className="meta-info-prompt">{task.prompt}</pre></div>
            {task.handoff && <div className="meta-info-sec"><span className="meta-info-label">交接备注</span><p>{task.handoff}</p></div>}
            {task.usage && <div className="meta-info-sec"><span className="meta-info-label">用量明细</span><p>输入 {task.usage.inputTokens.toLocaleString()} · 输出 {task.usage.outputTokens.toLocaleString()} · 回合 {task.usage.turns}{task.usage.costUsd > 0 ? ` · 成本 $${task.usage.costUsd.toFixed(4)}` : ''}</p></div>}
            {task.sessionId && <div className="meta-info-sec"><span className="meta-info-label">会话 ID</span><code className="meta-info-mono">{task.sessionId}</code></div>}
            {isRelay && <div className="meta-info-sec"><span className="meta-info-label"><Waypoints size={12} /> 阶段接力 · 第 {relayStage} 阶段</span>{relayPred && <p><a className="mini link" role="button" tabIndex={0} title={relayPred.title} onClick={() => onSelect(relayPred.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(relayPred.id) } }}>接力自：{relayPred.title}</a></p>}{relaySucc && <p><a className="mini link" role="button" tabIndex={0} title={relaySucc.title} onClick={() => onSelect(relaySucc.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(relaySucc.id) } }}>{relaySucc.status === 'queued' && relaySucc.parked ? '⏸ ' : '已接力 → '}{relaySucc.title.replace(/^▶ /, '')}</a></p>}{!relayPred && <p>触发：上一阶段接力（同 Issue 新会话）</p>}</div>}
            {!task.workdir && <div className="meta-info-sec"><span className="meta-info-label">工作目录</span><p className="dim">未绑定</p></div>}
          </div>}
        </div>
      </div>
    </div><div className="detail-actions">{goalActive && <button type="button" className="meta-chip float-chip is-goal" title={`${goal!.text}\n点击打开目标模式浮窗`} onClick={() => setFloat((cur) => (cur === 'goal' ? null : 'goal'))}>🎯 {goalChipSummary}</button>}{meeting && <button type="button" className="meta-chip float-chip is-meeting" title={`${meeting.topic}\n点击打开会议浮窗`} onClick={() => setFloat((cur) => (cur === 'meeting' ? null : 'meeting'))}>💬 {MEETING_STATUS_LABEL[meeting.status]}{meeting.round ? ` · 第 ${meeting.round}/${meeting.maxRounds} 轮` : ''}</button>}{task.status === 'queued' && <button className="btn primary" disabled={busy} onClick={() => void doStart()}>▶ 开始执行</button>}{task.status === 'done' && <><button className="btn detail-btn-ghost" title="复制结果为 Markdown" disabled={busy || !task.result} onClick={() => void copyResult()}>复制结果</button><button className="btn detail-btn-ghost" title="复制 PR 描述（标题+摘要+改动）" disabled={busy || !task.result} onClick={() => void copyPrBody()}>复制 PR 描述</button></>}{turnActive && <button className="btn danger" disabled={busy} onClick={() => void doCancel()}>停止</button>}{(task.status === 'failed' || task.status === 'cancelled' || task.status === 'done') && <><button className="btn detail-btn-emphasis" disabled={busy} onClick={() => void doRetry()}>重新运行</button><button className="btn detail-btn-ghost" disabled={busy} onClick={() => void doDuplicate()}>复制</button></>}{task.status !== 'running' && task.status !== 'queued' && <button className="btn detail-btn-ghost-danger" onClick={() => void doDelete()}>删除</button>}</div></header>

    <div className="detail-columns"><div className="detail-main" onScroll={onLogScroll}>
      {task.status === 'failed' && task.error && <div className="error-banner"><div className="error-head"><span className="error-icon" aria-hidden="true">⚠</span><span className="error-title">{task.failure?.title ?? '执行失败'}</span>{task.failure?.code && <span className="failure-code">{task.failure.code}</span>}{task.failure?.retryable && <span className="failure-retryable">可重试</span>}</div>{task.failure?.hint && <div className="error-hint">{task.failure.hint}</div>}<details className="failure-raw"><summary>错误原文</summary><pre>{task.error}</pre></details></div>}
      {task.integration?.note && <div className={`integration-banner ${task.integration.note.includes('未完成') ? 'warn' : ''}`}>🔀 {task.integration.note}{task.integration.branch && task.workdir && <a className="mini link" role="button" tabIndex={0} onClick={() => void bridge.openPath(task.workdir)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void bridge.openPath(task.workdir) } }}>打开仓库</a>}</div>}
      {activeWorkers.length > 0 && <div className="workers-pane"><div className="list-group-label">运行中的队员（{activeWorkers.length}）</div>{activeWorkers.map((worker) => <div key={worker.id} className={`worker-card ${worker.status === 'cancelled' ? 'is-cancelled' : ''}`} role="button" tabIndex={0} onClick={() => ui.dock.open({ id: `task:${worker.id}`, kind: 'task', title: worker.title, payload: { taskId: worker.id } })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ui.dock.open({ id: `task:${worker.id}`, kind: 'task', title: worker.title, payload: { taskId: worker.id } }) } }}><span className={`dot dot-${worker.status}`} /><span className="worker-title">{worker.title}</span><span className="mini">{worker.status === 'running' ? '执行中…' : worker.status === 'queued' ? (worker.parked ? PARKED_QUEUED_LABEL : '排队') : worker.status === 'cancelled' ? '已取消' : worker.status === 'failed' ? '✗ 失败' : worker.startedAt && worker.endedAt ? `✓ ${fmtDuration(worker.endedAt - worker.startedAt)}` : '✓'}</span>{worker.gitStat ? <span className="mini dim">· 有改动</span> : null}</div>)}</div>}
      {permission && <PermissionPrompt permission={permission} onAnswer={(decision) => void answerPermission(decision)} />}
      <div className="tabs"><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>动态</button><button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>执行记录</button><button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>结果</button><button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')} disabled={!task.gitDiff && !task.gitStat}>Git 改动</button></div>
      <div className="detail-body">{tab === 'activity' && <ActivityTimeline task={task} issueIdentifier={issue?.identifier} runs={runs} comments={comments} onShowLog={() => setTab('log')} />}{tab === 'log' && <TurnTimeline task={task} turns={turns} activeNav={activeNav} onNavigate={scrollToTurn} onRewind={(index) => void doRewind(index)} logRef={logRef} onScroll={onLogScroll} />}{tab === 'result' && <div className="result">{task.result ? <Markdown text={task.result} /> : turnActive ? <div className="list-empty">执行中，暂无最终结果</div> : <div className="list-empty">（无结果）</div>}</div>}{tab === 'git' && <GitSummary task={task} />}</div>
      {task.sessionId && task.status !== 'queued' && <footer className="followup">
        {skillMenuOpen && <SkillMenu items={menuItems} activeIndex={skillIndex} onHover={setSkillIndex} onPickCommand={openLocalCommand} onPickSkill={(skill) => { setFollowUp(`/${skill.name} `); setSkillMenuOpen(false); followRef.current?.focus() }} />}
        <textarea ref={followRef} value={followUp} placeholder="追问 / 继续这个会话…（Enter 发送，Shift+Enter 换行，↑↓ 翻历史，/ 命令与技能）" rows={1}
          onChange={(event) => {
            setFollowUp(event.target.value); autoGrow(event.target)
            const startsSlash = event.target.value.startsWith('/')
            setSkillMenuOpen(startsSlash)
            if (!startsSlash) history.exitBrowse()
          }}
          onKeyDown={(event) => {
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
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendFollowUp(); setSkillMenuOpen(false) }
          }} />
        <button className="btn" disabled={busy || !!task.parentTaskId || (task.status !== 'done' && task.status !== 'failed')} title={task.parentTaskId ? '委派子任务不参与阶段接力' : '让本执行交出下一阶段简报，并在同一 Issue 上硬切新会话'} onClick={() => void sendFollowUp('执行下一阶段', { relay: true })}>⇥ 接力下一阶段</button><button className="btn primary" disabled={busy || !followUp.trim()} onClick={() => { void sendFollowUp(); setSkillMenuOpen(false) }}>发送</button>
      </footer>}
    </div>
    </div>
    </div>
    <SideDock key={task.id} taskId={task.id} tasks={tasks} onOpen={onSelect} />
    {/* 目标/会议浮窗（队员任务不挂）：面板常驻挂载以持续上报状态，浮窗本体仅 open 时渲染 */}
    {!task.parentTaskId && <>
      <GoalPanel task={task} issueId={issueId} open={float === 'goal'} onToggle={(next) => setFloat((cur) => (next ? 'goal' : cur === 'goal' ? null : cur))} onGoal={setGoal} />
      <MeetingPanel issueId={issueId} open={float === 'meeting'} onToggle={(next) => setFloat((cur) => (next ? 'meeting' : cur === 'meeting' ? null : cur))} onMeeting={setMeeting} />
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

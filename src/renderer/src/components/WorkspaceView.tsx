import { useEffect, useRef, useState } from 'react'
import { bridge, type AgentInfo } from '../api'
import { toast } from '../ui/Toasts'
import type { Task } from '../../../shared/types'
import { ArrowUpRight, Clock3, FolderOpen, Sparkles } from 'lucide-react'

// 草稿存模块级：切去任务详情再回来不丢输入（会话内存活）
const draft = {
  prompt: '',
  workdir: '',
  agentId: '',
  handoff: ''
}

/** Ctrl+N 聚焦工作区输入框用的事件名 */
export const FOCUS_WORKSPACE = 'agentdeck:focus-workspace'

/** 从首条消息自动起标题：取首行、剥掉 markdown 记号、压缩空白，截 72 字 */
function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
  const cleaned = firstLine.replace(/^#{1,6}\s*/, '').replace(/[*`~_>]+/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || firstLine.trim()).slice(0, 72)
}

// 快捷示例：点击填入输入框（不直接发送）
const SUGGESTIONS = [
  '审查当前仓库的代码结构，给出重构建议',
  '给这个项目补一份 README',
  '找出现有的潜在 bug 并修复'
]

export function WorkspaceView({ onCreated, workspaceDir, onPickWorkspace }: { onCreated: (t: Task) => void; workspaceDir: string; onPickWorkspace: () => void }) {
  const [prompt, setPrompt] = useState(draft.prompt)
  const [workdir, setWorkdir] = useState(workspaceDir || draft.workdir)
  const [agentId, setAgentId] = useState(draft.agentId)
  const [handoff, setHandoff] = useState(draft.handoff)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [busy, setBusy] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bridge.agents.list().then((list) => {
      setAgents(list)
      if (list.length && !draft.agentId) {
        draft.agentId = list[0].id
        setAgentId(list[0].id)
      }
    })
  }, [])

  useEffect(() => {
    const focus = () => promptRef.current?.focus()
    window.addEventListener(FOCUS_WORKSPACE, focus)
    focus()
    return () => window.removeEventListener(FOCUS_WORKSPACE, focus)
  }, [])

  // 草稿回写（保持模块级副本最新）
  useEffect(() => { draft.prompt = prompt }, [prompt])
  useEffect(() => { draft.workdir = workdir }, [workdir])
  useEffect(() => { if (workspaceDir && workspaceDir !== workdir) setWorkdir(workspaceDir) }, [workspaceDir])
  useEffect(() => { draft.agentId = agentId }, [agentId])
  useEffect(() => { draft.handoff = handoff }, [handoff])

  const pick = async () => {
    const dir = await bridge.pickDir()
    if (dir) setWorkdir(dir)
  }

  const submit = async (startNow = true) => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    try {
      const issue = await bridge.issues.create({
        title: deriveTitle(prompt),
        titleAuto: true,
        description: prompt.trim(),
        workdir,
        agentId,
        handoff: handoff.trim() || undefined,
        startNow,
        trigger: 'assignment'
      })
      const t = await bridge.tasks.get(issue.taskId)
      if (!t) throw new Error('Issue 创建成功，但执行记录尚未可用')
      draft.prompt = ''
      setPrompt('')
      draft.handoff = ''
      setHandoff('')
      setHandoffOpen(false)
      if (promptRef.current) promptRef.current.style.height = 'auto'
      if (!startNow) toast.info('已创建，暂不启动——在任务详情点「开始执行」')
      onCreated(t)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 回车发送；Shift+Enter 换行；中文输入法组词的 Enter 不算（isComposing）
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const canSubmit = !!prompt.trim() && !busy
  const selectedAgent = agents.find((a) => a.id === agentId)
  const isLeader = !!selectedAgent?.subordinates?.length && selectedAgent.backend !== 'dsh'
  const greeting = new Date().getHours() < 12 ? '早上好，开始一个新任务' : new Date().getHours() < 18 ? '下午好，继续推进工作' : '晚上好，收尾一个任务'

  return (
    <div className="workspace">
      <div className="workspace-card">
        <div className="workspace-greeting">{greeting}</div>
        <div className="workspace-title">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={15} /></span>
          <span>开始一个任务</span>
        </div>
        <p className="hint workspace-lead">描述目标、约束和验收标准，AgentDeck 会把执行过程集中到一个工作区。</p>
        <div className="suggest-row">
          {SUGGESTIONS.map((sg) => (
            <button key={sg} className="suggest-chip" onClick={() => { setPrompt(sg); promptRef.current?.focus() }}>
              {sg}
            </button>
          ))}
        </div>
        {agents.length > 0 ? (
          <div className="field">
            <span>执行 Agent{isLeader ? '（领队可按需拆分任务）' : ''}</span>
            <div className="agent-picker">
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`agent-pick ${a.id === agentId ? 'active' : ''}`}
                  onClick={() => setAgentId(a.id)}
                  title={`${a.role ? a.role + ' · ' : ''}${a.model ? a.model + ' · ' : ''}${a.note || a.backend}`}
                >
                  <span className="agent-avatar sm" style={{ background: a.color }}>
                    {a.name.slice(0, 1)}
                  </span>
                  {a.name}
                  <span className="badge">{a.backend}</span>
                  {a.model ? <span className="badge">{a.model}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="hint hint">未配置 Agent，默认用 zcode 执行；可在左侧「Agent」页添加。</p>
        )}
        <div className="composer-label">描述目标、约束和验收标准</div>
        <textarea
          ref={promptRef}
          className="workspace-prompt"
          value={prompt}
          rows={3}
          placeholder={'要 agent 做什么…\n领队队员会自行判断要不要拆分并派给其他队员'}
          onChange={(e) => {
            setPrompt(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
          }}
          onKeyDown={onKeyDown}
        />
        <div className="workspace-context">
          <div><span className="context-label">当前工作区</span><strong title={workdir}>{workdir ? workdir.split(/[\\/]/).pop() : '尚未选择'}</strong></div>
          <button className="btn" onClick={onPickWorkspace} title="选择工作区"><FolderOpen size={14} aria-hidden="true" /> 更换</button>
        </div>
        <div className="workspace-row">
          <button
            className="btn"
            disabled={!canSubmit}
            title="创建但不启动；之后在任务详情点「开始执行」"
            onClick={() => void submit(false)}
          >
            <Clock3 size={14} aria-hidden="true" /> 稍后
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => void submit(true)}>
            {busy ? '创建中…' : <><ArrowUpRight size={14} aria-hidden="true" /> 开始执行</>}
          </button>
        </div>
        {selectedAgent && (
          <p className="trigger-preview" title="触发预览">
            ⚡ 将唤醒：<b>{selectedAgent.name}</b>（{selectedAgent.role || selectedAgent.backend}
            {isLeader ? ` · 领队，可自行派工给 ${selectedAgent.subordinates?.length} 名队员` : ''}
            {handoff.trim() ? ' · 含交接备注' : ''}）
          </p>
        )}
        <div className="handoff-zone">
          <button className="link handoff-toggle" onClick={() => setHandoffOpen((o) => !o)}>
            {handoffOpen ? '▾' : '▸'} 交接备注{handoff.trim() ? '（已填写）' : '（可选）'}
          </button>
          {handoffOpen && (
            <textarea
              className="handoff-input"
              value={handoff}
              rows={2}
              placeholder="本次执行的范围、顺序或重点（只对这一轮生效）…"
              onChange={(e) => setHandoff(e.target.value)}
            />
          )}
        </div>
        <p className="hint workspace-hint">
          Enter 发送 · Shift+Enter 换行 · 权限模式跟随设置
        </p>
      </div>
    </div>
  )
}

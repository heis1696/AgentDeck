import { useEffect, useRef, useState } from 'react'
import { bridge } from '../api'
import type { Task } from '../../../shared/types'

interface Agent {
  id: string
  name: string
  backend: string
  note?: string
  color: string
}

// 草稿存模块级：切去任务详情再回来不丢输入（会话内存活）
const draft = {
  prompt: '',
  workdir: '',
  mode: 'single' as 'single' | 'squad',
  maxWorkers: 3,
  agentId: ''
}

/** Ctrl+N 聚焦工作区输入框用的事件名 */
export const FOCUS_WORKSPACE = 'agentdeck:focus-workspace'

export function WorkspaceView({ onCreated }: { onCreated: (t: Task) => void }) {
  const [prompt, setPrompt] = useState(draft.prompt)
  const [workdir, setWorkdir] = useState(draft.workdir)
  const [mode, setMode] = useState<'single' | 'squad'>(draft.mode)
  const [maxWorkers, setMaxWorkers] = useState(draft.maxWorkers)
  const [agentId, setAgentId] = useState(draft.agentId)
  const [agents, setAgents] = useState<Agent[]>([])
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
  useEffect(() => { draft.mode = mode }, [mode])
  useEffect(() => { draft.maxWorkers = maxWorkers }, [maxWorkers])
  useEffect(() => { draft.agentId = agentId }, [agentId])

  const pick = async () => {
    const dir = await bridge.pickDir()
    if (dir) setWorkdir(dir)
  }

  const submit = async () => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    try {
      const t = await bridge.tasks.create({
        title: prompt.trim().slice(0, 24),
        prompt: prompt.trim(),
        workdir,
        agentId,
        mode,
        ...(mode === 'squad' ? { maxWorkers } : {})
      } as any)
      draft.prompt = ''
      setPrompt('')
      if (promptRef.current) promptRef.current.style.height = 'auto'
      onCreated(t)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
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

  const canSubmit = !!prompt.trim() && !busy && !(mode === 'squad' && !workdir.trim())
  const selectedAgent = agents.find((a) => a.id === agentId)

  return (
    <div className="workspace">
      <div className="workspace-card">
        <div className="workspace-title">
          <span className="brand-mark">⚓</span> 要做点什么？
        </div>
        <div className="mode-switch">
          <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
            单任务
          </button>
          <button className={mode === 'squad' ? 'active' : ''} onClick={() => setMode('squad')}>
            ⚡ 多 agent 协同
          </button>
        </div>
        {mode === 'squad' && (
          <p className="hint squad-hint">
            领队把大任务拆成子任务 → 多个 agent 并行执行（git 仓库自动 worktree 隔离）→ 领队汇总 → 改动合入集成分支，不动你的当前分支。
          </p>
        )}
        {agents.length > 0 ? (
          <div className="field">
            <span>{mode === 'squad' ? '领队（负责拆解和汇总）' : '执行队员'}</span>
            <div className="agent-picker">
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`agent-pick ${a.id === agentId ? 'active' : ''}`}
                  onClick={() => setAgentId(a.id)}
                  title={a.note || a.backend}
                >
                  <span className="agent-avatar sm" style={{ background: a.color }}>
                    {a.name.slice(0, 1)}
                  </span>
                  {a.name}
                  <span className="badge">{a.backend}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="hint squad-hint">未配置队员，默认用 zcode 执行；可在「队伍」页添加。</p>
        )}
        <textarea
          ref={promptRef}
          className="workspace-prompt"
          value={prompt}
          rows={3}
          placeholder={
            mode === 'squad'
              ? '要团队完成什么…\n例如：给这个项目加上用户登录：后端 API、前端页面、单测各一个子任务'
              : '要 agent 做什么…\n例如：修复 src/auth.ts 里的登录超时 bug，并补一个单测'
          }
          onChange={(e) => {
            setPrompt(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
          }}
          onKeyDown={onKeyDown}
        />
        <div className="workspace-row">
          <input
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder={`工作目录（${mode === 'squad' ? '协同必选，须为 git 仓库' : '可选，建议选 git 仓库'}）`}
          />
          <button className="btn" onClick={pick}>
            浏览…
          </button>
          {mode === 'squad' && (
            <label className="workers-label mini">
              并行 {maxWorkers}
              <input
                type="range"
                min={2}
                max={6}
                value={maxWorkers}
                onChange={(e) => setMaxWorkers(Number(e.target.value))}
              />
            </label>
          )}
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? '创建中…' : mode === 'squad' ? '创建并派队' : '开始执行'}
          </button>
        </div>
        <p className="hint workspace-hint">
          Enter 发送 · Shift+Enter 换行 · {selectedAgent ? `队员：${selectedAgent.name} (${selectedAgent.backend})` : '队员：默认 zcode'} · 权限模式跟随设置
        </p>
      </div>
    </div>
  )
}

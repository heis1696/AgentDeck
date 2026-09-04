import { useEffect, useRef, useState } from 'react'
import { bridge, type AgentInfo } from '../api'
import { toast } from '../ui/Toasts'
import type { Task } from '../../../shared/types'

// 草稿存模块级：切去任务详情再回来不丢输入（会话内存活）
const draft = {
  prompt: '',
  workdir: '',
  agentId: ''
}

/** Ctrl+N 聚焦工作区输入框用的事件名 */
export const FOCUS_WORKSPACE = 'agentdeck:focus-workspace'

// 快捷示例：点击填入输入框（不直接发送）
const SUGGESTIONS = [
  '审查当前仓库的代码结构，给出重构建议',
  '给这个项目补一份 README',
  '找出现有的潜在 bug 并修复'
]

export function WorkspaceView({ onCreated }: { onCreated: (t: Task) => void }) {
  const [prompt, setPrompt] = useState(draft.prompt)
  const [workdir, setWorkdir] = useState(draft.workdir)
  const [agentId, setAgentId] = useState(draft.agentId)
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
        agentId
      } as any)
      draft.prompt = ''
      setPrompt('')
      if (promptRef.current) promptRef.current.style.height = 'auto'
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

  return (
    <div className="workspace">
      <div className="workspace-card">
        <div className="workspace-title">
          <span className="brand-mark">⚓</span> 要做点什么？
        </div>
        <div className="suggest-row">
          {SUGGESTIONS.map((sg) => (
            <button key={sg} className="suggest-chip" onClick={() => { setPrompt(sg); promptRef.current?.focus() }}>
              {sg}
            </button>
          ))}
        </div>
        {agents.length > 0 ? (
          <div className="field">
            <span>执行队员{isLeader ? '（⚡ 领队：需要时会自行派工给其他队员）' : ''}</span>
            <div className="agent-picker">
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`agent-pick ${a.id === agentId ? 'active' : ''}`}
                  onClick={() => setAgentId(a.id)}
                  title={`${a.role ? a.role + ' · ' : ''}${a.note || a.backend}`}
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
          <p className="hint hint">未配置队员，默认用 zcode 执行；可在「队伍」页添加。</p>
        )}
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
        <div className="workspace-row">
          <input
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="工作目录（可选，建议选 git 仓库；队员改动会各自隔离并合入集成分支）"
          />
          <button className="btn" onClick={pick}>
            浏览…
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? '创建中…' : '开始执行'}
          </button>
        </div>
        <p className="hint workspace-hint">
          Enter 发送 · Shift+Enter 换行 · {selectedAgent ? `队员：${selectedAgent.name}${selectedAgent.role ? `（${selectedAgent.role}）` : ''}` : '队员：默认 zcode'} · 权限模式跟随设置
        </p>
      </div>
    </div>
  )
}

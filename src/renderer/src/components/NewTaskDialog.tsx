import { useEffect, useState } from 'react'
import { bridge } from '../api'
import type { Task } from '../../../shared/types'

interface Agent {
  id: string
  name: string
  backend: string
  model?: string
  note?: string
  color: string
}

export function NewTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Task) => void }) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [mode, setMode] = useState<'single' | 'squad'>('single')
  const [maxWorkers, setMaxWorkers] = useState(3)
  const [agentId, setAgentId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    bridge.agents.list().then((list) => {
      setAgents(list)
      if (list.length) setAgentId(list[0].id)
    })
  }, [])

  const pick = async () => {
    const dir = await bridge.pickDir()
    if (dir) setWorkdir(dir)
  }

  const submit = async () => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    try {
      const t = await bridge.tasks.create({
        title: title.trim(),
        prompt: prompt.trim(),
        workdir,
        agentId,
        mode,
        ...(mode === 'squad' ? { maxWorkers } : {})
      } as any)
      onCreated(t)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const selectedAgent = agents.find((a) => a.id === agentId)

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h2>新任务</h2>
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
        <label className="field">
          <span>执行队员</span>
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
          {mode === 'squad' && (
            <span className="hint">
              该队员当领队负责拆解和汇总；规划时可指定其他队员执行子任务（异构协作）
            </span>
          )}
        </label>
        <label className="field">
          <span>标题（可选）</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话概括" autoFocus />
        </label>
        <label className="field">
          <span>{mode === 'squad' ? '大任务描述 *（领队会拆解它）' : '提示词 *'}</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={mode === 'squad' ? 5 : 7}
            placeholder={
              mode === 'squad'
                ? '要团队完成什么…&#10;例如：给这个项目加上用户登录：后端 API、前端页面、单测各一个子任务'
                : '要 agent 做什么…&#10;例如：修复 src/auth.ts 里的登录超时 bug，并补一个单测'
            }
          />
        </label>
        <label className="field">
          <span>工作目录（{mode === 'squad' ? '协同改代码必选，须为 git 仓库' : '可选，建议选 git 仓库'}）</span>
          <div className="row">
            <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="D:\projects\my-app" />
            <button className="btn" onClick={pick}>
              浏览…
            </button>
          </div>
        </label>
        {mode === 'squad' && (
          <label className="field">
            <span>最多并行子任务：{maxWorkers}</span>
            <input type="range" min={2} max={6} value={maxWorkers} onChange={(e) => setMaxWorkers(Number(e.target.value))} />
          </label>
        )}
        <div className="dialog-footer">
          <span className="hint">
            队员：{selectedAgent ? `${selectedAgent.name} (${selectedAgent.backend})` : '默认'} · 权限模式跟随设置
          </span>
          <div className="row">
            <button className="btn ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" disabled={!prompt.trim() || busy || (mode === 'squad' && !workdir.trim())} onClick={submit}>
              {busy ? '创建中…' : mode === 'squad' ? '创建并派队' : '创建并执行'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

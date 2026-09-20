import { useEffect, useMemo, useRef, useState } from 'react'
import { ListTodo, MessagesSquare, Target, ArrowUpRight, Clock3, FolderOpen, Sparkles } from 'lucide-react'
import { bridge, getTaskWhenReady, type AgentInfo } from '../api'
import { isComposingKey, ui } from '../ui/interaction-center'
import { useInteractionSelector } from '../hooks/useInteraction'
import { captains } from './meeting/captains'
import type { Task } from '../../../shared/types'
import { isForgeAgent } from '../../../shared/forge'

/** 新建 Issue 的三种类型：普通任务 / 目标模式（自动推进）/ 团队会议（三队长研讨） */
type IssueKind = 'task' | 'goal' | 'meeting'

// 草稿存模块级：切去任务详情再回来不丢输入（会话内存活；类型与类型相关字段一并保留）
const draft = {
  kind: 'task' as IssueKind,
  prompt: '',
  workdir: '',
  agentId: '',
  handoff: '',
  completion: '',
  stop: '',
  maxRuns: 8,
  hours: 8,
  reporter: '',
  critic: '',
  designer: ''
}

/** 兼容保留：旧的「聚焦输入框」DOM 事件名已废弃——请求走 ui.focusComposer()（composerTick） */
export const FOCUS_WORKSPACE = 'agentdeck:focus-workspace'

/** 从首条消息自动起标题：取首行、剥掉 markdown 记号、压缩空白，截 72 字 */
function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
  const cleaned = firstLine.replace(/^#{1,6}\s*/, '').replace(/[*`~_>]+/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || firstLine.trim()).slice(0, 72)
}

/** 多行文本 → 非空行数组（目标模式的完成/停止条件，每行一条） */
function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

// 快捷示例：点击填入输入框（不直接发送），按类型切换
const SUGGESTIONS: Record<IssueKind, string[]> = {
  task: ['审查当前仓库的代码结构，给出重构建议', '给这个项目补一份 README', '找出现有的潜在 bug 并修复'],
  goal: ['把 docs/ 下的 API 文档全部对齐当前代码', '持续修复 CI 失败用例直到全绿', '把核心模块的测试覆盖率提到 80%'],
  meeting: ['评审本迭代的技术方案取舍', '复盘上一轮迭代的阻塞与流程问题', '评审搜索排序方案的技术选型']
}

const COMPOSER_LABEL: Record<IssueKind, string> = {
  task: '描述目标、约束和验收标准',
  goal: '描述要持续推进的目标',
  meeting: '描述会议议题'
}

const PROMPT_PLACEHOLDER: Record<IssueKind, string> = {
  task: '要 agent 做什么…\n领队队员会自行判断要不要拆分并派给其他队员',
  goal: '要持续推进的目标是什么…\n完成条件在下方逐条填写（每行一条）',
  meeting: '这场会议要研讨什么…\n如：评审本迭代的技术方案取舍'
}

const KINDS: Array<{ key: IssueKind; label: string; icon: typeof ListTodo }> = [
  { key: 'task', label: '任务', icon: ListTodo },
  { key: 'goal', label: '目标模式', icon: Target },
  { key: 'meeting', label: '团队会议', icon: MessagesSquare }
]

export function WorkspaceView({ onCreated, workspaceDir, onPickWorkspace }: { onCreated: (t: Task) => void; workspaceDir: string; onPickWorkspace: () => void }) {
  const [kind, setKind] = useState<IssueKind>(draft.kind)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [workdir, setWorkdir] = useState(workspaceDir || draft.workdir)
  const [agentId, setAgentId] = useState(draft.agentId)
  const [handoff, setHandoff] = useState(draft.handoff)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [completion, setCompletion] = useState(draft.completion)
  const [stop, setStop] = useState(draft.stop)
  const [maxRuns, setMaxRuns] = useState(draft.maxRuns)
  const [hours, setHours] = useState(draft.hours)
  const [reporter, setReporter] = useState(draft.reporter)
  const [critic, setCritic] = useState(draft.critic)
  const [designer, setDesigner] = useState(draft.designer)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [busy, setBusy] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bridge.agents.list().then((list) => {
      setAgents(list)
      if (list.length && !draft.agentId) {
        // 默认执行者跳过锻造师（专职生成 Agent，不接任务）
        const first = list.find((a) => !isForgeAgent(a)) ?? list[0]
        draft.agentId = first.id
        setAgentId(first.id)
      }
    })
  }, [])

  // 会议型三队长预填：取前三位合格队长（不足三位留空，由校验提示兜底）
  const eligibleCaptains = useMemo(() => captains(agents), [agents])
  useEffect(() => {
    if (eligibleCaptains.length < 3) return
    setReporter((current) => { const next = current && eligibleCaptains.some((a) => a.id === current) ? current : eligibleCaptains[0].id; draft.reporter = next; return next })
    setCritic((current) => { const next = current && eligibleCaptains.some((a) => a.id === current) ? current : eligibleCaptains[1].id; draft.critic = next; return next })
    setDesigner((current) => { const next = current && eligibleCaptains.some((a) => a.id === current) ? current : eligibleCaptains[2].id; draft.designer = next; return next })
  }, [eligibleCaptains])

  const composerTick = useInteractionSelector((state) => state.composerTick)
  const handledTickRef = useRef(0)
  /**
   * 输入框聚焦：请求方是交互中心的 composerTick（Ctrl+N / 裸 c / 命令面板「新建任务」）。
   * 请求号存在中心里：组件没挂载时发出的请求不会丢，挂载后凭 tick 消费并立即聚焦。
   */
  useEffect(() => {
    handledTickRef.current = composerTick
    promptRef.current?.focus()
  }, [composerTick])

  // 草稿回写（保持模块级副本最新）
  useEffect(() => { draft.kind = kind }, [kind])
  useEffect(() => { draft.prompt = prompt }, [prompt])
  useEffect(() => { draft.workdir = workdir }, [workdir])
  useEffect(() => { if (workspaceDir && workspaceDir !== workdir) setWorkdir(workspaceDir) }, [workspaceDir])
  useEffect(() => { draft.agentId = agentId }, [agentId])
  useEffect(() => { draft.handoff = handoff }, [handoff])
  useEffect(() => { draft.completion = completion }, [completion])
  useEffect(() => { draft.stop = stop }, [stop])
  useEffect(() => { draft.maxRuns = maxRuns }, [maxRuns])
  useEffect(() => { draft.hours = hours }, [hours])
  useEffect(() => { draft.reporter = reporter }, [reporter])
  useEffect(() => { draft.critic = critic }, [critic])
  useEffect(() => { draft.designer = designer }, [designer])

  const pick = async () => {
    const dir = await bridge.pickDir()
    if (dir) setWorkdir(dir)
  }

  const completionConditions = lines(completion)
  const captainIds = [reporter, critic, designer]
  const captainsReady = eligibleCaptains.length >= 3 && captainIds.every(Boolean) && new Set(captainIds).size === 3
  /** 类型级校验：任务恒过；目标需 ≥1 条完成条件；会议需 ≥3 位合格队长且互不重复 */
  const kindValid = kind === 'task' || (kind === 'goal' ? completionConditions.length > 0 : captainsReady)
  const submitHint = kind === 'goal'
    ? (completionConditions.length === 0 ? '目标模式至少需要一条完成条件（每行一条，逐条可验证）才能提交' : '')
    : kind === 'meeting'
      ? (eligibleCaptains.length < 3
        ? '合格队长不足三位——先在「Agent」页配置（角色匹配队长/领队或带队员）'
        : captainsReady ? '' : '请为汇报 / 质疑 / 答辩指定三位互不相同的队长')
      : ''

  const clearPrompt = () => {
    draft.prompt = ''
    setPrompt('')
    draft.handoff = ''
    setHandoff('')
    setHandoffOpen(false)
    if (promptRef.current) promptRef.current.style.height = 'auto'
  }

  const submit = async (startNow = true) => {
    if (!prompt.trim() || !kindValid || busy) return
    setBusy(true)
    try {
      // goal/meeting 的容器 Issue 一律不自动启动：执行由 goal 循环 / 会议调度接管，避免双跑
      const issue = await bridge.issues.create({
        title: deriveTitle(prompt),
        titleAuto: true,
        description: prompt.trim(),
        workdir,
        agentId,
        handoff: handoff.trim() || undefined,
        startNow: kind === 'task' ? startNow : false,
        trigger: 'assignment'
      })
      const selectedAgent = agents.find((a) => a.id === agentId)
      if (kind === 'goal') {
        await bridge.goals.create({
          text: prompt.trim(),
          issueId: issue.id,
          completionConditions,
          stopConditions: lines(stop),
          maxRuns: Math.max(1, Math.floor(maxRuns) || 1),
          maxDurationMs: Math.max(1, Math.floor(hours * 3600_000) || 3600_000),
          workdir,
          agentId: agentId || undefined,
          backend: selectedAgent?.backend,
          startNow
        })
        ui.toast.success(startNow ? '目标模式已开启' : '目标已创建——在 Issue 详情侧栏可开始推进')
        // 完成/停止条件不留在草稿里，防止下次误用旧条件
        draft.completion = ''
        setCompletion('')
        draft.stop = ''
        setStop('')
      } else if (kind === 'meeting') {
        const meeting = await bridge.meetings.create({
          issueId: issue.id,
          topic: deriveTitle(prompt),
          participants: [
            { agentId: reporter, role: 'reporter' },
            { agentId: critic, role: 'critic' },
            { agentId: designer, role: 'designer' }
          ]
        })
        if (startNow) {
          // meetings.start 要等整场会议结束才返回：挂后台跑，创建成功即跳转，失败 toast
          void bridge.meetings.start(meeting.id)
            .then((result) => { if (!result.ok) ui.toast.error(result.error ?? '会议启动失败') })
            .catch((e) => ui.toast.error('会议启动失败: ' + (e instanceof Error ? e.message : String(e))))
          ui.toast.success('会议已创建，正在开始——在 Issue 详情侧栏跟进')
        } else {
          ui.toast.success('会议已创建为草稿——在 Issue 详情侧栏可开始')
        }
      } else if (!startNow) {
        ui.toast.info('已创建，暂不启动——在任务详情点「开始执行」')
      }
      // 执行记录注册与 Issue 落库之间可能有一瞬空档：有界重试取，不立刻判失败
      const t = await getTaskWhenReady(issue.taskId)
      if (!t) throw new Error('Issue 创建成功，但执行记录尚未可用')
      clearPrompt()
      onCreated(t)
    } catch (e) {
      ui.toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 回车发送；Shift+Enter 换行；输入法组词的 Enter 不算（isComposingKey：isComposing 或 keyCode 229）
    if (e.key === 'Enter' && !e.shiftKey && !isComposingKey(e.nativeEvent)) {
      e.preventDefault()
      void submit()
    }
  }

  const canSubmit = !!prompt.trim() && kindValid && !busy
  const selectedAgent = agents.find((a) => a.id === agentId)
  const isLeader = !!selectedAgent?.subordinates?.length && selectedAgent.backend !== 'dsh'
  const greeting = new Date().getHours() < 12 ? '早上好，开始一个新任务' : new Date().getHours() < 18 ? '下午好，继续推进工作' : '晚上好，收尾一个任务'
  /** 队长下拉排除另外两个角色已选的人，从源头杜绝重复 */
  const captainOptions = (self: string) => eligibleCaptains.filter((a) => a.id !== reporter && a.id !== critic && a.id !== designer || a.id === self)

  return (
    <div className="workspace">
      <div className="workspace-card">
        <div className="workspace-greeting">{greeting}</div>
        <div className="workspace-title">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={15} /></span>
          <span>开始一个任务</span>
        </div>
        <div className="workspace-types" role="tablist" aria-label="Issue 类型">
          {KINDS.map(({ key, label, icon: Icon }) => (
            <button key={key} role="tab" aria-selected={kind === key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}>
              <Icon size={13} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
        <p className="hint workspace-lead">描述目标、约束和验收标准，AgentDeck 会把执行过程集中到一个工作区。</p>
        <div className="suggest-row">
          {SUGGESTIONS[kind].map((sg) => (
            <button key={sg} className="suggest-chip" onClick={() => { setPrompt(sg); promptRef.current?.focus() }}>
              {sg}
            </button>
          ))}
        </div>
        {kind !== 'meeting' && (agents.length > 0 ? (
          <div className="field">
            <span>执行 Agent{isLeader ? '（领队可按需拆分任务）' : ''}</span>
            <div className="agent-picker">
              {agents.filter((a) => !isForgeAgent(a)).map((a) => (
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
        ))}
        {kind === 'goal' && (
          <div className="workspace-mode-fields">
            <label className="field">
              <span>完成条件 *（每行一条，逐条可验证）</span>
              <textarea
                value={completion}
                rows={3}
                placeholder={'每条一行，如：\n所有示例可编译\n接口签名与 src 一致'}
                onChange={(e) => setCompletion(e.target.value)}
              />
            </label>
            <label className="field">
              <span>停止条件（每行一条，命中即暂停等你决策）</span>
              <textarea
                value={stop}
                rows={2}
                placeholder={'如：\n需要删除用户数据\n需要付费 API 密钥'}
                onChange={(e) => setStop(e.target.value)}
              />
            </label>
            <div className="workspace-metric-row">
              <label className="field"><span>最大轮数</span><input type="number" min={1} value={maxRuns} onChange={(e) => setMaxRuns(Number(e.target.value))} /></label>
              <label className="field"><span>最长总时长（小时）</span><input type="number" min={0.5} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
            </div>
            <p className="hint workspace-mode-hint">开启后 agent 在此 Issue 内逐轮自评推进，直到完成条件全部达成或触发护栏。</p>
          </div>
        )}
        {kind === 'meeting' && (
          <div className="workspace-mode-fields">
            <div className="field">
              <span>三队长（汇报 / 质疑 / 答辩，不得重复）</span>
              <div className="meeting-selects">
                <label>汇报
                  <select value={reporter} onChange={(e) => setReporter(e.target.value)}>
                    {captainOptions(reporter).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
                <label>质疑
                  <select value={critic} onChange={(e) => setCritic(e.target.value)}>
                    {captainOptions(critic).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
                <label>答辩
                  <select value={designer} onChange={(e) => setDesigner(e.target.value)}>
                    {captainOptions(designer).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              </div>
              <p className="hint workspace-mode-hint">会议不设单一执行者：三位队长按轮次「汇报 → 质疑 → 答辩」收敛结论；{eligibleCaptains.length < 3 ? '合格队长不足三位，先去「Agent」页配置。' : '创建后可暂停 / 继续 / 插话。'}</p>
            </div>
          </div>
        )}
        <div className="composer-label">{COMPOSER_LABEL[kind]}</div>
        <textarea
          ref={promptRef}
          className="workspace-prompt"
          value={prompt}
          rows={3}
          placeholder={PROMPT_PLACEHOLDER[kind]}
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
        {submitHint && <p className="hint workspace-mode-hint">{submitHint}</p>}
        {kind !== 'meeting' && selectedAgent && (
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

import { getDraftBridge } from './ui-draft-bridge'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types'

const mock = getDraftBridge()
const api = window.agentdeck
const now = Date.now()
let settings: AppSettings = { ...DEFAULT_SETTINGS, sharedDir: 'C:\\Workspace\\Shared' }
const settingsListeners = new Set<(settings: AppSettings) => void>()
api.settings.get = async () => settings
api.settings.set = async (patch) => {
  settings = { ...settings, ...patch }
  for (const listener of settingsListeners) listener(settings)
  return settings
}
api.settings.onUpdated = (listener) => { settingsListeners.add(listener); return () => { settingsListeners.delete(listener) } }
localStorage.setItem('agentdeck:workspace-dir', 'C:\\Projects\\AgentDeck')
mock.store.agents = [
  { id: 'lead', name: '工程领队', backend: 'zcode', color: '#339b8d', role: '工程师', note: '方案拆解、跨模块实现与交付验收', subordinates: ['build', 'review'] },
  { id: 'build', name: '实现工程师', backend: 'codex', color: '#537fc7', role: '开发', note: '组件实现、回归测试与性能优化' },
  { id: 'review', name: '审查工程师', backend: 'claude', color: '#bd8040', role: '审查', note: '代码审查、边界条件与交互验收' },
  { id: 'research', name: '研究助理', backend: 'dsh', color: '#956fb1', role: '分析', note: '依赖梳理、资料分析与方案比较' }
]
const titles = ['统一页面标题与内容布局', '补齐表单验证和键盘导航', '整理工作区依赖关系', '检查运行时连接状态', '完善用量统计与错误归因', '审核发布前的回归测试']
titles.forEach((title, i) => {
  const status = (['running', 'queued', 'done', 'failed', 'done', 'queued'] as const)[i]
  const task = mock.seedTask({ id: `visual-${i}`, title, prompt: '检查页面布局与交互，保留现有任务流程。', workdir: 'C:\\Projects\\AgentDeck', status })
  Object.assign(task, { createdAt: now - (i + 1) * 600_000, startedAt: now - (i + 1) * 180_000, endedAt: status === 'done' || status === 'failed' ? now - i * 60_000 : undefined, sessionId: 'preview-session', agentId: mock.store.agents[i % 4].id, gitStat: 'src/renderer/src/ui/PageHeader.tsx | 24 ++++++++++++', gitDiff: '@@ -100,2 +100,2 @@\n-old heading\n+shared heading\n context', result: '已完成页面检查。\n\n- 统一标题层级\n- 保留操作入口\n- 验证窄窗口布局' })
  const issue = mock.store.issues.find((item) => item.taskId === task.id)!
  Object.assign(issue, { status: ['in_progress', 'todo', 'done', 'blocked', 'in_review', 'todo'][i], identifier: `AD-${101 + i}`, createdAt: task.createdAt })
})
api.tasks.events = async (id) => [
  { seq: 1, ts: now - 120_000, kind: 'user', text: mock.store.tasks.find((task) => task.id === id)?.prompt ?? '检查工作区' },
  { seq: 2, ts: now - 110_000, kind: 'tool', text: '读取页面组件', data: { phase: 'started', args: 'src/renderer/src/components' } },
  { seq: 3, ts: now - 100_000, kind: 'tool', text: '读取页面组件', data: { phase: 'result', ok: true, durationMs: 120 } },
  { seq: 4, ts: now - 90_000, kind: 'final', text: '### 页面检查\n\n已核对共享页头、工作区入口和状态反馈。\n\n| 页面 | 标题 | 状态 |\n| --- | --- | --- |\n| Issue | 共享页头 | 通过 |\n| 看板 | 共享页头 | 通过 |\n\n下一步检查窄窗口下的长标题和操作菜单。' }
]
const aggregate = { runs: 32, completed: 29, failed: 2, cancelled: 1, inputTokens: 186000, outputTokens: 64000, totalTokens: 250000, costUsd: 3.82, durationMs: 1524000 }
api.analytics.summary = async () => ({
  until: now, generatedAt: now, totals: aggregate,
  byDay: Array.from({ length: 7 }, (_, i) => ({ ...aggregate, date: new Date(now - (6 - i) * 86400000).toLocaleDateString('en-CA'), runs: 3 + i, inputTokens: 9000 + i * 4200, outputTokens: 2400 + i * 1300, failed: i === 3 ? 1 : 0 })),
  byBackend: ['zcode', 'codex', 'claude'].map((backend, i) => ({ ...aggregate, key: backend, label: backend, runs: 12 - i * 3, inputTokens: 70000 - i * 14000, outputTokens: 22000 - i * 5000 })),
  byAgent: mock.store.agents.map((agent, i) => ({ ...aggregate, key: agent.id, label: agent.name, runs: 10 - i * 2 })),
  errors: []
})
api.automations.list = async () => [{ id: 'daily', name: '每日提交摘要', prompt: '整理最近提交中的重要变更与待处理事项。', workdir: 'C:\\Projects\\AgentDeck', scheduleMinutes: 1440, enabled: false, output: 'issue', createdAt: now, updatedAt: now }]
api.skills.list = async () => ({ root: 'C:\\Workspace\\Shared', skills: [] })

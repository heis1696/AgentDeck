import { getDraftBridge } from './ui-draft-bridge'

const mock = getDraftBridge()
mock.reset()
mock.store.agents = Array.from({ length: 20 }, (_, i) => ({
  id: `browser-agent-${i}`,
  name: `Browser geometry Agent with a deliberately long name ${i}`,
  role: i === 0 ? '领队' : '执行者',
  backend: i % 2 ? 'codex' : 'zcode',
  model: `browser-model-${i}`,
  color: '#3aa99f'
}))
const now = Date.now()
for (let i = 0; i < 8; i++) {
  const task = mock.seedTask({ id: `browser-task-${i}`, title: `Browser workflow task ${i}`, prompt: 'Validate the Issue workflow layout.', workdir: 'C:\\Projects\\AgentDeck', status: i % 3 === 0 ? 'done' : 'queued' })
  Object.assign(task, { createdAt: now - i * 86_400_000, startedAt: i % 3 === 0 ? now - i * 86_400_000 : undefined, endedAt: i % 3 === 0 ? now - i * 86_400_000 + 1_000 : undefined })
}
localStorage.setItem('agentdeck:workspace-dir', 'C:\\Projects\\AgentDeck')

import '../../src/renderer/src/main'
import { ui } from '../../src/renderer/src/ui/interaction-center'

Object.assign(window, { __workflow: { ui, mock } })
ui.navigate('issues')

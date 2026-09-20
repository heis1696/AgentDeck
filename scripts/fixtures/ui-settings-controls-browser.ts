/**
 * Settings controls browser fixture (docs/UI-DETAIL-FEEDBACK.md §B).
 *
 * Real renderer + real CSS in Chromium with an isolated in-memory bridge:
 * no main process, no agent execution, no filesystem writes and no production
 * settings are touched. Every control in all five settings sections renders
 * from this fake state so hit targets, geometry and write ordering can be
 * driven with real mouse coordinates.
 */
import { getDraftBridge } from './ui-draft-bridge'
import { DEFAULT_SETTINGS, type AppSettings, type RuntimeSnapshot } from '../../src/shared/types'
import type { PetStateSnapshot } from '../../src/shared/pet'
import type { UpdateStateSnapshot } from '../../src/shared/contracts'

const mock = getDraftBridge()
mock.reset()

const api = window.agentdeck
const listeners = new Set<(settings: AppSettings) => void>()

/** 观察面：保存顺序、探测次数、可控延迟与可控失败 */
export interface SettingsControlProbe {
  saves: Array<Record<string, unknown>>
  probes: number
  checks: number
  saveDelayMs: number
  failSaves: boolean
  reset(): void
  /** 复位设置与更新快照：让每个视口/主题组合从同一初始状态出发 */
  resetAll(): Promise<void>
}

const initialSettings: AppSettings = { ...DEFAULT_SETTINGS, theme: 'dark', sharedDir: 'C:\\Workspace\\Shared' }
let settings: AppSettings = { ...initialSettings }

const probe: SettingsControlProbe = {
  saves: [],
  probes: 0,
  checks: 0,
  saveDelayMs: 0,
  failSaves: false,
  reset() { this.saves = []; this.probes = 0; this.checks = 0; this.saveDelayMs = 0; this.failSaves = false },
  async resetAll() {
    this.reset()
    settings = { ...initialSettings }
    updateSnapshot = { ...initialSnapshot, available: {} }
    for (const listener of listeners) listener(settings)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

api.settings.get = async () => settings
api.settings.set = async (patch) => {
  probe.saves.push(patch as Record<string, unknown>)
  if (probe.saveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, probe.saveDelayMs))
  if (probe.failSaves) throw new Error('fixture settings store blocked')
  settings = { ...settings, ...patch }
  for (const listener of listeners) listener(settings)
  return settings
}
api.settings.onUpdated = (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.settings.probe = async () => { probe.probes += 1; return { ok: true, detail: 'zcode.cjs 可用', searched: [] } }
api.pickDir = async () => 'D:\\Picked\\Shared'

let updateSnapshot: UpdateStateSnapshot = {
  phase: 'idle',
  channel: null,
  currentVersion: '0.22.0',
  activeRendererVersion: '0.22.0',
  available: {}
}
const initialSnapshot: UpdateStateSnapshot = { ...updateSnapshot }
api.updates.getState = async () => updateSnapshot
api.updates.check = async () => { probe.checks += 1; updateSnapshot = { ...updateSnapshot, available: { renderer: '0.23.0' } }; return updateSnapshot }
api.updates.onState = () => () => undefined

const snapshots: RuntimeSnapshot[] = [
  { id: 'zcode', label: 'ZCode', backend: 'zcode', kind: 'local', health: 'online', detail: '本地 CLI 可用。', version: '1.2.3', activeTaskCount: 0, checkedAt: Date.now() },
  { id: 'codex', label: 'Codex', backend: 'codex', kind: 'local', health: 'offline', detail: '未找到可执行文件。', activeTaskCount: 0, checkedAt: Date.now() }
]
api.runtimes.snapshot = async () => snapshots.map((snapshot) => ({ ...snapshot }))
api.agents.list = async () => [{ id: 'lead', name: '工程领队', backend: 'zcode', color: '#339b8d', role: '工程领队' }]

const petState: PetStateSnapshot = {
  enabled: true,
  packId: 'default',
  personaPrompt: '',
  autonomySec: 60,
  presetId: '',
  activePresetId: '',
  model: '',
  presets: [],
  brainStatus: { source: 'none', lastError: '', silenced: false },
  chatHistory: [],
  packs: [],
  zoom: 1,
  recentEvent: ''
}
api.pet.getState = async () => petState
api.pet.onState = () => () => undefined
api.skills.list = async () => ({ root: 'C:\\Workspace\\Shared', skills: [] })

localStorage.setItem('agentdeck:workspace-dir', 'C:\\Projects\\AgentDeck')

import '../../src/renderer/src/main'
import { ui } from '../../src/renderer/src/ui/interaction-center'

Object.assign(window, { __settings: { ui, mock, probe, getSettings: () => settings } })
ui.navigate('settings')

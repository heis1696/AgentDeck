import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-ipc-validation.cjs')
await build({ entryPoints: [path.join(root, 'src/main/ipc-validation.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const validation = await import(pathToFileURL(outfile).href)
const expectReject = (fn, label) => {
  try { fn() } catch { return }
  throw new Error(`${label} was accepted`)
}

const task = validation.parseTaskCreate({ title: 'x', prompt: 'p', workdir: '' })
if (task.title !== 'x' || task.prompt !== 'p') throw new Error('valid task was rejected')
expectReject(() => validation.parseTaskCreate({ title: '', prompt: 'p', workdir: '' }), 'empty title')
expectReject(() => validation.parseTaskCreate({ title: 'x', prompt: 'p', workdir: '', unknown: true }), 'unknown task field')
expectReject(() => validation.parseIssuePatch({ status: 'running' }), 'invalid issue status')
expectReject(() => validation.parseSettingsPatch({ concurrency: 0 }), 'invalid concurrency')
expectReject(() => validation.parseSettingsPatch({ unknown: true }), 'unknown setting')
expectReject(() => validation.parseContent(''), 'empty content')
const automation = validation.parseAutomationCreate({ name: 'daily', prompt: 'check', workdir: '', scheduleMinutes: 15, output: 'issue', enabled: true })
if (automation.scheduleMinutes !== 15 || automation.output !== 'issue') throw new Error('valid automation was rejected')
expectReject(() => validation.parseAutomationCreate({ name: 'x', prompt: 'p', workdir: '', scheduleMinutes: 0, output: 'issue' }), 'invalid automation schedule')
expectReject(() => validation.parseAutomationUpdate({ createdAt: 1 }), 'immutable automation field')
const agents = validation.parseAgents([{ id: 'ag_1', name: 'One', backend: 'codex', color: '#fff' }])
if (agents.length !== 1 || agents[0].backend !== 'codex') throw new Error('valid agents were rejected')
expectReject(() => validation.parseAgents([{ id: 'ag_1', name: 'One', backend: 'unknown', color: '#fff' }]), 'invalid agent backend')
expectReject(() => validation.parseAgents([{ id: 'same', name: 'One', backend: 'codex', color: '#fff' }, { id: 'same', name: 'Two', backend: 'claude', color: '#000' }]), 'duplicate agent id')
const presets = validation.parsePresets([{ id: 'pst_1', name: 'Gateway', backend: 'claude', baseURL: 'https://example.invalid', apiKey: 'secret', createdAt: 1 }])
if (presets.length !== 1 || presets[0].backend !== 'claude') throw new Error('valid presets were rejected')
expectReject(() => validation.parsePresets([{ id: 'pst_1', name: 'Gateway', backend: 'claude', baseURL: '', apiKey: 'secret', createdAt: 1 }]), 'empty preset URL')
expectReject(() => validation.parseFollowUpOptions({ relay: 'yes' }), 'invalid relay flag')
expectReject(() => validation.parsePermissionDecision('later'), 'invalid permission decision')
expectReject(() => validation.parseAnalyticsRange({ since: 20, until: 10 }), 'reversed analytics range')
expectReject(() => validation.parseNotification({ title: '', body: 'x' }), 'empty notification title')
console.log('✓ valid DTOs accepted and invalid DTOs rejected')
console.log('✅ IPC VALIDATION SMOKE PASSED')

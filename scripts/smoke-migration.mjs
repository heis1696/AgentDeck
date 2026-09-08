// P0 迁移验证：0.3.x 旧格式 tasks.json → 0.4 新 schema（去 mode/squad → integration；悬挂 running 标失败）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-store.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/store.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron']
})
const { TaskStore, TASK_INDEX_SCHEMA_VERSION } = await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mig-'))
const tasksDir = path.join(tmp, 'tasks')
fs.mkdirSync(tasksDir, { recursive: true })
fs.writeFileSync(
  path.join(tasksDir, 'tasks.json'),
  JSON.stringify([
    {
      id: 't_old_leader', title: '旧领队', prompt: 'p', workdir: '', backend: 'zcode', mode: 'squad', status: 'running',
      squad: { phase: 'executing', maxWorkers: 3, integrationBranch: 'agentdeck/task-x', integrationNote: '改动已合入集成分支 agentdeck/task-x' },
      createdAt: 1, eventCount: 2
    },
    {
      id: 't_old_done', title: '旧完成领队', prompt: 'p', workdir: '', backend: 'zcode', mode: 'squad', status: 'done', result: 'r',
      squad: { phase: 'done', maxWorkers: 2, integrationBranch: 'agentdeck/task-y', integrationNote: '集成完成' },
      createdAt: 2, eventCount: 1
    },
    { id: 't_running', title: '普通运行中', prompt: 'p', workdir: '', backend: 'zcode', mode: 'single', status: 'running', createdAt: 3, eventCount: 0 },
    { id: 't_ok', title: '普通完成', prompt: 'p', workdir: '', backend: 'zcode', mode: 'single', status: 'done', result: 'r', createdAt: 4, eventCount: 1 }
  ])
)

const store = new TaskStore(tmp)
const list = store.list()
const by = (id) => list.find((t) => t.id === id)

console.log('旧 squad 任务迁移：')
ok(by('t_old_leader').status === 'failed', '运行中的旧 squad 领队 → failed')
ok(!!by('t_old_leader').error?.includes('重新运行'), '给出重跑提示')
ok(by('t_old_leader').integration?.branch === 'agentdeck/task-x', 'integrationBranch → integration.branch')
ok(by('t_old_leader').integration?.note?.includes('agentdeck/task-x') === true, 'integrationNote → integration.note')
ok(!('mode' in by('t_old_leader')) && !('squad' in by('t_old_leader')), 'mode/squad 字段已剥离')

console.log('已完成旧 squad 任务迁移：')
ok(by('t_old_done').status === 'done', 'done 状态保持')
ok(by('t_old_done').integration?.branch === 'agentdeck/task-y', '集成信息保留（历史可看）')

console.log('普通任务：')
ok(by('t_running').status === 'failed' && !!by('t_running').error, '重启悬挂的 running → failed（不再永久执行中）')
ok(by('t_ok').status === 'done' && by('t_ok').result === 'r', 'done 任务原样保留')

console.log('落盘：')
const saved = JSON.parse(fs.readFileSync(path.join(tasksDir, 'tasks.json'), 'utf8'))
ok(saved.schemaVersion === TASK_INDEX_SCHEMA_VERSION, 'tasks.json 写入显式 schema version')
ok(Array.isArray(saved.tasks) && saved.tasks.every((t) => !('mode' in t) && !('squad' in t)), 'tasks.json 已重写为新 schema')
const stable = JSON.stringify(saved)
const second = new TaskStore(tmp)
const savedAgain = JSON.parse(fs.readFileSync(path.join(tasksDir, 'tasks.json'), 'utf8'))
ok(second.get('t_old_leader')?.endedAt === saved.tasks.find((t) => t.id === 't_old_leader')?.endedAt, '重复加载不重新生成迁移时间戳')
ok(JSON.stringify(savedAgain) === stable, '重复迁移保持索引稳定')

console.log('显式版本边界：')
const { migrateTaskIndex } = await import(pathToFileURL(outfile).href)
const versionZero = migrateTaskIndex({ schemaVersion: 0, tasks: [{ id: 't_v0', title: 'v0', prompt: 'p', status: 'done', squad: 'malformed', futureField: 'drop-me' }] }, 123)
ok(versionZero.schemaVersion === TASK_INDEX_SCHEMA_VERSION, 'schemaVersion 0 通过显式迁移升级')
ok(versionZero.tasks[0]?.status === 'done' && !('squad' in versionZero.tasks[0]) && !('futureField' in versionZero.tasks[0]), '版本 0 不保留隐式 legacy 字段')
ok(migrateTaskIndex([null, {}, { id: 't_valid', title: 'valid', prompt: 'p' }]).tasks.length === 1, '无效索引条目被安全过滤')
let futureRejected = false
try {
  migrateTaskIndex({ schemaVersion: TASK_INDEX_SCHEMA_VERSION + 1, tasks: [] })
} catch {
  futureRejected = true
}
ok(futureRejected, '未来 schema version 明确拒绝而不降级')

if (failed) {
  console.error(`\n❌ MIGRATION SMOKE FAILED (${failed})`)
  process.exit(1)
}
console.log('\n✅ MIGRATION SMOKE PASSED')

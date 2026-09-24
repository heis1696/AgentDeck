import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out/smoke-git-snapshot.cjs')
globalThis.window = { agentdeck: {} }
await build({
  stdin: { contents: [
    "export { snapshotGitAfter, branchDiffSummary } from './src/main/git'",
    "export { TaskStore } from './src/main/store'",
    "export { TaskFinalizer } from './src/main/task-finalizer'",
    "export { currentGitSnapshot, currentGitChanges } from './src/shared/git-snapshot'",
    "export { GitSummary } from './src/renderer/src/components/task/GitSummary'"
  ].join('\n'), resolveDir: root, loader: 'tsx' },
  outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['electron', 'react', 'react/jsx-runtime', 'lucide-react']
})
const { snapshotGitAfter, branchDiffSummary, TaskStore, TaskFinalizer, GitSummary, currentGitSnapshot, currentGitChanges } = await import(pathToFileURL(outfile).href)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-git-snapshot-'))
const repo = path.join(temp, 'repo')
const nonRepo = path.join(temp, 'not-a-repo')
fs.mkdirSync(repo)
fs.mkdirSync(nonRepo)
process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'empty-global-config')
process.env.GIT_CONFIG_NOSYSTEM = '1'
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const commit = (cwd, message) => git(cwd, '-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke', 'commit', '-m', message)
const storeDir = path.join(temp, 'data')
let store = new TaskStore(storeDir)
const render = (task, expected) => {
  const page = new JSDOM(renderToStaticMarkup(createElement(GitSummary, { task })))
  const pane = page.window.document.querySelector('.git-pane')
  assert.equal(pane.dataset.snapshotState, expected)
  if (expected !== 'available' && expected !== 'historical') assert.equal(pane.querySelector('.diff-file'), null, 'stale/failed snapshots must not render old diff')
  if (expected !== 'clean' && expected !== 'available') assert(!pane.textContent.includes('无改动'))
  const text = pane.textContent
  page.window.close()
  return text
}
let run = 0
function start(id, workdir = repo) {
  run++
  store.update(id, { status: 'running', runId: `run-${run}`, phaseIndex: run, startedAt: 1000 + run, workdir })
}
async function finish(id) {
  await new TaskFinalizer(store, () => {}).finalizeDone(id, 'complete')
  store.flush()
  store = new TaskStore(storeDir)
  const saved = store.get(id)
  assert.equal(saved.status, 'done')
  assert.equal(saved.gitSnapshot.runId, saved.runId)
  assert.equal(saved.gitSnapshot.startedAt, saved.startedAt)
  assert(saved.gitSnapshot.capturedAt > 0)
  return saved
}

try {
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(repo, 'add', '.')
  // Staged-only changes in a repository without HEAD are still changes.
  const unborn = await snapshotGitAfter(repo)
  assert.equal(unborn.snapshot.state, 'available')
  assert(unborn.diff.includes('+base'))
  commit(repo, 'base')

  const task = store.create({ title: 'Snapshot', prompt: 'capture', workdir: repo, backend: 'fake' })
  start(task.id)
  let saved = await finish(task.id)
  assert.equal(saved.gitDiff, '')
  assert.equal(saved.gitStat, '')
  assert.equal(saved.gitSnapshot.state, 'clean')
  render(saved, 'clean')

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
  start(task.id)
  saved = await finish(task.id)
  assert.equal(saved.gitSnapshot.state, 'available')
  assert(saved.gitDiff.includes('+changed'))
  render(saved, 'available')
  const dirtySnapshot = structuredClone(saved)
  assert.equal(currentGitChanges(saved).diff, saved.gitDiff)
  for (const changed of [
    { runId: 'another-run' }, { phaseIndex: saved.phaseIndex + 1 }, { startedAt: saved.startedAt + 1 },
    { gitSnapshot: undefined }, { gitSnapshot: { ...saved.gitSnapshot, capturedAt: NaN } }
  ]) {
    assert.equal(currentGitSnapshot({ ...saved, ...changed }), undefined)
    assert.equal(currentGitChanges({ ...saved, ...changed }), undefined)
  }
  for (const state of ['clean', 'error', 'unavailable']) {
    assert.equal(currentGitChanges({ ...saved, gitSnapshot: { ...saved.gitSnapshot, state } }), undefined)
  }
  assert.equal(currentGitSnapshot({ gitSnapshot: { ...saved.gitSnapshot, runId: undefined, phaseIndex: undefined, startedAt: undefined } }), undefined)

  start(task.id)
  render(store.get(task.id), 'executing')
  render({ ...store.get(task.id), status: 'failed' }, 'unavailable')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  saved = await finish(task.id)
  assert.equal(saved.gitDiff, '', 'clean rerun must replace old diff')
  assert.equal(saved.gitStat, '', 'clean rerun must replace old stat')
  render(saved, 'clean')

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n')
  git(repo, 'add', 'tracked.txt')
  const staged = await snapshotGitAfter(repo)
  assert.equal(staged.snapshot.state, 'available')
  assert(staged.diff.includes('+staged'))
  commit(repo, 'staged')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n')
  const untracked = await snapshotGitAfter(repo)
  assert.equal(untracked.snapshot.state, 'available')
  assert(untracked.diff.includes('untracked.txt'))
  fs.unlinkSync(path.join(repo, 'untracked.txt'))

  // A real command error after a valid repo probe must not look clean.
  const indexFile = path.join(repo, '.git/index')
  const index = fs.readFileSync(indexFile)
  try {
    fs.writeFileSync(indexFile, 'corrupt index')
    start(task.id)
    store.update(task.id, { gitDiff: dirtySnapshot.gitDiff, gitStat: dirtySnapshot.gitStat })
    saved = await finish(task.id)
    assert.equal(saved.gitSnapshot.state, 'error')
    assert(saved.gitSnapshot.reason.includes('git exit'))
    assert.equal(saved.gitDiff, '')
    render(saved, 'error')
  } finally { fs.writeFileSync(indexFile, index) }

  start(task.id, nonRepo)
  saved = await finish(task.id)
  assert.equal(saved.gitSnapshot.state, 'unavailable')
  render(saved, 'unavailable')
  assert.equal((await snapshotGitAfter('')).snapshot.state, 'unavailable')
  assert.equal((await snapshotGitAfter(path.join(temp, 'missing'))).snapshot.state, 'error')

  // Exercise actual branch capture, then the same preservation path used by delegates.
  git(repo, 'checkout', '-b', 'integration')
  fs.writeFileSync(path.join(repo, 'integrated.txt'), 'integrated\n')
  git(repo, 'add', '.')
  commit(repo, 'integration')
  git(repo, 'checkout', 'main')
  const branch = await branchDiffSummary(repo, 'main', 'integration')
  assert.equal(branch.snapshot.state, 'available')
  assert.equal(branch.snapshot.scope, 'integration')
  start(task.id)
  const current = store.get(task.id)
  store.update(task.id, {
    integration: { branch: 'integration', note: 'smoke' },
    gitDiff: branch.diff, gitStat: branch.stat,
    gitSnapshot: { ...branch.snapshot, runId: current.runId, phaseIndex: current.phaseIndex, startedAt: current.startedAt }
  })
  saved = await finish(task.id)
  assert.equal(saved.gitSnapshot.scope, 'integration')
  assert.equal(saved.gitSnapshot.headSha, branch.snapshot.headSha, 'integration snapshots record the branch head at capture time')
  assert(saved.gitDiff.includes('integrated.txt'))
  assert(render(saved, 'available').includes('集成分支快照'))
  // J2/M3：跨轮保留不再凭「工作副本干净」推断——直接观测集成分支 HEAD。分支未动时
  // 旧证据仍然精确，重盖本轮时间戳保留；分支已前进（部分失败轮不写证据的形状）时
  // 过期 diff 被拒绝重盖为本轮证据。
  start(task.id)
  saved = await finish(task.id)
  assert.equal(saved.gitSnapshot.scope, 'integration')
  assert(saved.gitDiff.includes('integrated.txt'), 'an unmoved integration branch keeps the prior evidence across runs')
  assert.equal(saved.gitSnapshot.runId, saved.runId, 'the preserved evidence is re-stamped to the current run')
  git(repo, 'checkout', 'integration')
  fs.writeFileSync(path.join(repo, 'partial.txt'), 'merged without evidence\n')
  git(repo, 'add', '.')
  commit(repo, 'partial round advanced the branch')
  git(repo, 'checkout', 'main')
  start(task.id)
  saved = await finish(task.id)
  assert.equal(saved.gitSnapshot.scope, 'workspace', 'a moved branch voids the stale integration snapshot')
  assert.equal(saved.gitDiff, '', 'the stale diff must not be re-stamped as this round evidence')
  assert.equal(saved.gitSnapshot.headSha, undefined)
  render(saved, 'clean')
  assert.equal((await branchDiffSummary(repo, 'missing', 'integration')).snapshot.state, 'error')

  start(task.id)
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const finishing = new TaskFinalizer(store, () => {}, async () => pending).finalizeDone(task.id, 'old result')
  start(task.id)
  const nextRun = store.get(task.id).runId
  release(branch)
  await finishing
  assert.equal(store.get(task.id).runId, nextRun)
  assert.equal(store.get(task.id).status, 'running')
  assert.notEqual(store.get(task.id).result, 'old result')
  render(store.get(task.id), 'executing')

  // Legacy snapshots stay inspectable but cannot certify a current clean run.
  render({ ...dirtySnapshot, gitSnapshot: undefined, gitDiff: '', gitStat: '' }, 'unavailable')
  assert(render({ ...dirtySnapshot, gitSnapshot: undefined }, 'historical').includes('无法确认是否来自本轮'))
  console.log('GIT SNAPSHOT SMOKE PASSED: real collector -> finalizer -> store reload -> renderer; clean, staged, untracked, errors, integration and stale runs')
} finally {
  store.flush()
  const relative = path.relative(os.tmpdir(), temp)
  if (!relative.startsWith('agentdeck-git-snapshot-') || relative.includes(path.sep)) throw new Error('Unexpected temporary directory')
  fs.rmSync(temp, { recursive: true, force: true })
}

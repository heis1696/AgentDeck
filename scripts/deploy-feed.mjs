#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const safeRelative = (value) => /^[A-Za-z0-9._/-]+$/.test(value) && !path.posix.isAbsolute(value) && value.split('/').every((part) => part && part !== '.' && part !== '..')
const immutable = (relative) => relative.startsWith('versions/') || relative.endsWith('.zip')

export function planDeployment(local, remote, remoteDir, releaseId, force = false) {
  assert.match(remoteDir, /^\/[A-Za-z0-9._/-]+$/)
  assert.ok(remoteDir.split('/').filter(Boolean).length >= 2 && !remoteDir.split('/').includes('..'), 'requires a dedicated remote feed directory')
  assert.match(releaseId, /^[A-Za-z0-9-]+$/)
  for (const file of local) {
    assert.ok(safeRelative(file.rel), 'unsafe feed path: ' + file.rel)
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    if (immutable(file.rel) && remote.has(file.rel)) assert.equal(remote.get(file.rel), file.sha256, 'immutable remote artifact differs: ' + file.rel)
  }
  const changed = local.filter((file) => force || remote.get(file.rel) !== file.sha256)
  const stage = path.posix.join(remoteDir, '.deploy-' + releaseId)
  const publish = [...changed].sort((first, second) => Number(/^stable\/[^/]+\/manifest\.json$/.test(first.rel)) - Number(/^stable\/[^/]+\/manifest\.json$/.test(second.rel)) || first.rel.localeCompare(second.rel))
  return { changed, publish, stage }
}

export function deployFeed({ env = process.env, dry = false, force = false, execute = (command, args) => spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 }), releaseId = crypto.randomUUID() } = {}) {
  const directory = path.resolve(env.FEED_LOCAL_DIR || path.join(root, 'dist', 'feed'))
  const host = env.FEED_HOST || '118.31.43.156'
  const user = env.FEED_USER || 'root'
  const remoteDir = env.FEED_REMOTE_DIR || '/var/www/agentdeck-feed'
  assert.match(host, /^[A-Za-z0-9.-]+$/)
  assert.match(user, /^[A-Za-z0-9_-]+$/)
  assert.ok(fs.existsSync(path.join(directory, 'stable')), 'feed directory has no stable releases')
  planDeployment([], new Map(), remoteDir, releaseId)
  const target = user + '@' + host
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  const run = (command, args, readOnly = false) => {
    console.log('[run] ' + command + ' ' + args.join(' '))
    if (dry && !readOnly) return { status: 0, stdout: '' }
    const result = execute(command, args)
    assert.equal(result.error, undefined, 'deployment command could not execute')
    assert.equal(result.status, 0, 'deployment command failed: ' + String(result.stderr || '').slice(0, 300))
    return result
  }
  const ssh = (command, readOnly = false) => run('ssh', [...options, target, command], readOnly)
  const local = []
  const walk = (parent) => {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name)
      if (entry.isDirectory()) walk(file)
      else {
        assert.ok(entry.isFile(), 'feed may not contain symlinks')
        local.push({ rel: path.relative(directory, file).split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
      }
    }
  }
  walk(directory)
  const inventory = ssh('if test -d ' + quote(remoteDir) + '; then cd ' + quote(remoteDir) + " && find . -type f -not -path './.deploy-*/*' -exec sha256sum {} +; fi", true)
  const remote = new Map()
  for (const line of inventory.stdout.split('\n')) {
    const match = /^([a-f0-9]{64})  \.\/(\S+)$/.exec(line.trim())
    if (match) remote.set(match[2], match[1])
  }
  const plan = planDeployment(local, remote, remoteDir, releaseId, force)
  console.log('[plan] upload ' + plan.changed.length + ', unchanged ' + (local.length - plan.changed.length))
  const uploaded = new Map()
  for (const file of plan.changed) {
    const destination = path.posix.join(plan.stage, file.rel)
    ssh('mkdir -p -- ' + quote(path.posix.dirname(destination)))
    if (uploaded.has(file.sha256)) ssh('ln -- ' + quote(uploaded.get(file.sha256)) + ' ' + quote(destination))
    else run('scp', ['-q', ...options, path.join(directory, ...file.rel.split('/')), target + ':' + destination])
    ssh('test "$(sha256sum -- ' + quote(destination) + ' | cut -d " " -f 1)" = ' + quote(file.sha256))
    uploaded.set(file.sha256, destination)
  }
  for (const file of plan.publish) {
    const staged = path.posix.join(plan.stage, file.rel)
    const destination = path.posix.join(remoteDir, file.rel)
    let publish
    if (immutable(file.rel)) publish = 'if test -e ' + quote(destination) + '; then test "$(sha256sum -- ' + quote(destination) + ' | cut -d " " -f 1)" = ' + quote(file.sha256) + '; else ln -- ' + quote(staged) + ' ' + quote(destination) + '; fi; status=$?; if test "$status" -eq 0; then rm -f -- ' + quote(staged) + '; fi; exit "$status"'
    else publish = 'mv -f -- ' + quote(staged) + ' ' + quote(destination)
    ssh('mkdir -p -- ' + quote(path.posix.dirname(destination)) + ' && ' + publish)
  }
  console.log(dry ? '[dry-run] no remote writes executed' : '[ok] staged files verified; artifacts published before atomic stable manifests')
  return plan
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { deployFeed({ dry: process.argv.includes('--dry-run'), force: process.argv.includes('--force') }) }
  catch (error) { console.error('[FAIL] ' + error.message); process.exitCode = 1 }
}

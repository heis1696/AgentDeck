#!/usr/bin/env node
/**
 * scripts/ship.mjs — 一键发布流水线：构建 → 签名三层 feed → 部署到服务器 → git 提交推送
 *
 * 封装现有脚本编排（不重复实现）：
 *   1. scripts/release-hot.mjs   —— electron-vite build + electron-builder（shell 通道）+ 签名 + 自检
 *   2. scripts/deploy-feed.mjs   —— scp 上传 dist/feed → 服务器 + nginx reload
 *   3. git add -A + commit + push origin main（当前分支）
 *
 * 签名密钥自动发现：HOT_SIGNING_KEY / HOT_SIGNING_KEY_PATH 未设时，取
 * ~/.agentdeck/hot-keys/ 下最新修改的 *.pem，keyId 取文件名（与 gen-hot-key.mjs 命名约定一致）。
 *
 * 用法：npm run ship [-- --seq 2 --channel renderer --note "修复xx" --skip-deploy --skip-git]
 *   --skip-deploy  只构建签名不上传；--skip-git 不做 git 提交推送
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const take = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const note = take('note')

const run = (label, cmd, cmdArgs, opts = {}) => {
  console.log(`\n[ship] ${label}: ${cmd} ${cmdArgs.join(' ')}`)
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: opts.shell ?? false, env: { ...process.env, ...opts.env } })
  if (r.status !== 0) {
    console.error(`[ship][FAIL] ${label} 失败（退出码 ${r.status}）— 流水线中止`)
    process.exit(r.status ?? 1)
  }
}

// ---------- 签名密钥发现 ----------
function discoverSigningKey() {
  if (process.env.HOT_SIGNING_KEY || process.env.HOT_SIGNING_KEY_PATH) return { env: {}, keyId: take('key-id') }
  const dir = path.join(os.homedir(), '.agentdeck', 'hot-keys')
  if (!fs.existsSync(dir)) return null
  const pems = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.pem'))
    .map((n) => ({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (pems.length === 0) return null
  const keyId = take('key-id') || path.basename(pems[0].file).replace(/\.pem$/, '')
  return { env: { HOT_SIGNING_KEY_PATH: pems[0].file }, keyId }
}

const key = discoverSigningKey()
if (!key) {
  console.error('[ship][FAIL] 未找到签名私钥：先运行 node scripts/gen-hot-key.mjs 生成（或设 HOT_SIGNING_KEY_PATH）')
  process.exit(1)
}
console.log(`[ship] 签名密钥: ${path.basename(process.env.HOT_SIGNING_KEY_PATH ?? '') || '(env)'} keyId=${key.keyId}`)

// ---------- 1. 构建签名 ----------
// 自动序号：未指定 --seq 时扫 versions/ 取下一空位（同序号重签会撞"版本历史不可变"守卫）
function nextSeq(pkgVersion) {
  const versionsRoot = path.join(root, 'dist', 'feed', 'versions')
  if (!fs.existsSync(versionsRoot)) return 1
  let max = 0
  for (const channel of fs.readdirSync(versionsRoot)) {
    const dir = path.join(versionsRoot, channel)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const m = new RegExp(`^${pkgVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-hot\\.(\\d+)$`).exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  return max + 1
}
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const seq = take('seq') || String(nextSeq(pkgVersion))
console.log(`[ship] 版本: ${pkgVersion}-hot.${seq}`)
const releaseArgs = ['scripts/release-hot.mjs', '--key-id', key.keyId, '--seq', seq]
const channel = take('channel')
if (channel) releaseArgs.push('--channel', channel)
run('构建+签名+自检', 'node', releaseArgs, { env: key.env })

// ---------- 2. 部署 ----------
if (!has('skip-deploy')) {
  run('上传 feed + nginx reload', 'node', ['scripts/deploy-feed.mjs'])
}

// ---------- 3. git ----------
if (!has('skip-git')) {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  if (!status.stdout.trim()) {
    console.log('\n[ship] 工作区干净，跳过 git 提交')
  } else {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    const message = `chore(ship): 热更发布 ${pkgVersion}-hot.${seq}${note ? ' — ' + note : ''}（三通道签名产物已${has('skip-deploy') ? '生成' : '部署'}）`
    run('git 提交', 'git', ['add', '-A'])
    run('git 提交', 'git', ['commit', '-m', message])
    run(`git 推送 origin ${branch}`, 'git', ['push', 'origin', branch])
  }
}

console.log('\n[ship][DONE] 发布流水线完成')

#!/usr/bin/env node
/**
 * scripts/deploy-feed.mjs — 把 dist/feed/ 上传到 feed 服务器（docs/HOT-FEED-DEPLOY.md）
 *
 * 增量上传：先经 ssh 拿远端清单（相对路径+字节数），只 scp 缺失/尺寸不同的文件
 * （314MB 壳包未变时不重传）。env 覆盖：
 *   FEED_HOST       默认 118.31.43.156（阿里云）
 *   FEED_USER       默认 root
 *   FEED_REMOTE_DIR 默认 /var/www/agentdeck-feed
 * 用法：node scripts/deploy-feed.mjs [--dry-run] [--force]
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const FEED_DIR = path.join(root, 'dist', 'feed')
const HOST = process.env.FEED_HOST || '118.31.43.156'
const USER = process.env.FEED_USER || 'root'
const REMOTE = process.env.FEED_REMOTE_DIR || '/var/www/agentdeck-feed'
const DRY = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

if (!fs.existsSync(path.join(FEED_DIR, 'stable'))) {
  console.error(`[FAIL] ${path.relative(root, FEED_DIR)} 不存在 — 先 npm run ship 或 release:hot 产出 feed 树`)
  process.exit(1)
}

const sh = (cmd) => spawnSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], shell: true, encoding: 'utf8' })

// 本地清单
const local = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile()) local.push({ rel: path.relative(FEED_DIR, p).split(path.sep).join('/'), size: fs.statSync(p).size })
  }
}
walk(FEED_DIR)

// 远端清单（目录不存在则空）
const remoteRaw = sh(`ssh ${USER}@${HOST} "cd ${REMOTE} 2>/dev/null && find . -type f -printf '%p %s\\n' || true"`)
if (remoteRaw.status !== 0) {
  console.error(`[FAIL] ssh 取远端清单失败（退出码 ${remoteRaw.status}）— 检查免密登录`)
  process.exit(1)
}
const remote = new Map()
for (const line of remoteRaw.stdout.split('\n')) {
  const m = /^\.\/(\S+) (\d+)$/.exec(line.trim())
  if (m) remote.set(m[1], Number(m[2]))
}

const changed = FORCE ? local : local.filter((f) => remote.get(f.rel) !== f.size)
const skipped = local.length - changed.length
console.log(`[plan] 本地 ${local.length} 个文件：上传 ${changed.length}，跳过未变化 ${skipped}`)

const commands = []
if (!remote.size) commands.push(`ssh ${USER}@${HOST} "mkdir -p ${REMOTE}"`)
for (const f of changed) {
  const dir = path.posix.dirname(f.rel)
  commands.push(`ssh ${USER}@${HOST} "mkdir -p ${REMOTE}/${dir === '.' ? '' : dir}"`)
  commands.push(`scp -q ${JSON.stringify(path.join(FEED_DIR, ...f.rel.split('/')))} ${USER}@${HOST}:${REMOTE}/${f.rel}`)
}
commands.push(`ssh ${USER}@${HOST} "nginx -t 2>/dev/null && nginx -s reload || systemctl reload nginx"`)

for (const cmd of commands) {
  console.log(`[run] ${cmd.replace(JSON.stringify(FEED_DIR), 'dist/feed')}`)
  if (DRY) continue
  const r = sh(cmd)
  if (r.status !== 0) {
    console.error(r.stderr.trim().slice(0, 300))
    console.error(`[FAIL] 命令失败（退出码 ${r.status}）。排查：ssh 免密 / nginx 配置（docs/HOT-FEED-DEPLOY.md）。`)
    process.exit(r.status ?? 1)
  }
}
console.log(DRY ? '\n[dry-run] 以上命令未执行' : `\n[ok] feed 增量部署完成（${changed.length} 个文件）。客户端（设置→更新→检查更新）即可收到。`)

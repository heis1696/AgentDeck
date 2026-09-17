#!/usr/bin/env node
/**
 * scripts/deploy-feed.mjs — 把 dist/feed/ 上传到 feed 服务器（docs/HOT-FEED-DEPLOY.md）
 *
 * 零依赖：经本机 ssh/scp（OpenSSH 客户端）传输。env 覆盖：
 *   FEED_HOST       默认 118.31.43.156（阿里云）
 *   FEED_USER       默认 root
 *   FEED_REMOTE_DIR 默认 /var/www/agentdeck-feed
 * 用法：node scripts/deploy-feed.mjs [--dry-run]
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

if (!fs.existsSync(path.join(FEED_DIR, 'stable'))) {
  console.error(`[FAIL] ${path.relative(root, FEED_DIR)} 不存在 — 先 HOT_SIGNING_KEY_PATH=<私钥> npm run release:hot 产出 feed 树`)
  process.exit(1)
}

const commands = [
  `ssh ${USER}@${HOST} "mkdir -p ${REMOTE}"`,
  `scp -r ${JSON.stringify(FEED_DIR + path.sep + '*')} ${USER}@${HOST}:${REMOTE}/`,
  `ssh ${USER}@${HOST} "nginx -t && nginx -s reload"`
]

for (const cmd of commands) {
  console.log(`[run] ${cmd}`)
  if (DRY) continue
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`[FAIL] 命令失败（退出码 ${r.status}）。排查：ssh 密钥是否配好（ssh ${USER}@${HOST} 能否免密登录）、nginx 是否已按 docs/HOT-FEED-DEPLOY.md 配置。`)
    process.exit(r.status ?? 1)
  }
}
console.log(DRY ? '\n[dry-run] 以上命令未执行' : '\n[ok] feed 已上传并 reload nginx。客户端（设置→更新→检查更新）即可看到新版本。')

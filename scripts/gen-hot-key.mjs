#!/usr/bin/env node
/**
 * scripts/gen-hot-key.mjs — 热更签名密钥生成器（docs/HOT-UPDATE-IMPL-DESIGN.md §9.5）
 *
 * 程序化生成 Ed25519 密钥对：
 *   - 私钥（PKCS#8 PEM）写到仓库外的 ~/.agentdeck/hot-keys/<keyId>.pem（绝不在仓库/输出中出现）
 *   - 只打印公钥 raw hex + 需粘贴进 src/main/hot/trust.ts 的那一行
 *
 * 用法：node scripts/gen-hot-key.mjs [--key-id ad-2026-10] [--out <私钥目录>]
 * keyId 默认 ad-<当前年月>（历法命名，§9.5）。轮换流程：新 keyId 加入 TRUST_KEYS（与旧 key 并存）
 * → 随壳版本发布 → 观察一个稳定版本 → 移除旧 keyId。
 */
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const take = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const keyId = take('key-id') || `ad-${new Date().toISOString().slice(0, 7)}`
if (!/^ad-\d{4}-\d{2}(-[\w.-]+)?$/.test(keyId)) {
  console.error(`[FAIL] keyId 需形如 ad-YYYY-MM（可带后缀），收到: ${keyId}`)
  process.exit(1)
}
const outDir = take('out') || path.join(os.homedir(), '.agentdeck', 'hot-keys')

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const spki = publicKey.export({ format: 'der', type: 'spki' })
const pubHex = spki.subarray(spki.length - 32).toString('hex')

fs.mkdirSync(outDir, { recursive: true })
const privPath = path.join(outDir, `${keyId}.pem`)
if (fs.existsSync(privPath)) {
  console.error(`[FAIL] 已存在 ${privPath}（keyId 重复）— 换 --key-id 或删除旧文件`)
  process.exit(1)
}
fs.writeFileSync(privPath, privateKey.export({ format: 'pem', type: 'pkcs8' }))

console.log(`[ok] 私钥（保密，勿进仓库/聊天/网盘）: ${privPath}`)
console.log(`\n把下面这行加进 src/main/hot/trust.ts 的 TRUST_KEYS（轮换期与旧 key 并存）:\n`)
console.log(`  '${keyId}': '${pubHex}'`)
console.log(`\n之后用它签名发布:\n  HOT_SIGNING_KEY_PATH="${privPath}" npm run release:hot -- --seq <n>`)

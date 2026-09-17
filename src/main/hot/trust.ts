// 信任锚（设计 §2.3/§9.5）：Ed25519 raw 公钥（32 字节 hex）内置，keyId 支持轮换。
// 私钥只在 CI secret / 离线，绝不进仓库（§9.5）。

export const TRUST_KEYS: Record<string, string> = {
  'ad-2026-09': '7c5d7bf8b60bb01d656dc2a079405d87c5c8fa1bc3872cf8f7077bee9b165937'
}

// feed 基址占位（§5.1/§9.1）：自有域名未定，阶段 1 接 feed.ts 前由领队替换；
// 运行期可被 AppSettings.updateFeedUrl 覆盖。
export const DEFAULT_FEED_BASE = 'https://feed.agentdeck.invalid/'

const RAW_KEY_HEX = /^[0-9a-fA-F]{64}$/

/**
 * 生效信任表。env `AGENTDECK_HOT_TRUST_HEX`（格式 `keyId:hex,keyId:hex`）整体覆盖内置表，
 * 供 smoke / 测试注入临时密钥；env 存在但无一条合法条目时回退内置表。
 */
export function resolveTrustedKeys(): Record<string, string> {
  const injected = process.env.AGENTDECK_HOT_TRUST_HEX
  if (!injected) return TRUST_KEYS
  const keys: Record<string, string> = {}
  for (const part of injected.split(',')) {
    const sep = part.indexOf(':')
    if (sep <= 0) continue
    const keyId = part.slice(0, sep).trim()
    const hex = part.slice(sep + 1).trim().toLowerCase()
    if (!keyId || !RAW_KEY_HEX.test(hex)) continue
    keys[keyId] = hex
  }
  return Object.keys(keys).length > 0 ? keys : TRUST_KEYS
}

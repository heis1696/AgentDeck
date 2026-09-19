// 素材包登记：内置包随构建内联进主进程 bundle（vite json 导入），用户包扫 userData/pets/<packId>/。
// 用户包 PNG 读文件转 data URL 经 IPC 下发（帧小 KB 级，避开 file:// 与 webSecurity 的坑）；
// 坏包不抛——ok=false + reason，设置面板可见但不可用。
import fs from 'node:fs'
import path from 'node:path'
import { validatePetManifest, type PackAssets, type PetManifest, type PetPackInfo } from '../../shared/pet'
import builtinManifest from '../../renderer/src/pet/assets/default/pet.json'

export const BUILTIN_PACK_ID = 'default'
export const USER_PETS_DIR = 'pets'

// 构建期校验一次：内置包 pet.json 若坏，启动即炸在主进程（比渲染层黑屏好查）
const validatedBuiltin = validatePetManifest(builtinManifest)
if (!validatedBuiltin) throw new Error('内置桌宠素材包 pet.json 非法（构建产物损坏）')
export const BUILTIN_MANIFEST: PetManifest = validatedBuiltin

/** 包清单聚合：内置包 + userData/pets/ 下所有目录（坏包跳过并标注） */
export function listPacks(userDataDir: string): PetPackInfo[] {
  const packs: PetPackInfo[] = [{
    id: BUILTIN_PACK_ID,
    builtin: true,
    ok: true,
    frameCount: Object.values(BUILTIN_MANIFEST.states).reduce((sum, state) => sum + state.frames.length, 0)
  }]
  const root = path.join(userDataDir, USER_PETS_DIR)
  let entries: string[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
  } catch { /* 目录不存在 = 无用户包 */ }
  for (const id of entries) {
    packs.push(scanUserPack(userDataDir, id).info)
  }
  return packs
}

export interface PackScanResult {
  info: PetPackInfo
  manifest: PetManifest | null
}

/** 扫描单个用户包：pet.json 过 validatePetManifest，帧文件在库校验 */
export function scanUserPack(userDataDir: string, packId: string): PackScanResult {
  const dir = packDir(userDataDir, packId)
  const fail = (reason: string): PackScanResult => ({ info: { id: packId, builtin: false, ok: false, frameCount: 0, reason }, manifest: null })
  if (!/^[\w-]+$/.test(packId)) return fail('包 id 非法')
  let raw: string
  try {
    raw = fs.readFileSync(path.join(dir, 'pet.json'), 'utf8')
  } catch {
    return fail('缺少 pet.json')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('pet.json 不是合法 JSON')
  }
  const manifest = validatePetManifest(parsed)
  if (!manifest) return fail('pet.json 未通过 schema 校验')
  let missing = ''
  for (const state of Object.values(manifest.states)) {
    for (const frame of state.frames) {
      if (!/^[\w-]+\.png$/.test(frame)) return fail(`帧文件名非法：${frame}`)
      if (!fs.existsSync(path.join(dir, frame))) missing = missing || frame
    }
  }
  if (missing) return fail(`缺少帧文件：${missing}`)
  const frameCount = Object.values(manifest.states).reduce((sum, state) => sum + state.frames.length, 0)
  return { info: { id: packId, builtin: false, ok: true, frameCount }, manifest }
}

function packDir(userDataDir: string, packId: string): string {
  return path.join(userDataDir, USER_PETS_DIR, packId)
}

/** 读取用户包帧文件转 data URL（仅用户包；内置包由渲染层 vite 管线自带） */
export function readUserPackAssets(userDataDir: string, packId: string): PackAssets {
  const scan = scanUserPack(userDataDir, packId)
  if (!scan.manifest) throw new Error(scan.info.reason ?? '素材包不可用')
  const dir = packDir(userDataDir, packId)
  const frames: Record<string, string[]> = {}
  for (const [stateId, state] of Object.entries(scan.manifest.states)) {
    frames[stateId] = state.frames.map((frame) => {
      const png = fs.readFileSync(path.join(dir, frame))
      return `data:image/png;base64,${png.toString('base64')}`
    })
  }
  return { packId, manifest: scan.manifest, frames }
}

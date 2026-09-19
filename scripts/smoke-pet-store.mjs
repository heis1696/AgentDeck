// 桌宠配置存储 + 素材包扫描冒烟：esbuild 直连 src/main/pet/pet-store.ts 与 packs.ts。
// 覆盖：默认值、原子写持久化、环形截断、bounds 恢复、坏文件回退默认、用户包校验/data URL。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')

async function bundle(entry, name) {
  const outfile = path.join(root, 'out', name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  return import(pathToFileURL(outfile).href)
}
const { PetStore, PET_CHAT_HISTORY_CAP, PET_AUTONOMY_SEC_MIN } = await bundle('src/main/pet/pet-store.ts', 'smoke-pet-store.cjs')
const packs = await bundle('src/main/pet/packs.ts', 'smoke-pet-packs.cjs')

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

// —— 默认值 ——
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pet-'))
const store = new PetStore(dir)
const initial = store.get()
ok(initial.enabled === false, '默认不启用')
ok(initial.packId === 'default', '默认素材包 default')
ok(initial.autonomySec === 90, '自主间隔默认 90s')
ok(initial.personaPrompt === '' && initial.presetId === '' && initial.model === '', '人设/预设/模型默认空')
ok(Array.isArray(initial.chatHistory) && initial.chatHistory.length === 0, '聊天历史默认空')

// —— 原子写 + 重开持久化 ——
store.setEnabled(true)
ok(fs.existsSync(path.join(dir, 'pet.json')), '配置落盘 userData/pet.json')
ok(!fs.existsSync(path.join(dir, 'pet.json.tmp')), 'tmp+rename 无残留 .tmp')
const reopened = new PetStore(dir)
ok(reopened.get().enabled === true, '重开读取持久化配置')

// —— 环形截断 ——
for (let i = 0; i < 25; i++) store.appendChat({ role: 'user', text: `消息 ${i}` })
let history = store.get().chatHistory
ok(history.length === PET_CHAT_HISTORY_CAP, `环形截断到 ${PET_CHAT_HISTORY_CAP}（got ${history.length}）`)
ok(history[history.length - 1].text === '消息 24' && history[0].text === '消息 5', '截断保留最新一端')
ok(new PetStore(dir).get().chatHistory.length === PET_CHAT_HISTORY_CAP, '截断结果持久化')

// —— clamp 与 bounds ——
store.setAutonomy(5)
ok(store.get().autonomySec === PET_AUTONOMY_SEC_MIN, `自主间隔下限钳 ${PET_AUTONOMY_SEC_MIN}s`)
store.setBounds({ x: 120, y: 240 })
ok(new PetStore(dir).get().bounds.x === 120, 'bounds 持久化恢复')
store.setPreset('pst_x', 'claude-3-5-haiku')
const preset = new PetStore(dir).get()
ok(preset.presetId === 'pst_x' && preset.model === 'claude-3-5-haiku', '预设与模型持久化')
store.setPersona('你是测试人设')
ok(new PetStore(dir).get().personaPrompt === '你是测试人设', '人设持久化')

// —— 坏文件回退默认 ——
fs.writeFileSync(path.join(dir, 'pet.json'), '{corrupt!!!')
const recovered = new PetStore(dir).get()
ok(recovered.enabled === false && recovered.autonomySec === 90, '坏 JSON 回退默认值')
// 历史里混入坏条目被过滤
fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({ ...recovered, chatHistory: [{ role: 'user', text: 'ok', at: 1 }, { role: 'nope', text: 3 }] }))
ok(new PetStore(dir).get().chatHistory.length === 1, '非法历史条目被过滤')

// —— 用户素材包扫描 + data URL 下发 ——
const petsRoot = path.join(dir, 'pets')
const goodDir = path.join(petsRoot, 'goodpack')
fs.cpSync(path.join(root, 'src/renderer/src/pet/assets/default'), goodDir, { recursive: true })
fs.mkdirSync(path.join(petsRoot, 'badpack'), { recursive: true })
fs.writeFileSync(path.join(petsRoot, 'badpack', 'pet.json'), '{"frameSize":[64]}') // 缺七态
const listed = packs.listPacks(dir)
const good = listed.find((item) => item.id === 'goodpack')
const bad = listed.find((item) => item.id === 'badpack')
ok(listed.some((item) => item.id === 'default' && item.builtin), '内置包始终在列')
ok(good && good.ok === true && good.frameCount === 16, `好包登记（${good && good.frameCount} 帧）`)
ok(bad && bad.ok === false && !!bad.reason, `坏包跳过并标注原因（${bad && bad.reason}）`)
const assets = packs.readUserPackAssets(dir, 'goodpack')
ok(assets.manifest.frameSize[0] === 64 && assets.frames.idle.length === 3, '用户包 manifest 读取')
ok(assets.frames.idle.every((url) => url.startsWith('data:image/png;base64,')), '帧转 data URL 下发')
let threw = false
try { packs.readUserPackAssets(dir, 'badpack') } catch { threw = true }
ok(threw, '坏包读帧抛错（controller 层转 null）')

if (failed) { console.error(`\n❌ PET STORE SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET STORE SMOKE PASSED')

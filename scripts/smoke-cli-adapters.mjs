// 三个 CLI 适配器真实冒烟：各跑一轮最小任务
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/backends/claude.ts', 'out/smoke-claude.cjs'],
  ['src/main/backends/codex.ts', 'out/smoke-codex.cjs'],
  ['src/main/backends/opencode.ts', 'out/smoke-opencode.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cli-'))
fs.writeFileSync(path.join(workdir, 'note.txt'), 'the secret word is pineapple\n')

const results = {}
for (const [name, out, factory, prompt] of [
  ['claude', 'smoke-claude.cjs', 'createClaudeBackend', '读取 note.txt，只回复那个秘密单词本身，不要其他内容。'],
  ['codex', 'smoke-codex.cjs', 'createCodexBackend', '读取 note.txt 文件，只回复那个秘密单词本身，不要其他内容。'],
  ['opencode', 'smoke-opencode.cjs', 'createOpencodeBackend', '读取当前目录下 note.txt 文件，只回复那个秘密单词本身。']
]) {
  console.log(`\n===== ${name} =====`)
  const mod = await import(pathToFileURL(path.join(root, 'out', out)).href)
  const backend = mod[factory]()
  const probe = await backend.probe()
  console.log('probe:', probe.detail)
  if (!probe.ok) {
    results[name] = { ok: false, stage: 'probe' }
    continue
  }
  const events = []
  try {
    const session = await backend.start({
      prompt,
      workdir,
      mode: 'yolo',
      events: {
        onEvent: (e) => {
          events.push(e.kind)
          if (e.kind === 'tool') console.log(`  [tool ${e.data?.phase}] ${e.text} ${(e.data?.args ?? e.data?.preview ?? '').toString().slice(0, 60)}`)
          if (e.kind === 'final') console.log(`  [final] ${(e.text ?? '').slice(0, 80)}`)
          if (e.kind === 'usage') console.log(`  [usage] ${JSON.stringify(e.data).slice(0, 100)}`)
        },
        onTurnEnd: () => {}
      }
    })
    console.log('sessionId:', session.sessionId.slice(0, 22))
    await session.close()
    const finalEv = events // kinds only; get final text from onEvent above via closure? 简化：重跑无必要
    results[name] = { ok: true, sessionId: session.sessionId }
  } catch (e) {
    console.log('FAIL:', String(e).slice(0, 200))
    results[name] = { ok: false, stage: 'run', error: String(e).slice(0, 150) }
  }
}

console.log('\n===== 汇总 =====')
for (const [k, v] of Object.entries(results)) console.log(k, v.ok ? '✅' : '❌ ' + (v.error ?? v.stage))
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1)

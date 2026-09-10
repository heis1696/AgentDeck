import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-opencode-real.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/opencode.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createOpencodeBackend } = await import(pathToFileURL(outfile).href)
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-opencode-real-'))
fs.writeFileSync(path.join(workdir, 'note.txt'), 'the secret word is pineapple\n')
const backend = createOpencodeBackend()
const probe = await backend.probe()
if (!probe.ok) throw new Error(`OpenCode unavailable: ${probe.detail}`)
let final = ''
const session = await backend.start({
  prompt: 'Reply with only the word pineapple.', workdir, mode: 'build',
  events: { onEvent: (event) => { if (event.kind === 'final') final = event.text ?? '' }, onTurnEnd: () => {} }
})
await session.close()
if (!/pineapple/i.test(final)) throw new Error(`unexpected OpenCode response: ${final.slice(0, 200)}`)
console.log(`✓ real OpenCode server smoke (${probe.detail})`)

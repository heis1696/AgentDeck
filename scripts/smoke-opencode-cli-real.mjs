import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-opencode-cli-real.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/opencode.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { createOpencodeBackend } = await import(pathToFileURL(outfile).href)
const backend = createOpencodeBackend({ cliOnly: true })
const probe = await backend.probe()
if (!probe.ok) throw new Error(`OpenCode CLI unavailable: ${probe.detail}`)
let final = ''
const session = await backend.start({
  prompt: 'Reply with only the word pineapple.', workdir: root, mode: 'build',
  events: { onEvent: (event) => { if (event.kind === 'final') final = event.text ?? '' }, onTurnEnd: () => {} }
})
await session.close()
if (!/pineapple/i.test(final)) throw new Error(`unexpected OpenCode CLI response: ${final.slice(0, 200)}`)
console.log(`✓ real OpenCode CLI fallback smoke (${probe.detail})`)

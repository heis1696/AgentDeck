import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { deployFeed, planDeployment } from './deploy-feed.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-deploy-feed-'))
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex')
const artifact = { rel: 'stable/payload/payload-0.23.1-hot.1.zip', sha256: digest('artifact') }
const manifest = { rel: 'stable/payload/manifest.json', sha256: digest('manifest') }
try {
  const plan = planDeployment([manifest, artifact], new Map(), '/var/www/feed', 'fixture')
  assert.deepEqual(plan.publish.map((file) => file.rel), [artifact.rel, manifest.rel])
  assert.equal(planDeployment([artifact], new Map([[artifact.rel, artifact.sha256]]), '/var/www/feed', 'fixture', true).changed.length, 1)
  assert.throws(() => planDeployment([artifact], new Map([[artifact.rel, digest('old')]]), '/var/www/feed', 'fixture'), /immutable remote artifact differs/)
  assert.throws(() => planDeployment([{ ...artifact, rel: '../escape.zip' }], new Map(), '/var/www/feed', 'fixture'), /unsafe feed path/)
  assert.throws(() => planDeployment([], new Map(), '/', 'fixture'))
  assert.throws(() => planDeployment([], new Map(), '/var/www/../feed', 'fixture'))
  for (const [relative, bytes] of [[manifest.rel, 'manifest'], [artifact.rel, 'artifact'], ['versions/payload/0.23.1-hot.1/payload-0.23.1-hot.1.zip', 'artifact']]) {
    const file = path.join(directory, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }
  const calls = []
  const execute = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: '' } }
  deployFeed({ env: { FEED_LOCAL_DIR: directory }, execute, releaseId: 'fixture' })
  assert.equal(calls.filter((call) => call.command === 'scp').length, 2, 'identical archive bytes upload only once')
  const lastUpload = calls.findLastIndex((call) => call.command === 'scp')
  const firstPublish = calls.findIndex((call) => /mv -f|if test -e/.test(call.args.at(-1)))
  assert.ok(firstPublish > lastUpload, 'all uploads and hashes finish before publication')
  assert.match(calls.at(-1).args.at(-1), /mv -f.*stable\/payload\/manifest\.json/)
  assert.ok(calls.some((call) => /sha256sum/.test(call.args.at(-1))))
  const failed = []
  assert.throws(() => deployFeed({ env: { FEED_LOCAL_DIR: directory }, releaseId: 'failure', execute: (command, args) => {
    failed.push({ command, args })
    return { status: /test .*sha256sum/.test(args.at(-1)) ? 1 : 0, stdout: '' }
  } }), /deployment command failed/)
  assert.equal(failed.some((call) => /mv -f|if test -e/.test(call.args.at(-1))), false, 'upload hash failure leaves stable untouched')
  const dry = []
  deployFeed({ env: { FEED_LOCAL_DIR: directory }, releaseId: 'dry', dry: true, execute: (command, args) => { dry.push({ command, args }); return { status: 0, stdout: '' } } })
  assert.equal(dry.length, 1, 'dry run only reads the remote inventory')
  console.log('PASS feed deployment ordering, immutable collisions, path validation, hash failure, deduplication and dry run')
} finally {
  assert.ok(path.dirname(directory) === fs.realpathSync(os.tmpdir()) || path.dirname(directory) === path.resolve(os.tmpdir()))
  fs.rmSync(directory, { recursive: true, force: true })
}

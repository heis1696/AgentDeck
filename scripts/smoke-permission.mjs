import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-permission.cjs')
await build({ entryPoints: [path.join(root, 'src/main/permission-broker.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { PermissionBroker } = await import(pathToFileURL(outfile).href)
const request = (id) => ({ requestId: id, toolName: 'Shell', reason: 'test', riskLevel: 'low', options: [{ optionId: 'allow', name: 'Allow', response: { decision: 'allow' } }] })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sent = []
const broker = new PermissionBroker((taskId, req) => sent.push({ taskId, req }), 30)

const first = broker.ask('task-a', request('one'))
if (sent.length !== 1) throw new Error('permission request was not published')
if (!broker.resolve('one', 'allow', 'allow').ok) throw new Error('permission response was not accepted')
if ((await first).decision !== 'allow') throw new Error('permission response did not resolve')

const duplicate = broker.ask('task-b', request('two'))
const replacement = broker.ask('task-b', request('two'))
if ((await duplicate).decision !== 'deny') throw new Error('duplicate request was not denied')
if ((await replacement).decision !== 'deny') throw new Error('replacement request did not time out')

const cancelled = broker.ask('task-c', request('three'))
broker.cancelTask('task-c')
if ((await cancelled).decision !== 'deny') throw new Error('task cancellation did not deny request')

// Changing task content invalidates an outstanding approval snapshot.
const versioned = broker.ask('task-v', request('versioned'), 'v1')
broker.setWorkVersion('task-v', 'v2')
if ((await versioned).decision !== 'deny') throw new Error('workVersion change did not deny stale request')
if (broker.resolve('versioned', 'allow', 'allow').ok) throw new Error('stale workVersion approval was accepted')
const crossTask = broker.ask('task-x', request('shared-id'), 'v1')
const crossTaskRejected = broker.ask('task-y', request('shared-id'), 'v1')
if ((await crossTaskRejected).decision !== 'deny') throw new Error('cross-task request id was not rejected')
if (broker.resolve('shared-id', 'allow', 'allow').ok) throw new Error('cross-task request id could authorize stale task')
if ((await crossTask).decision !== 'deny') throw new Error('ambiguous cross-task request did not fail closed')
await wait(5)
console.log('✓ response, duplicate, timeout, cancellation, workVersion and task binding boundaries')
console.log('✅ PERMISSION SMOKE PASSED')

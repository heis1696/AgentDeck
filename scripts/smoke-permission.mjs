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
const pendingSnapshot = broker.pendingFor('task-a')
if (pendingSnapshot.length !== 1 || !pendingSnapshot[0].requestedAt || pendingSnapshot[0].expiresAt - pendingSnapshot[0].requestedAt !== 30) throw new Error('pending snapshot lacks authoritative timing')
if (!broker.resolve('one', 'allow', 'allow').ok) throw new Error('permission response was not accepted')
if ((await first).decision !== 'allow') throw new Error('permission response did not resolve')
if (broker.pendingFor('task-a').length || sent.at(-1).req.resolution !== 'answered') throw new Error('resolved request was not removed and published')

const duplicate = broker.ask('task-b', request('two'))
const replacement = broker.ask('task-b', request('two'))
if ((await duplicate).decision !== 'deny') throw new Error('duplicate request was not denied')
if ((await replacement).decision !== 'deny') throw new Error('replacement request did not time out')
if (sent.at(-1).req.resolution !== 'expired') throw new Error('timeout was not published to the UI')

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
const tokenBroker = new PermissionBroker(() => {}, 1000)
const oldRequest = tokenBroker.ask('token-task', request('same-id'))
const oldToken = tokenBroker.pendingFor('token-task')[0].requestToken
const newRequest = tokenBroker.ask('token-task', request('same-id'))
if ((await oldRequest).decision !== 'deny') throw new Error('replaced permission was not denied')
if (tokenBroker.resolve('same-id', 'allow', 'allow', undefined, oldToken).ok) throw new Error('old request token authorized its replacement')
if (tokenBroker.resolve('same-id', 'missing', 'allow').ok) throw new Error('unknown approval option was accepted')
if (tokenBroker.pendingFor('token-task').length !== 1) throw new Error('invalid answer removed a pending approval')
if (!tokenBroker.resolve('same-id', '__agentdeck_deny__', 'deny').ok || (await newRequest).decision !== 'deny') throw new Error('explicit denial without a provider deny option failed')
tokenBroker.shutdown()
const closingBroker = new PermissionBroker((_id, pending) => { if (pending.resolution) throw new Error('renderer closed') }, 1000)
const closeA = closingBroker.ask('closing-a', request('closing-a'))
const closeB = closingBroker.ask('closing-b', request('closing-b'))
closingBroker.shutdown()
if ((await closeA).decision !== 'deny' || (await closeB).decision !== 'deny') throw new Error('renderer teardown interrupted permission settlement')
await wait(5)
console.log('✓ response, duplicate, timeout, cancellation, workVersion and task binding boundaries')
console.log('✅ PERMISSION SMOKE PASSED')

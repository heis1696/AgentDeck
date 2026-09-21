import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dataDir = process.argv[2]
const bundleDir = process.env.AGENTDECK_PERSISTENCE_BUNDLE_DIR
if (!dataDir || !bundleDir) throw new Error('persistence worker requires data dir and bundle dir')

const [{ TaskStore }, { IssueStore }, { TaskService }] = await Promise.all([
  import(pathToFileURL(path.join(bundleDir, 'store.cjs')).href),
  import(pathToFileURL(path.join(bundleDir, 'issue-store.cjs')).href),
  import(pathToFileURL(path.join(bundleDir, 'task-service.cjs')).href)
])

const store = new TaskStore(dataDir, { recoverRunning: false })
const issueStore = new IssueStore(dataDir)
const service = new TaskService({ store, issueStore })
const { currentProcessIdentity } = await import(pathToFileURL(path.join(bundleDir, 'persistence.cjs')).href)

const reply = (id, value, error) => {
  process.stdout.write(`${JSON.stringify(error ? { id, error: String(error.stack || error) } : { id, value })}\n`)
}

async function handle(request) {
  switch (request.op) {
    case 'append-exit':
      store.appendEvent(request.taskId, { ts: Date.now(), kind: 'status', text: 'exit before delayed flush' })
      process.exit(0)
    case 'fault-snapshot': {
      const snapshot = path.join(dataDir, 'tasks', request.taskId, 'task.json')
      const fail = () => { throw Object.assign(new Error('injected snapshot ' + request.fault), { code: 'EIO' }) }
      if (request.fault === 'write') {
        const write = fs.writeFileSync
        fs.writeFileSync = (file, ...args) => typeof file === 'string' && file.startsWith(snapshot + '.') ? fail() : write(file, ...args)
      } else if (request.fault === 'fsync') {
        const descriptors = new Set()
        const open = fs.openSync
        const sync = fs.fsyncSync
        fs.openSync = (file, ...args) => {
          const fd = open(file, ...args)
          if (typeof file === 'string' && file.startsWith(snapshot + '.')) descriptors.add(fd)
          else descriptors.delete(fd)
          return fd
        }
        fs.fsyncSync = (fd) => descriptors.has(fd) ? fail() : sync(fd)
      } else {
        const rename = fs.renameSync
        fs.renameSync = (from, to) => to === snapshot ? fail() : rename(from, to)
      }
      store.update(request.taskId, request.patch)
      return store.get(request.taskId)
    }
    case 'fault-delete': {
      const target = path.join(dataDir, 'tasks', request.taskId)
      const remove = fs.rmSync
      fs.rmSync = (file, ...args) => {
        if (file === target) throw Object.assign(new Error('injected directory deletion'), { code: 'EIO' })
        return remove(file, ...args)
      }
      store.delete(request.taskId)
      return !store.get(request.taskId)
    }
    case 'claim': {
      const current = store.get(request.taskId)
      return store.claimRun(request.taskId, { status: 'queued', runId: current?.runId, executionOwner: current?.executionOwner }, request.runId, { ...currentProcessIdentity(), token: 'worker-' + process.pid })
    }
    case 'create':
      return service.create(request.input)
    case 'update':
      store.update(request.taskId, request.patch)
      return store.get(request.taskId)
    case 'delete':
      store.delete(request.taskId)
      return true
    case 'snapshot':
      return store.get(request.taskId)
    case 'project-stale':
      issueStore.sync([request.task])
      return issueStore.get(request.task.issueId ?? `iss_${request.task.id}`)
    case 'add-comment':
      return issueStore.addComment(request.issueId, request.content)
    case 'metadata':
      return issueStore.updateMetadata(request.issueId, request.patch)
    case 'workflow':
      return issueStore.updateWorkflow(request.issueId, request.status)
    case 'inspect':
      issueStore.sync(store.list())
      return {
        tasks: store.list(),
        issues: issueStore.list(),
        comments: issueStore.list().flatMap((issue) => issueStore.comments(issue.id))
      }
    case 'flush':
      store.flush()
      return true
    default:
      throw new Error(`unknown persistence worker op: ${request.op}`)
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', async (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
    const value = await handle(request)
    reply(request.id, value)
  } catch (error) {
    reply(request?.id ?? null, undefined, error)
  }
})

process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`)

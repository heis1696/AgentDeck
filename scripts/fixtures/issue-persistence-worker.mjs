import readline from 'node:readline'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dataDir = process.argv[2]
const bundle = process.env.AGENTDECK_ISSUE_PERSISTENCE_BUNDLE
if (!dataDir || !bundle) throw new Error('issue persistence worker requires data dir and bundle')

const { IssueStore } = await import(pathToFileURL(bundle).href)
const store = new IssueStore(dataDir)

function reply(id, value, error) {
  process.stdout.write(`${JSON.stringify(error ? { id, error: String(error.stack || error) } : { id, value })}\n`)
}

async function handle(request) {
  switch (request.op) {
    case 'sync':
      store.sync(request.tasks)
      return store.list()
    case 'comment':
      return store.addComment(request.issueId, request.content)
    case 'metadata':
      return store.updateMetadata(request.issueId, request.patch)
    case 'workflow':
      return store.updateWorkflow(request.issueId, request.status)
    case 'delete':
      return store.deleteIssue(request.issueId)
    case 'inspect':
      return { issues: store.list(), runs: request.issueId ? store.runs(request.issueId) : [], comments: request.issueId ? store.comments(request.issueId) : [] }
    default:
      throw new Error(`unknown issue persistence operation: ${request.op}`)
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', async (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
    reply(request.id, await handle(request))
  } catch (error) {
    reply(request?.id ?? null, undefined, error)
  }
})

process.stdout.write(`${JSON.stringify({ ready: true })}\n`)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUN_TIMEOUT_MS = 900_000
const MEETING_BUDGET_MS = 720_000
const STOP_SETTLE_MS = 10_000
const BACKENDS = {
  claude: { source: 'src/main/backends/claude.ts', factory: 'createClaudeBackend' },
  codex: { source: 'src/main/backends/codex.ts', factory: 'createCodexBackend' },
  opencode: { source: 'src/main/backends/opencode.ts', factory: 'createOpencodeBackend' }
}

function parseArgs(args) {
  let backend = process.env.MEETING_REAL_BACKEND?.trim().toLowerCase() || ''
  let probeOnly = true
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--probe-only') probeOnly = true
    else if (arg === '--run-real') probeOnly = false
    else if (arg === '--backend') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--backend requires a backend id')
      backend = value.trim().toLowerCase()
      index += 1
    } else if (arg.startsWith('--backend=')) backend = arg.slice('--backend='.length).trim().toLowerCase()
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return { backend, probeOnly, help }
}

function printHelp() {
  console.log([
    'Real-platform meeting fixture (no production AgentDeck userData/workdir).',
    '',
    'Safe probe only:',
    '  node scripts/smoke-meeting-real.mjs --backend codex --probe-only',
    '',
    'Explicitly start one real meeting:',
    '  node scripts/smoke-meeting-real.mjs --backend claude --run-real',
    '  MEETING_REAL_BACKEND=claude node scripts/smoke-meeting-real.mjs --run-real',
    '',
    'Supported meeting adapters: claude, codex, opencode. DSH is rejected by the',
    'meeting controller; ZCode probing/start may read or write ~/.zcode config.',
    'Real mode permits claude or codex. The fixture-only backend removes resume',
    'and bypass flags and limits calls. Claude verifies an empty tool catalogue',
    'and applies per-call cost thresholds; Codex uses read-only policy, disables',
    'listed capabilities, and rejects non-text tool items. This is not OS read',
    'isolation or a guarantee that every built-in tool is unavailable.',
    'It uses a stable logical in-memory session and declares no resume support;',
    'each CLI invocation gets a fresh provider session and full host context.',
    'Probe mode can inspect the other listed adapters without starting a model.'
  ].join('\n'))
}

async function bundle(source, outfile) {
  const safeClaude = source === 'src/main/backends/claude.ts'
  const safeCodex = source === 'src/main/backends/codex.ts'
  let transformed = false
  await build({
    entryPoints: [path.join(ROOT, source)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    plugins: safeClaude || safeCodex ? [{ name: 'text-only-meeting-fixture', setup(plugin) {
      plugin.onLoad({ filter: /[/\\]backends[/\\](claude|codex)\.ts$/ }, (args) => {
        let contents = fs.readFileSync(args.path, 'utf8')
        if (safeCodex) {
          const start = contents.indexOf('    const common =')
          const end = contents.indexOf('    let sessionId =', start)
          if (start < 0 || end < start || !contents.includes('    supportsResume: true,') || !contents.includes('          sessionId = jsonString(j.thread_id, sessionId)')) throw new Error('Cannot verify Codex fixture safety transform')
          contents = contents.slice(0, start) + `    const state = globalThis as unknown as { meetingFixtureCalls?: number; meetingFixtureCodexHome?: string }
    if (!state.meetingFixtureCodexHome) throw new Error('Missing isolated Codex configuration')
    state.meetingFixtureCalls = (state.meetingFixtureCalls ?? 0) + 1
    if (state.meetingFixtureCalls > 9) throw new Error('Real meeting call budget exhausted')
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'multi_agent', '--disable', 'plugins', '--disable', 'apps',
      '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'browser_use_full_cdp_access', '--disable', 'view_image',
      '--disable', 'skill_search', '--disable', 'memories', '--disable', 'sleep_tool',
      ...(model ? ['-m', model] : []), prompt]
` + contents.slice(end)
          contents = contents.replace('          sessionId = jsonString(j.thread_id, sessionId)', '          sessionId = resumeSessionId || jsonString(j.thread_id, sessionId)')
          contents = contents.replace('    supportsResume: true,', '    supportsResume: false,')
          contents = contents.replace('      cwd: workdir,', '      cwd: workdir,\n      env: { CODEX_HOME: state.meetingFixtureCodexHome },')
          contents = contents.replace('        const j = obj', `        const j = obj
        const audit = globalThis as unknown as { meetingFixtureProviderSessions?: unknown[]; meetingFixtureResults?: unknown[]; meetingFixtureUnexpectedTools?: unknown[] }
        if (j.type === 'thread.started') {
          audit.meetingFixtureProviderSessions ??= []
          audit.meetingFixtureProviderSessions.push(j.thread_id)
        }
        if ((j.type === 'item.started' || j.type === 'item.completed') && !['agent_message', 'reasoning'].includes(jsonString(jsonObject(j.item).type))) {
          audit.meetingFixtureUnexpectedTools ??= []
          audit.meetingFixtureUnexpectedTools.push(jsonObject(j.item).type)
          finish(false, '', 'Unexpected tool or non-text item in read-only fixture')
          void runner.kill()
          return
        }
        if (j.type === 'turn.completed' || j.type === 'turn.failed') {
          audit.meetingFixtureResults ??= []
          audit.meetingFixtureResults.push({ subtype: j.type, isError: j.type === 'turn.failed', usage: j.usage, error: j.error })
        }`)
          transformed = true
          return { contents, loader: 'ts' }
        }
        const start = contents.indexOf('    const args = [')
        const end = contents.indexOf("    let sessionId =", start)
        if (start < 0 || end < start) throw new Error('Cannot verify Claude fixture safety transform')
        const safeArgs = `    const fixtureGlobal = globalThis as unknown as { meetingFixtureCalls?: number }
    fixtureGlobal.meetingFixtureCalls = (fixtureGlobal.meetingFixtureCalls ?? 0) + 1
    if (fixtureGlobal.meetingFixtureCalls > 9) throw new Error('Real meeting call budget exhausted')
    let fixtureToolCatalogueVerified = false
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', '本次仅做无工具小议题联调。请简洁作答，说明正文不超过180个汉字。必须遵守本轮会议协议；如要求纪要，给出唯一JSON对象；表态标记只能出现在整条回复最后一行。不同意、信息不足时如实表态，不要为通过测试而同意。',
      '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--setting-sources', 'user',
      '--permission-mode', 'plan', '--permission-prompts', 'none', '--no-session-persistence',
      '--max-turns', '4', '--max-budget-usd', '0.25', '--effort', 'low',
      ...(model ? ['--model', model] : [])]
`
        contents = contents.slice(0, start) + safeArgs + contents.slice(end)
        const sessionBinding = '          sessionId = jsonString(j.session_id, sessionId)'
        if (!contents.includes(sessionBinding) || !contents.includes('    supportsResume: true,')) throw new Error('Cannot verify stateless fixture session binding')
        contents = contents.replace(sessionBinding, '          sessionId = resumeSessionId || jsonString(j.session_id, sessionId)')
        contents = contents.replace('    supportsResume: true,', '    supportsResume: false,')
        contents = contents.replace('        const j = obj', `        const j = obj
        if (j.type === 'system' && j.subtype === 'init') {
          const state = globalThis as unknown as { meetingFixtureTools?: unknown[]; meetingFixtureModels?: unknown[] }
          state.meetingFixtureTools ??= []
          state.meetingFixtureTools.push(j.tools)
          state.meetingFixtureModels ??= []
          state.meetingFixtureModels.push(j.model)
          const sessions = globalThis as unknown as { meetingFixtureProviderSessions?: unknown[] }
          sessions.meetingFixtureProviderSessions ??= []
          sessions.meetingFixtureProviderSessions.push(j.session_id)
          if (!Array.isArray(j.tools) || j.tools.length) {
            finish(false, '', 'Text-only fixture tool catalogue is not empty')
            void runner.kill()
            return
          }
          fixtureToolCatalogueVerified = true
        }
        if ((j.type === 'assistant' || j.type === 'result') && !fixtureToolCatalogueVerified) {
          finish(false, '', 'Missing verified empty CLI tool catalogue')
          void runner.kill()
          return
        }
        if (j.type === 'result') {
          const state = globalThis as unknown as { meetingFixtureResults?: unknown[] }
          state.meetingFixtureResults ??= []
          state.meetingFixtureResults.push({ subtype: j.subtype, isError: j.is_error, numTurns: j.num_turns, costUsd: j.total_cost_usd, resultPreview: typeof j.result === 'string' ? j.result.slice(0, 160) : undefined, resultTail: typeof j.result === 'string' ? j.result.slice(-200) : undefined, errors: j.errors })
        }`)
        transformed = true
        return { contents, loader: 'ts' }
      })
    } }] : []
  })
  if ((safeClaude || safeCodex) && !transformed) throw new Error('Refusing unverified real CLI adapter')
  return import(pathToFileURL(outfile).href)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function prepareCodexFixture(fixtureRoot) {
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const fixtureHome = path.join(fixtureRoot, 'codex-home')
  fs.mkdirSync(fixtureHome, { recursive: true })
  const configFile = path.join(sourceHome, 'config.toml')
  const lines = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8').split(/\r?\n/) : []
  const rootLines = lines.slice(0, lines.findIndex((line) => /^\s*\[/.test(line)) < 0 ? lines.length : lines.findIndex((line) => /^\s*\[/.test(line)))
  const providerLine = rootLines.find((line) => /^\s*model_provider\s*=/.test(line))
  const modelLine = rootLines.find((line) => /^\s*model\s*=/.test(line))
  const provider = providerLine?.match(/=\s*['"]([A-Za-z0-9_-]+)['"]/)?.[1]
  const selected = [modelLine, providerLine].filter(Boolean)
  if (provider && provider !== 'openai') {
    const section = lines.findIndex((line) => line.trim() === `[model_providers.${provider}]`)
    if (section < 0) throw new Error('Selected Codex provider cannot be isolated safely')
    const nextSection = lines.findIndex((line, index) => index > section && /^\s*\[/.test(line))
    selected.push(...lines.slice(section, nextSection < 0 ? lines.length : nextSection))
  }
  fs.writeFileSync(path.join(fixtureHome, 'config.toml'), selected.join('\n'))
  const sourceAuth = path.join(sourceHome, 'auth.json')
  if (fs.existsSync(sourceAuth)) fs.copyFileSync(sourceAuth, path.join(fixtureHome, 'auth.json'))
  globalThis.meetingFixtureCodexHome = fixtureHome
  return { settings: 'isolated routing only; no plugins/MCP/hooks', configuredModel: modelLine?.match(/=\s*['"]([^'"]+)['"]/)?.[1] }
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  return Promise.race([
    promise.then((value) => ({ kind: 'completed', value }), (error) => ({ kind: 'error', error })),
    timeout
  ]).finally(() => clearTimeout(timer))
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(errorText(error))
    printHelp()
    process.exitCode = 2
    return
  }
  if (options.help) return printHelp()
  if (!options.backend) {
    console.error('Select a real backend with --backend or MEETING_REAL_BACKEND.')
    printHelp()
    process.exitCode = 2
    return
  }
  if (options.backend === 'dsh') {
    console.error('DSH is not supported by the current MeetingController session-resume contract.')
    process.exitCode = 2
    return
  }
  if (options.backend === 'zcode') {
    console.error('ZCode probe/start can read or write ~/.zcode production configuration; refusing to touch it.')
    process.exitCode = 2
    return
  }
  const backendSpec = BACKENDS[options.backend]
  if (!backendSpec) {
    console.error(`Unsupported backend: ${options.backend}`)
    printHelp()
    process.exitCode = 2
    return
  }

  if (!options.probeOnly && !['claude', 'codex'].includes(options.backend)) {
    console.error('Real mode only permits the verified Claude or read-only Codex fixture backend.')
    process.exitCode = 2
    return
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meeting-real-'))
  const userDataDir = path.join(fixtureRoot, 'user-data')
  const workdir = path.join(fixtureRoot, 'workdir')
  const bundleDir = path.join(fixtureRoot, 'bundles')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(workdir, { recursive: true })
  fs.mkdirSync(bundleDir, { recursive: true })

  const report = {
    backend: options.backend,
    mode: options.probeOnly ? 'probe-only' : 'real-meeting',
    limits: { members: 2, rounds: 1, innerTurns: 1, meetingMs: MEETING_BUDGET_MS, wallClockMs: RUN_TIMEOUT_MS },
    fixtureMembers: ['fixture-reporter', 'fixture-designer'],
    safety: { tools: [], mcpServers: [], hooks: false, skills: false, sessionPersistence: false, supportsResume: false, sessionIdentity: 'logical-in-memory', permissionBypass: false, maxCalls: 9, maxTurnsPerInvocation: 4, budgetUsdPerInvocation: 0.25, budgetUsdTotal: 2.25 }
  }
  if (options.backend === 'codex') report.safety = { sandbox: 'read-only', shell: false, browser: false, plugins: false, mcpServers: [], hooks: false, skills: false, sessionPersistence: false, supportsResume: false, sessionIdentity: 'logical-in-memory', permissionBypass: false, maxCalls: 9, rejectUnexpectedTools: true }
  let taskStore
  let runner
  let offices
  let controller
  let meeting
  let meetingStore
  let observedRun
  let runFinished = true
  let cleanupError
  const capturedSpeeches = []

  try {
    if (!options.probeOnly && options.backend === 'codex') report.configuration = prepareCodexFixture(fixtureRoot)
    const [backendModule, { MeetingController, parseStance }, meetingStoreModule, { AgentSessionRegistry }, { TaskStore }, { TaskService }, { TaskRunner }] = await Promise.all([
      bundle(backendSpec.source, path.join(bundleDir, 'selected-backend.cjs')),
      bundle('src/main/meeting-controller.ts', path.join(bundleDir, 'meeting-controller.cjs')),
      bundle('src/main/meeting-store.ts', path.join(bundleDir, 'meeting-store.cjs')),
      bundle('src/main/agent-sessions.ts', path.join(bundleDir, 'agent-sessions.cjs')),
      bundle('src/main/store.ts', path.join(bundleDir, 'store.cjs')),
      bundle('src/main/task-service.ts', path.join(bundleDir, 'task-service.cjs')),
      bundle('src/main/runner.ts', path.join(bundleDir, 'runner.cjs'))
    ])
    const backend = options.backend === 'opencode'
      ? backendModule[backendSpec.factory]({ cliOnly: true })
      : backendModule[backendSpec.factory]()
    const probe = await backend.probe()
    report.probe = probe
    if (!probe.ok) {
      report.status = 'backend-unavailable'
      process.exitCode = 1
    } else if (options.probeOnly) report.status = 'probe-ok'
    else {
      const { MeetingStore } = meetingStoreModule
      taskStore = new TaskStore(userDataDir, { recoverRunning: false })
      const taskService = new TaskService({ store: taskStore })
      const agents = [
        {
          id: 'fixture-reporter',
          name: 'Fixture Reporter',
          backend: options.backend,
          role: '队长',
          subordinates: [],
          thinking: 'off',
          ...(process.env.MEETING_REAL_MODEL ? { model: process.env.MEETING_REAL_MODEL } : {}),
          systemPrompt: '仅以简短中文讨论“测试夹具是否保持隔离”。本会仅为临时联调：严禁委派、调查、咨询、网络访问、运行命令或使用任何工具；严禁读取、创建、修改或删除任何文件。给出观点及依据。每次发言必须以单独一行 <stance verdict=\u0022agree\u0022 grounds=\u0022简短依据\u0022/> 结束。'
        },
        {
          id: 'fixture-designer',
          name: 'Fixture Designer',
          backend: options.backend,
          role: '队长',
          subordinates: [],
          thinking: 'off',
          ...(process.env.MEETING_REAL_MODEL ? { model: process.env.MEETING_REAL_MODEL } : {}),
          systemPrompt: '仅以简短中文讨论“测试夹具是否保持隔离”。本会仅为临时联调：严禁委派、调查、咨询、网络访问、运行命令或使用任何工具；严禁读取、创建、修改或删除任何文件。综合时先输出符合会议 schema 的 JSON 对象，字段为 decisions、objections、actionItems、openQuestions，再以单独一行 <stance verdict=\u0022agree\u0022 grounds=\u0022简短依据\u0022/> 结束。'
        }
      ]
      runner = new TaskRunner(taskStore, new Map([[backend.id, backend]]), () => ({
        concurrency: 2,
        workerConcurrency: 1,
        mode: 'plan',
        notify: false,
        maxRetryAttempts: 0
      }))
      runner.attachTeam(() => agents)
      const originalFollowUp = runner.followUp.bind(runner)
      runner.followUp = async (...args) => {
        const result = await originalFollowUp(...args)
        if (args[2]?.meetingTurn && result.finalText) {
          capturedSpeeches.push({
            taskId: args[0],
            agentId: taskStore.get(args[0])?.agentId ?? '',
            finalText: result.finalText
          })
        }
        return result
      }
      offices = new AgentSessionRegistry({
        store: taskStore,
        taskService,
        runner,
        getAgents: () => agents,
        waitPollMs: 25,
        waitTimeoutMs: RUN_TIMEOUT_MS
      })
      meetingStore = new MeetingStore(userDataDir)
      controller = new MeetingController({
        store: meetingStore,
        offices,
        getAgents: () => agents,
        taskService,
        issueExists: () => true,
        getIssueTask: () => ({ id: 'fixture-container', workdir, status: 'queued' }),
        isFreshIssue: () => false,
        cancelTask: (taskId) => runner.terminateTask(taskId),
        taskStore,
        stopTimeoutMs: 5_000
      })
      runner.attachMeetingGuard((task) => controller.canRunTask(task))
      meeting = controller.create({
        issueId: `iss_fixture_${Date.now().toString(36)}`,
        topic: `测试夹具是否保持隔离。已知宿主测试前提：两位fixture成员仅讨论；会议信息、执行任务和工作目录均在独立临时目录；${options.backend === 'claude' ? 'Claude逐次验证空工具目录，并禁用MCP、hooks及skills' : 'Codex使用read-only策略，禁用shell/browser/plugins，不配置MCP/hooks，禁止工具调用并拒绝非文本工具项，但不保证所有内置工具不可用'}；未向模型提供任何生产会议ID或内容。结论只判断这些明确前提是否把本次测试数据保存在独立临时存储中，不要求查证文件，不声称OS读取边界已被隔离，不产生行动项。请简短回答。`,
        participants: [
          { agentId: 'fixture-reporter', role: 'reporter' },
          { agentId: 'fixture-designer', role: 'designer' }
        ],
        maxRounds: 1,
        maxInnerTurns: 1,
        maxDurationMs: MEETING_BUDGET_MS,
        noProgressCap: 1
      })
      report.meetingId = meeting.id
      const startPromise = controller.start(meeting.id)
      runFinished = false
      observedRun = startPromise.then(
        (value) => { runFinished = true; return { kind: 'completed', value } },
        (error) => { runFinished = true; return { kind: 'error', error } }
      )
      const outcome = await withTimeout(observedRun, RUN_TIMEOUT_MS)
      if (outcome.kind === 'timeout') {
        report.status = 'timed-out'
        report.error = `Real meeting exceeded ${RUN_TIMEOUT_MS}ms wall-clock limit.`
        report.meeting = controller.get(meeting.id)
        report.turns = meetingStore.readTurns(meeting.id).turns
        process.exitCode = 1
      } else if (outcome.kind === 'error') {
        report.status = 'run-error'
        report.error = errorText(outcome.error)
        process.exitCode = 1
      } else if (outcome.value.kind === 'error') {
        report.status = 'run-error'
        report.error = errorText(outcome.value.error)
        process.exitCode = 1
      } else {
        const result = outcome.value.value
        const finalMeeting = result.meeting ?? controller.get(meeting.id)
        const latestStances = new Map()
        for (const speech of capturedSpeeches) latestStances.set(speech.agentId, parseStance(speech.finalText))
        const stances = agents.map((agent) => ({ agentId: agent.id, ...(latestStances.get(agent.id) ?? null) }))
        const minutes = finalMeeting?.minutes ?? []
        const valid = result.ok
          && finalMeeting?.status === 'concluded'
          && minutes.length === 1
          && minutes[0].confirmations?.length === agents.length
          && minutes[0].confirmations.every((confirmation) => confirmation.verdict === 'agree' && confirmation.minutesVersion === minutes[0].version)
          && stances.every((stance) => stance.verdict === 'agree')
        report.status = valid ? 'passed' : 'assertion-failed'
        report.meeting = {
          status: finalMeeting?.status,
          stopReason: finalMeeting?.stopReason,
          rounds: finalMeeting?.round,
          minutes
        }
        report.stances = stances
        report.turns = meetingStore.readTurns(meeting.id).turns.map(({ body, ...turn }) => ({ ...turn, bodyLength: body?.length, bodyTail: body?.slice(-100) }))
        report.publicVersion = finalMeeting.publicVersion
        report.speechCount = capturedSpeeches.length
        if (!valid) {
          report.error = result.error ?? 'Expected one JSON-backed minute and an explicit agreeing stance from both fixture members.'
          process.exitCode = 1
        }
      }
    }
  } catch (error) {
    report.status = 'setup-or-run-error'
    report.error = errorText(error)
    process.exitCode = 1
  } finally {
    if (controller && meeting && (!runFinished || taskStore.list().some((task) => task.meetingId === meeting.id && task.status === 'running'))) {
      try {
        const stopped = await controller.cancel(meeting.id)
        if (!stopped.ok) cleanupError = stopped.error ?? 'Meeting cancellation was not confirmed.'
      } catch (error) {
        cleanupError = errorText(error)
      }
    }
    if (runner && taskStore && meeting) {
      const ownedTasks = taskStore.list().filter((task) => task.meetingId === meeting.id && task.meetingTaskRole === 'member')
      for (const task of ownedTasks) {
        if (task.status !== 'running' && task.status !== 'queued' && task.status !== 'failed') continue
        try {
          const stopped = await runner.terminateTask(task.id)
          if (!stopped.ok) cleanupError ??= stopped.error ?? `Could not stop fixture task ${task.id}.`
        } catch (error) {
          cleanupError ??= errorText(error)
        }
      }
    }
    if (observedRun && !runFinished) {
      const settled = await withTimeout(observedRun, STOP_SETTLE_MS)
      if (settled.kind === 'timeout') cleanupError ??= 'Meeting run did not settle after cancellation.'
    }
    if (runner && taskStore) {
      const tasks = taskStore.list()
      const hasForeignTask = tasks.some((task) => task.meetingId !== meeting?.id)
      if (!hasForeignTask) {
        try { await runner.shutdown() }
        catch (error) { cleanupError ??= errorText(error) }
      } else cleanupError ??= 'Skipped runner-wide shutdown because an unowned task exists.'
    }
    if (observedRun && !runFinished) {
      const settled = await withTimeout(observedRun, STOP_SETTLE_MS)
      if (settled.kind === 'timeout') cleanupError ??= 'Meeting run did not settle after runner shutdown.'
    }
    try { offices?.dispose() } catch (error) { cleanupError ??= errorText(error) }
    try { taskStore?.flush() } catch (error) { cleanupError ??= errorText(error) }
    if (taskStore) {
      const toolEvents = taskStore.list().flatMap((task) => taskStore.readEvents(task.id)).filter((event) => event.kind === 'tool')
      report.toolEventCount = toolEvents.length
      if (toolEvents.length) { cleanupError ??= 'Unexpected tool events in text-only fixture'; process.exitCode = 1 }
    }
    report.cliInvocationCount = globalThis.meetingFixtureCalls ?? 0
    report.toolCatalogues = globalThis.meetingFixtureTools ?? []
    report.models = globalThis.meetingFixtureModels ?? []
    report.providerSessions = globalThis.meetingFixtureProviderSessions ?? []
    report.cliResults = globalThis.meetingFixtureResults ?? []
    report.unexpectedToolItems = globalThis.meetingFixtureUnexpectedTools ?? []
    report.modelTurnCount = report.cliResults.reduce((count, result) => count + (result.numTurns ?? (result.subtype === 'turn.completed' ? 1 : 0)), 0)
    if (report.cliResults.some((result) => typeof result.costUsd === 'number')) report.reportedCostUsd = report.cliResults.reduce((cost, result) => cost + (result.costUsd ?? 0), 0)
    if (options.backend === 'claude' && (report.toolCatalogues.length !== report.cliInvocationCount || report.toolCatalogues.some((tools) => !Array.isArray(tools) || tools.length))) { cleanupError ??= 'Every CLI invocation must expose a verified empty tool catalogue'; process.exitCode = 1 }
    if (report.unexpectedToolItems.length) { cleanupError ??= 'Unexpected tool items were observed'; process.exitCode = 1 }
    try {
      const resolved = path.resolve(fixtureRoot)
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agentdeck-meeting-real-')) throw new Error('Unsafe fixture cleanup path')
      if (!cleanupError) fs.rmSync(resolved, { recursive: true, force: true })
      else report.retainedFixture = resolved
    }
    catch (error) { cleanupError ??= errorText(error) }
    if (cleanupError) {
      report.cleanup = { ok: false, error: cleanupError }
      process.exitCode = 1
    } else report.cleanup = { ok: true, temporaryFixtureRemoved: true }
  }

  console.log(JSON.stringify(report, null, 2))
}

await main()

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:net'
import { isolatedEnvironment, assertStartupIsolation, IsolatedProcessFence } from './isolated-release-processes.mjs'

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const reservePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

export async function verifyInstalledMeeting(options) {
  const { installed, data, trust, cleanEnv, phase, currentVersion, rendererVersion, meetingId, title, temporary } = options
  const port = await reservePort()
  const env = { ...isolatedEnvironment(temporary, cleanEnv, data), AGENTDECK_HOT_TRUST_HEX: trust }
  const executable = path.join(installed, 'AgentDeck.exe')
  const isolation = assertStartupIsolation(temporary, executable, env)
  const fence = new IsolatedProcessFence(temporary)
  fence.assertClean()
  const child = await fence.launch(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { cwd: installed, env, stdout: path.join(temporary, phase + '-stdout.log'), stderr: path.join(temporary, phase + '-stderr.log') })
  const evidence = { phase, executable, pid: child.pid, data, isolation }
  let socket
  try {
    let page
    const deadline = Date.now() + 60000
    while (!page) {
      try { page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((target) => target.type === 'page') } catch {}
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(phase + ' isolated application page not ready')
      if (!page) await sleep(100)
    }
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    const waiting = new Map()
    socket.onmessage = ({ data: message }) => {
      const packet = JSON.parse(String(message))
      if (packet.id && waiting.has(packet.id)) {
        const pending = waiting.get(packet.id)
        waiting.delete(packet.id)
        clearTimeout(pending.timer)
        if (packet.error) pending.reject(new Error(JSON.stringify(packet.error)))
        else pending.resolve(packet.result)
      }
    }
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout ' + method)) }, 20000)
      waiting.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
      return value.result.value
    }
    while (!await evaluate('!!window.agentdeck && !!document.querySelector(".nav")')) {
      if (Date.now() > deadline) throw new Error('real preload and recent meeting unavailable')
      await sleep(100)
    }
    await evaluate('[...document.querySelectorAll(".nav button")].find(button=>button.textContent==="Issue").click()')
    while (!await evaluate('!!document.querySelector(".issue-recent")')) {
      if (Date.now() > deadline) throw new Error('recent meeting unavailable after Issue navigation')
      await sleep(100)
    }
    while (!await evaluate('(() => { const row=[...document.querySelectorAll(".issue-recent-task")].find(row=>row.textContent.includes(' + JSON.stringify(title) + ')); if(!row)return false;row.querySelector("button").click();return true })()')) {
      if (Date.now() > deadline) throw new Error('fixture meeting was not listed in the real Issue entry')
      await sleep(100)
    }
    while (!await evaluate('!!document.querySelector("[data-meeting-detail]") && !!document.querySelector("[data-turn-id]")')) {
      if (Date.now() > deadline) throw new Error('meeting navigation or authoritative page unavailable')
      await sleep(100)
    }
    const details = await evaluate('({meetingId:document.querySelector("[data-meeting-detail]").dataset.meetingDetail, bodies:[...document.querySelectorAll("[data-body]")].map(element=>({kind:element.dataset.body,text:element.textContent})), url:location.href})')
    assert.equal(details.meetingId, meetingId)
    assert.equal(details.bodies.some((body) => body.kind === 'markdown'), false)
    assert.ok(details.bodies.some((body) => body.kind === 'missing'))
    const updates = await evaluate('window.agentdeck.updates.getState()')
    assert.equal(updates.currentVersion, currentVersion)
    assert.equal(updates.activeRendererVersion, rendererVersion)
    const turns = await evaluate('window.agentdeck.meetings.readTurns(' + JSON.stringify(meetingId) + ')')
    assert.equal(turns.latestVersion, 0)
    assert.equal(turns.turns[0].body, undefined)
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(temporary, phase + '.png'), Buffer.from(screenshot.data, 'base64'))
    Object.assign(evidence, { updates, page: details.url, bodies: details.bodies })
    return evidence
  } finally {
    socket?.close()
    try {
      evidence.cleanup = await fence.cleanup(child)
      evidence.exitCode = child.exitCode
      evidence.signalCode = child.signalCode
    } catch (error) {
      evidence.cleanup = error.cleanupEvidence
      throw error
    } finally {
      fs.writeFileSync(path.join(temporary, phase + '-execution.json'), JSON.stringify(evidence, null, 2))
    }
  }
}

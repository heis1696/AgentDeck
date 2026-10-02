import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'smoke-event-log.mjs')], {
  env: { ...process.env, EVENT_LOG_PROBE_DELAY_MS: '300', EVENT_LOG_RELEASE_DELAY_MS: '80' },
  stdio: 'inherit', windowsHide: true
})
assert.equal(result.error, undefined)
assert.equal(result.signal, null)
assert.equal(result.status, 0, 'a slow owner probe must retry the released lock before declaring a timeout')
console.log('SLOW OWNER PROBE REGRESSION PASSED')

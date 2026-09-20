import './ui-visual-bridge'
import { getBatchDBridge } from './ui-batch-d-bridge'
import '../../src/renderer/src/main'

Object.assign(window, { __petVisual: getBatchDBridge() })
if (new URL(window.location.href).searchParams.has('failRead')) {
  window.agentdeck.pet.getState = async () => { throw new Error('fixture read unavailable') }
}

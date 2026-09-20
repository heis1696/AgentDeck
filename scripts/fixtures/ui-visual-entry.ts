import './ui-visual-bridge'
import '../../src/renderer/src/main'
import { ui } from '../../src/renderer/src/ui/interaction-center'
import { getDraftBridge } from './ui-draft-bridge'

Object.assign(window, { __visual: { ui, mock: getDraftBridge() } })

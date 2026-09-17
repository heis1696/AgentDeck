import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentsView } from '../src/renderer/src/components/AgentsView'
window.__mountAV = (el) => { createRoot(el).render(createElement(AgentsView)) }

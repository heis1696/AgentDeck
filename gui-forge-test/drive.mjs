// 无头复现：真实 AgentsView 组件 + mock 桥，跑完 生成→确认→填入表单→保存 全流程
import { JSDOM } from 'jsdom'
import fs from 'node:fs'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true
})
const { window } = dom
const { document } = window

// ---- mock bridge（等价于真实 preload 契约）----
const saves = []
const DRAFT = {
  ok: true, kind: 'draft',
  draft: {
    name: '测试哨兵', role: '前端测试工程师',
    systemPrompt: '你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest、Playwright、边界用例。做事方式：先通读实现再补测试。边界：不改业务代码。',
    note: '单测与E2E均衡', color: '#16a34a', model: 'glm-5.3'
  }
}
const unsub = () => () => {}
const mk = (impl) => (...a) => impl(...a)
window.agentdeck = {
  agents: {
    list: mk(() => Promise.resolve([
      { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', color: '#4f8cff', role: '领队', systemPrompt: '你是开发领队。', subordinates: ['ag_dsh'] },
      { id: 'ag_dsh', name: 'DeepSeek', backend: 'dsh', color: '#4d6bfe' },
      { id: 'ag_forge', name: '锻造师', backend: 'zcode', color: '#f59e0b', role: '锻造', note: '专职生成' }
    ])),
    save: mk((list) => { saves.push(JSON.parse(JSON.stringify(list))); return Promise.resolve(list) }),
    draft: mk(() => Promise.resolve(DRAFT)),
    models: mk(() => Promise.resolve({ backend: 'zcode', source: 'freeform', models: [] })),
    newId: mk(() => Promise.resolve('ag_mock'))
  },
  presets: { list: mk(() => Promise.resolve([])), models: mk(() => Promise.resolve({ backend: 'zcode', source: 'freeform', models: [] })), newId: mk(() => Promise.resolve('ps_mock')) }
}
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {} }))

// ---- 载入真实组件包并挂载 ----
window.eval(fs.readFileSync('agentsview.iife.js', 'utf8'))
window.__mountAV(document.getElementById('root'))
const tick = () => new Promise((r) => setTimeout(r, 20))
const settle = async (n = 8) => { for (let i = 0; i < n; i++) { await tick(); } }

const buttons = () => [...document.querySelectorAll('button')].map((b) => ({ b, t: b.textContent.trim() }))
const findBtn = (text) => buttons().find((x) => x.t.includes(text))?.b
const setInput = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const dialogValues = () => {
  const dlg = [...document.querySelectorAll('.dialog')].at(-1)
  if (!dlg) return null
  const out = []
  for (const f of dlg.querySelectorAll('.field')) {
    const label = f.querySelector(':scope > span')?.textContent ?? ''
    const input = f.querySelector('input, textarea')
    if (input) out.push({ label: label.slice(0, 24), value: String(input.value).slice(0, 60) })
  }
  return out
}

await settle(10)
console.log('step1 页头按钮:', buttons().map((x) => x.t).filter((t) => t).join(' | ').slice(0, 200))

findBtn('从描述生成')?.click()
await settle()
console.log('step2 生成对话框打开:', Boolean(document.querySelector('.overlay .dialog textarea')))

const ta = document.querySelector('.overlay .dialog textarea')
setInput(ta, '一个擅长 React 单测、用中文汇报的严谨工程师')
findBtn('生成草稿')?.click()
await settle(15)
console.log('step3 确认视图出现:', document.body.textContent.includes('确认要填入的字段'))
console.log('step3 勾选按钮:', buttons().map((x) => x.t).filter((t) => t.includes('填入') || t.includes('跳过')).join(','))

findBtn('填入表单')?.click()
await settle()
const vals = dialogValues()
console.log('step4 编辑表单字段值:')
for (const v of vals ?? []) console.log('   ', JSON.stringify(v.label), '=>', JSON.stringify(v.value))

findBtn('保存')?.click()
await settle()
console.log('step5 save 载荷:', saves.length ? JSON.stringify(saves.at(-1).at(-1), null, 1) : '(未捕获)')

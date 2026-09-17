import { JSDOM } from 'jsdom'
import fs from 'node:fs'
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true })
const { window } = dom; const { document } = window
const saves = []
const DRAFT = { ok: true, kind: 'draft', draft: { name: '测试哨兵', role: '前端测试工程师', systemPrompt: '你是严谨的前端测试工程师。', note: '单测均衡', color: '#16a34a', model: 'glm-5.3' } }
const mk = (impl) => (...a) => impl(...a)
window.agentdeck = {
  agents: {
    list: mk(() => Promise.resolve([
      { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', color: '#4f8cff', role: '领队', systemPrompt: '你是开发领队。', subordinates: ['ag_dsh'] },
      { id: 'ag_forge', name: '锻造师', backend: 'zcode', color: '#f59e0b', role: '锻造' }
    ])),
    save: mk((list) => { saves.push(JSON.parse(JSON.stringify(list))); return Promise.resolve(list) }),
    draft: mk(() => Promise.resolve(DRAFT)),
    models: mk(() => Promise.resolve({ backend: 'zcode', source: 'freeform', models: [] }))
  },
  presets: { list: mk(() => Promise.resolve([])), models: mk(() => Promise.resolve({ models: [] })) }
}
window.eval(fs.readFileSync('agentsview.iife.js', 'utf8'))
window.__mountAV(document.getElementById('root'))
const tick = () => new Promise((r) => setTimeout(r, 20))
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick() }
const buttons = () => [...document.querySelectorAll('button')]
const findBtn = (text) => buttons().find((b) => b.textContent.trim().includes(text))
await settle(10)
findBtn('从描述生成').click(); await settle()
const ta = document.querySelector('.overlay .dialog textarea')
Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '一个擅长单测的工程师')
ta.dispatchEvent(new window.Event('input', { bubbles: true }))
findBtn('生成草稿').click(); await settle(15)
let flipped = 0
for (const b of buttons()) { if (b.textContent.trim() === '✓ 填入') { b.click(); flipped++; await settle(2) } }
console.log('用户逐个点击了', flipped, '个 ✓填入 钮（肌肉记忆路径）')
console.log('取消后按钮态:', buttons().map((b) => b.textContent.trim()).filter((t) => t === '已跳过').length, '个「已跳过」')
console.log('页脚计数:', (document.body.textContent.match(/将填入 [0-9]\/6/) ?? ['(未找到)'])[0])
const primary = findBtn('只填入名字') ?? findBtn('填入表单')
console.log('主按钮文案:', primary?.textContent.trim())
primary.click(); await settle()
const dlg = [...document.querySelectorAll('.dialog')].at(-1)
const get = (kw) => { for (const f of dlg.querySelectorAll('.field')) { const label = f.querySelector(':scope > span')?.textContent ?? ''; if (label.includes(kw)) { const i = f.querySelector('input, textarea'); return i ? i.value : '' } } return '(无)' }
console.log('表单: 名字 =', get('名字'), '| 系统提示词 =', JSON.stringify(get('系统提示词').slice(0, 20)), '（此刻用户能从按钮/计数/划线三重信号发现全取消了）')

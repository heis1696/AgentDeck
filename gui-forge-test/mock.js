// 注入到 index.html 之前定义 window.__mockBridge：为无 preload 的浏览器环境伪造 window.agentdeck
window.__mockBridge = function () {
  const saves = []
  window.__forgeTest = { saves, draftCalls: [] }
  const unsub = () => () => {}
  const DRAFT = {
    ok: true, kind: 'draft',
    draft: {
      name: '测试哨兵', role: '前端测试工程师',
      systemPrompt: '你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest 单元测试、Playwright E2E、边界用例设计。做事方式：先通读实现再补测试；每个 bug 先写复现测试再谈修复。边界：不改动业务实现代码，歧义时停下请领队决策。',
      note: '单测与 E2E 均衡', color: '#16a34a', model: 'glm-5.3'
    }
  }
  const defaults = {
    'agents.list': () => Promise.resolve([
      { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', color: '#4f8cff', role: '领队', systemPrompt: '你是开发领队。', subordinates: ['ag_dsh'] },
      { id: 'ag_dsh', name: 'DeepSeek', backend: 'dsh', color: '#4d6bfe', role: '辅程', systemPrompt: '你是分析员。' },
      { id: 'ag_forge', name: '锻造师', backend: 'zcode', color: '#f59e0b', role: '锻造', note: '专职生成' }
    ]),
    'agents.save': (list) => { saves.push(JSON.parse(JSON.stringify(list))); return Promise.resolve(list) },
    'agents.draft': (desc) => { window.__forgeTest.draftCalls.push(desc); return Promise.resolve(DRAFT) },
    'agents.improve': () => Promise.resolve({ ok: false, error: 'mock 未实现' }),
    'agents.evaluate': () => Promise.resolve({ ok: false, error: 'mock 未实现' }),
    'agents.importMd': () => Promise.resolve({ ok: false, error: 'mock 未实现' }),
    'agents.exportMd': () => Promise.resolve({ ok: false, error: 'mock 未实现' }),
    'agents.models': () => Promise.resolve({ backend: 'zcode', source: 'freeform', models: [] }),
    'agents.newId': () => Promise.resolve('ag_mock'),
    'presets.list': () => Promise.resolve([]),
    'presets.models': () => Promise.resolve({ backend: 'zcode', source: 'freeform', models: [] }),
    'presets.newId': () => Promise.resolve('ps_mock'),
    'tasks.list': () => Promise.resolve([]),
    'issues.list': () => Promise.resolve([]),
    'automations.list': () => Promise.resolve([]),
    'runtimes.snapshot': () => Promise.resolve([]),
    'skills.list': () => Promise.resolve({ root: '', skills: [] }),
    'sidecar.status': () => Promise.resolve({ phase: 'disabled' }),
    'updates.getState': () => Promise.resolve({ phase: 'idle', channel: null, currentVersion: '0.0.0-mock' }),
    'settings.get': () => Promise.resolve({}),
    'meetings.list': () => Promise.resolve([]),
    'analytics.summary': () => Promise.resolve({ totals: { runs: 0, failures: 0, tokensIn: 0, tokensOut: 0 }, byRuntime: [], byAgent: [], byDay: [] })
  }
  const handlerFor = (path) => defaults[path] || ((...a) => {
    const last = path.split('.').pop()
    if (last.startsWith('on')) return Promise.resolve(unsub)
    if (last === 'list') return Promise.resolve([])
    return Promise.resolve({})
  })
  const nsProxy = (path) => new Proxy(function () {}, {
    get: (_t, key) => {
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined
      return nsProxy(path + '.' + String(key))
    },
    apply: (_t, _this, args) => handlerFor(path)(...args)
  })
  window.agentdeck = nsProxy('')
  console.log('[mock] window.agentdeck ready')
}

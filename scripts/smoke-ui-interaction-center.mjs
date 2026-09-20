// 交互中心冒烟（无 Electron / 无 DOM）：ui/interaction-center + ui/interaction-layer 的纯逻辑回归。
// 覆盖：挂载时序（composer/dock/toast 跨挂载）、confirm 生命周期（FIFO + 卸载取消）、
//       当前任务导航（祖先链/上限/删除/切换）、目录就绪与待决路由（未加载≠已加载缺失、
//       目录到达后重路由+错误 dock 桶迁移、旧 handle 仍可回写、关闭项不复活）、
//       dock 异步更新（打开请求标识）、浮层键盘（最上层 Escape/焦点陷阱/快捷键只对模态让路）。
// 另含结构回归：SideDock 导入环已断、DOM 自定义事件/模拟键盘/60ms 延时已移除、App 保留 pet 路由、
//       useTasks 防乱序、快捷键只看最上层模态。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-ui-interaction-center.cjs')
const entry = [
  path.join(root, 'src/renderer/src/ui/interaction-layer.ts'),
  path.join(root, 'src/renderer/src/ui/interaction-center.ts'),
  path.join(root, 'src/renderer/src/ui/Toasts.tsx'),
  path.join(root, 'src/renderer/src/ui/Confirm.tsx')
].map((file) => `export * from ${JSON.stringify(file)}`).join('\n')

await build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
})
const {
  ui, createInteractionCenter, resolveShortcut, isEditableTarget,
  createLayerStack, trapTargetIndex, rootTabsOf, resolveRootIn, taskCatalogOf,
  toast, confirmDialog
} = await import(pathToFileURL(outfile).href)

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

/* ---------------------------------------------------------------- 工厂隔离 */

section('工厂隔离与单例')
{
  const a = createInteractionCenter({ layers: createLayerStack() })
  const b = createInteractionCenter({ layers: createLayerStack() })
  a.setTasks([{ id: 'x', title: 'X' }])
  a.openTask('x')
  ok(a.getState().tabs.length === 1 && b.getState().tabs.length === 0, '两个中心实例状态互不影响')
  ok(typeof ui.subscribe === 'function' && ui.getState().tabs.length === 0, 'ui 单例独立于工厂实例')
  ok(isEditableTarget({ tagName: 'textarea' }) && isEditableTarget({ isContentEditable: true }) && !isEditableTarget({ tagName: 'DIV' }), 'isEditableTarget 认输入类标签与 contenteditable')
}

/* ------------------------------------------------------- 挂载时序（跨挂载） */

section('挂载时序：composer / dock / toast')
{
  const timers = { armed: [], cleared: [], set(fn, ms) { const handle = { fn, ms }; this.armed.push(handle); return handle }, clear(handle) { this.cleared.push(handle) } }
  const c = createInteractionCenter({ layers: createLayerStack(), timers, toastTtlMs: 4200 })
  c.setTasks([{ id: 'root', title: '领队' }, { id: 'kid', title: '队员', parentTaskId: 'root' }])

  // composer：宿主没挂载时发请求，请求号留在中心
  c.focusComposer()
  ok(c.getState().composerTick === 1 && c.getState().view === 'issues', '宿主挂载前的 focusComposer 请求进入中心（tick=1）')
  let focused = 0
  let handledTick = 0
  const mountComposerHost = () => { handledTick = c.getState().composerTick; focused++ }   // WorkspaceView 挂载即聚焦
  mountComposerHost()
  ok(focused === 1 && handledTick === 1, '宿主挂载后消费到请求并聚焦一次')
  handledTick = 0                                                          // 模拟卸载重挂载
  mountComposerHost()
  ok(handledTick === 1, '请求号跨挂载保留（重挂载仍能读到同一次请求）')
  c.focusComposer()
  ok(c.getState().composerTick === 2, '新的聚焦请求继续递增，不会与旧请求混淆')

  // dock：宿主未挂载时打开 → 状态立刻可读，不需要等挂载、没有丢事件
  const handle = c.dock.open({ id: 'task:kid', kind: 'task', title: '队员', payload: { taskId: 'kid' } })
  const mountedBucket = () => c.dock.state('root')
  ok(mountedBucket().items.length === 1 && mountedBucket().activeId === 'task:kid', '宿主挂载前 dock.open 已进入中心（挂载即可见）')
  ok(timers.armed.length === 0, 'dock 打开不依赖定时器/延时（旧的 60ms 派发已移除）')
  // 卸载重挂载：桶按根任务保留
  ok(c.dock.state('root') === mountedBucket() && c.dock.state('root').items[0].token === handle.token, 'dock 桶跨挂载保留（同一份状态）')

  // toast：宿主挂载前排队，挂载时补定时器，卸载时清理
  c.toast.info('挂载前排队')
  c.toast.success('第二条')
  ok(c.getState().toasts.length === 2, '宿主挂载前的 toast 全部入队（不再丢）')
  ok(timers.armed.length === 0, '未挂载时不启动定时器')
  c.toast.attach()
  ok(timers.armed.length === 2, '宿主挂载时给排队 toast 补上定时器')
  c.toast.detach()
  ok(timers.cleared.length === 2 && c.getState().toasts.length === 2, '宿主卸载清理全部定时器，队列保留')
  c.toast.attach()
  ok(timers.armed.length === 4, '重新挂载重新计时')
  timers.armed[timers.armed.length - 1].fn()
  ok(c.getState().toasts.length === 1 && c.getState().toasts[0].text === '挂载前排队', '到期定时器只移除自己那条')
  for (let i = 0; i < 6; i++) c.toast.error(`t${i}`)
  ok(c.getState().toasts.length === 4 && c.getState().toasts[0].text === 't2', '同屏最多 4 条，最旧的被淘汰')
  c.toast.clear()
  ok(c.getState().toasts.length === 0, 'toast.clear 清空队列')
}

/* ----------------------------------------------------------- confirm 生命周期 */

section('confirm：FIFO 与宿主卸载')
{
  const c = createInteractionCenter({ layers: createLayerStack() })
  const first = c.confirm({ title: '第一问' })
  const second = c.confirm({ title: '第二问' })
  const third = c.confirm({ title: '第三问' })
  ok(c.getState().confirm?.title === '第一问' && c.getState().confirmPending === 2, '并发 confirm 按 FIFO 排队（只展示队首）')
  c.confirmHost.respond(true)
  ok(await first === true, '队首按用户选择结算 true')
  ok(c.getState().confirm?.title === '第二问' && c.getState().confirmPending === 1, '结算后下一问接棒')
  c.confirmHost.respond(false)
  ok(await second === false, '第二问按用户选择结算 false')
  const page = c.confirm({ title: '第四问' }).then(() => 'resolved')
  const pending = c.confirm({ title: '第五问' })
  const raced = await Promise.race([page, new Promise((resolve) => setTimeout(() => resolve('pending'), 10))])
  ok(raced === 'pending', '未决 Promise 在宿主卸载前不结算')
  c.confirmHost.cancelAll()
  ok(await third === false && await pending === false, '宿主卸载（cancelAll）把当前与排队的全部按取消结算')
  ok(c.getState().confirm === null && c.getState().confirmPending === 0, 'cancelAll 后状态清空')
  ok(c.confirmHost.respond(true) === false, '没有待决请求时 respond 是空操作')
}

/* --------------------------------------------------------------- 当前任务导航 */

section('当前任务导航：祖先链 / 8 页签 / 删除 / 切换')
{
  const c = createInteractionCenter({ layers: createLayerStack() })
  const catalog = [
    { id: 'rootA', title: '领队A' },
    { id: 'kidA1', title: '队员A1', parentTaskId: 'rootA' },
    { id: 'kidA2', title: '队员A2', parentTaskId: 'rootA' },
    { id: 'deepA', title: '孙任务', parentTaskId: 'kidA1' },
    { id: 'orphan', title: '断链任务', parentTaskId: 'missing' },
    { id: 'cyc1', title: '环1', parentTaskId: 'cyc2' },
    { id: 'cyc2', title: '环2', parentTaskId: 'cyc1' }
  ]
  c.setTasks(catalog)

  ok(c.openTask('rootA') === 'tab' && c.getState().activeId === 'rootA' && c.getState().view === 'detail', '普通任务开顶部页签')
  ok(c.openTask('kidA1') === 'dock' && c.getState().tabs.length === 1 && c.getState().activeId === 'rootA', '子任务不开页签：路由到领队详情')
  ok(c.dock.state('rootA').items.some((item) => item.id === 'task:kidA1'), '子任务在其根任务的 dock 桶里打开')
  ok(c.openTask('deepA') === 'dock' && c.resolveRoot('deepA').rootId === 'rootA' && c.getState().tabs.length === 1, '孙任务解析到根祖先，仍不开页签')
  ok(c.resolveRoot('deepA').depth === 2 && c.resolveRoot('rootA').isRoot, '祖先链深度与根判定正确')

  const orphan = c.resolveRoot('orphan')
  ok(orphan.broken && !orphan.isRoot && c.openTask('orphan') === 'tab' && c.getState().tabs.includes('orphan'), '祖先缺失：按普通任务开页签兜底（不卡死）')
  const cyc = c.resolveRoot('cyc1')
  ok(cyc.broken && !cyc.isRoot && c.openTask('cyc1') === 'tab', '祖先成环：检测到环并退回普通页签（不死循环）')
  ok(c.openTask('missing-task') === 'tab' && c.getState().tabs.includes('missing-task'), '目录里还没有的任务（列表未加载）也能开页签')

  c.setTasks(catalog)
  const bigCatalog = [...catalog, ...Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `T${i}` }))]
  c.setTasks(bigCatalog)
  for (let i = 0; i < 10; i++) c.openTask(`t${i}`)
  const tabs = c.getState().tabs
  ok(tabs.length === 8 && tabs[0] === 't2' && tabs[7] === 't9', '页签上限 8：超出淘汰最旧')

  c.closeTab('t9')
  ok(c.getState().activeId === 't8' && !c.getState().tabs.includes('t9'), '关闭当前页签后切到最后一个剩余页签')
  const cycled = c.cycleTab(1)
  ok(cycled === 't2' && c.getState().activeId === 't2', 'cycleTab 正向环绕')
  ok(c.cycleTab(-1) === 't8', 'cycleTab 反向环绕')

  const before = c.getState().tabs.length
  c.setTasks(bigCatalog.filter((task) => task.id !== 't8'))
  const after = c.getState()
  ok(after.tabs.length === before - 1 && !after.tabs.includes('t8') && after.activeId === 't7', '删除任务后其页签被摘掉，活动页签落到仍存在的页签')
  ok(Object.keys(after.docks).length > 0, '根任务仍在时 dock 桶不受删除影响')
  c.setTasks(bigCatalog.filter((task) => task.id !== 'rootA'))
  ok(Object.keys(c.getState().docks).every((rootId) => rootId !== 'rootA'), '根任务删除后 dock 桶一并清理')
  c.setTasks([])
  ok(c.getState().tabs.length === 0 && c.getState().activeId === null && c.getState().view === 'issues', '全部任务删除后回到 Issue 主页')
}

/* ------------------------------------------- 目录就绪与待决路由（草稿/桥接 focus） */

section('目录就绪与待决路由：未加载 ≠ 已加载缺失，目录到达后重路由 + 桶迁移')
{
  const c = createInteractionCenter({ layers: createLayerStack() })
  ok(c.isCatalogReady() === false, '目录未加载：isCatalogReady 为假')
  // 桥接 focus 事件先于目录到达（真实时序：主进程派发 task:focus 时渲染层列表还在途）
  ok(c.openTask('kid') === 'tab' && c.getState().tabs.join() === 'kid' && c.getState().view === 'detail', '目录未加载时 openTask：乐观按普通页签兜底进详情（不丢请求）')
  const early = c.dock.open({ id: 'task:kid', kind: 'task', title: '队员', payload: { taskId: 'kid' } })
  ok(c.dock.state('kid')?.items.length === 1, '目录未加载时 dock.open 兜底自键（键错了的桶）')
  // 目录到达：kid 其实是 root 的子任务 → 撤乐观页签、重路由到根详情 + dock，错误桶整体迁移
  c.setTasks([{ id: 'root', title: '领队' }, { id: 'kid', title: '队员', parentTaskId: 'root' }])
  ok(c.isCatalogReady() && c.getState().tabs.join() === 'root' && c.getState().activeId === 'root', '目录到达后待决子任务重路由：页签换成根任务并激活')
  ok(c.dock.state('kid').items.length === 0 && c.dock.state('root')?.items.some((item) => item.id === 'task:kid'), '错误 dock 桶并入真正根任务的桶（存活项搬家，自键桶清掉）')
  ok(c.dock.update(early, { title: '队员·改' }) === true && c.dock.state('root').items[0].title === '队员·改', '迁移后旧 handle（旧 rootId）仍可更新存活项')
  ok(c.dock.state('root').activeId === 'task:kid', '迁移进来的存活项保持激活')

  // 已加载缺失：目录里有别人、没有它 → 乐观页签兜底，但下一份快照仍没有就摘掉（不留僵尸页签）
  ok(c.openTask('ghost') === 'tab' && c.getState().tabs.includes('ghost'), '已加载缺失：按普通页签兜底（缺失/未知祖先同路）')
  c.setTasks([{ id: 'root', title: '领队' }, { id: 'kid', title: '队员', parentTaskId: 'root' }])
  ok(!c.getState().tabs.includes('ghost') && c.getState().activeId !== 'ghost', '下一份目录仍没有它：乐观页签摘掉')

  // 用户主动关掉的待决页签：目录到达后绝不借重定向复活
  ok(c.openTask('kid2') === 'tab' && c.getState().tabs.includes('kid2'), '新子任务目录未达：乐观页签兜底')
  c.closeTab('kid2')
  c.setTasks([{ id: 'root', title: '领队' }, { id: 'kid', title: '队员', parentTaskId: 'root' }, { id: 'kid2', title: '队员2', parentTaskId: 'root' }])
  ok(!c.getState().tabs.includes('kid2') && !c.dock.state('root')?.items.some((item) => item.id === 'task:kid2'), '用户关掉的待决页签：目录到达后不复活、不进 dock 桶')

  // 待决页签被目录确认只是普通任务：页签保留，无重路由
  ok(c.openTask('plain') === 'tab' && c.getState().tabs.includes('plain'), '目录未达的任务乐观开页签')
  c.setTasks([{ id: 'root', title: '领队' }, { id: 'kid', title: '队员', parentTaskId: 'root' }, { id: 'kid2', title: '队员2', parentTaskId: 'root' }, { id: 'plain', title: '普通' }])
  ok(c.getState().tabs.includes('plain') && c.getState().activeId === 'plain', '目录确认它是普通任务：页签保留即终态')

  // 迁移不复活已关闭项 + 存活项旧 handle 继续回写
  const c2 = createInteractionCenter({ layers: createLayerStack() })
  const h1 = c2.dock.open({ id: 'file:kid:a.ts', kind: 'file', title: 'a.ts', payload: { taskId: 'kid', file: 'a.ts', additions: 1, deletions: 0 } })
  const h2 = c2.dock.open({ id: 'file:kid:b.ts', kind: 'file', title: 'b.ts', payload: { taskId: 'kid', file: 'b.ts', additions: 2, deletions: 0 } })
  c2.dock.close('file:kid:a.ts')
  c2.setTasks([{ id: 'root', title: '领队' }, { id: 'kid', title: '队员', parentTaskId: 'root' }])
  ok(c2.dock.state('kid').items.length === 0 && c2.dock.state('root').items.map((item) => item.id).join() === 'file:kid:b.ts', '错误桶迁移：已关闭的项不并入新桶（绝不复活）')
  ok(c2.dock.update(h1, { payload: { diff: 'x' } }) === false, '已关闭项的旧 handle 回写被拒（token/定位双保险）')
  ok(c2.dock.update(h2, { payload: { diff: 'y' } }) === true && c2.dock.state('root').items[0].payload.diff === 'y', '存活项的旧 handle 迁移后仍可回写')
}

/* ------------------------------------------------------- 页签条过滤（App） */

section('目录晚到不覆盖用户的新导航，也不恢复已淘汰页签')
{
  const tasks = [{ id: 'root', title: 'Root' }, { id: 'kid', title: 'Kid', parentTaskId: 'root' }, { id: 'other', title: 'Other' }]
  const c = createInteractionCenter({ layers: createLayerStack() })
  c.openTask('kid')
  c.navigate('settings')
  c.setTasks(tasks)
  ok(c.getState().view === 'settings' && c.getState().tabs.includes('root'), '晚到目录修正页签归属但保留设置页')
  const second = createInteractionCenter({ layers: createLayerStack() })
  second.openTask('kid')
  second.openTask('other')
  second.setTasks(tasks)
  ok(second.getState().activeId === 'other', '晚到子任务不抢走后来选择的任务')
  const capped = createInteractionCenter({ layers: createLayerStack() })
  capped.openTask('kid')
  const roots = Array.from({ length: 8 }, (_, index) => ({ id: `root-${index}`, title: String(index) }))
  for (const task of roots) capped.openTask(task.id)
  capped.setTasks([...tasks, ...roots])
  ok(!capped.getState().tabs.includes('root') && !capped.dock.state('root').items.length, '超过页签上限被淘汰的待决任务不会复活')
}

section('页签条过滤：断裂祖先任务的普通页签不能被藏掉')
{
  const c = createInteractionCenter({ layers: createLayerStack() })
  const catalog = [
    { id: 'rootA', title: '领队A' },
    { id: 'kidA1', title: '队员A1', parentTaskId: 'rootA' },
    { id: 'orphan', title: '断链任务', parentTaskId: 'missing' },
    { id: 'cyc1', title: '环1', parentTaskId: 'cyc2' },
    { id: 'cyc2', title: '环2', parentTaskId: 'cyc1' },
    { id: 'plain', title: '普通任务' }
  ]
  c.setTasks(catalog)
  c.openTask('rootA'); c.openTask('orphan'); c.openTask('cyc1'); c.openTask('plain')
  const tabs = [...c.getState().tabs]
  ok(c.isRootTab('orphan') && c.isRootTab('cyc1'), '祖先链断裂（缺节点/成环）的任务是普通页签：isRootTab 为真')
  const visible = rootTabsOf(catalog, tabs)
  ok(visible.includes('orphan') && visible.includes('cyc1'), 'rootTabsOf 保留断裂祖先任务的页签（App 页签条据此显示）')
  ok(visible.length === tabs.length && tabs.length === 4, '四个普通页签全部可见，没有被 parentTaskId 一刀切过滤')

  c.openTask('kidA1')
  ok(c.openTask('kidA1') === 'dock' && !c.isRootTab('kidA1'), '祖先链完整的子任务路由到 dock，不进页签条')
  ok(rootTabsOf(catalog, ['rootA', 'kidA1']).join() === 'rootA', 'rootTabsOf 只摘掉「子任务且祖先链完整」的页签')
  ok(rootTabsOf(catalog, ['kidA1']).length === 0 && rootTabsOf(catalog, ['orphan']).length === 1, '同一个过滤器：子任务摘掉、断链任务保留（与 openTask 判定同源）')

  const graph = taskCatalogOf(catalog)
  ok(resolveRootIn(graph, 'orphan').broken && resolveRootIn(graph, 'cyc1').broken && resolveRootIn(graph, 'missing-x').rootId === 'missing-x', '纯函数 resolveRootIn：断链/成环/目录外任务都能解析')
  ok(resolveRootIn(graph, 'kidA1').rootId === 'rootA' && !resolveRootIn(graph, 'kidA1').broken, '纯函数 resolveRootIn：正常子任务解析到根')
}

/* ------------------------------------------------------------- dock 异步更新 */

section('dock：按根任务隔离 + 打开请求标识')
{
  const c = createInteractionCenter({ layers: createLayerStack() })
  c.setTasks([{ id: 'rootA', title: 'A' }, { id: 'rootB', title: 'B' }, { id: 'kid', title: 'kid', parentTaskId: 'rootA' }])
  const file = { id: 'file:kid:7:src/a.ts', kind: 'file', title: 'a.ts', payload: { taskId: 'kid', file: 'src/a.ts', additions: 2, deletions: 1 } }

  const handle = c.dock.open(file)
  ok(handle.rootId === 'rootA' && c.dock.state('rootA').items.length === 1, 'file 项按 payload.taskId 的根任务归桶')
  const late = c.dock.update(handle, { payload: { diff: '@@ -1 +1 @@', diffNote: 'git 未提交 diff' } })
  ok(late === true && c.dock.state('rootA').items[0].payload.diff === '@@ -1 +1 @@', '异步 diff 命中同一次打开：就地补写 payload')
  ok(c.dock.state('rootA').activeId === file.id && c.dock.state('rootB').items.length === 0, '更新不改变激活项，且不污染其它根任务的桶')

  c.dock.close(file.id, { rootId: 'rootA' })
  ok(c.dock.update(handle, { payload: { diff: 'late-2' } }) === false && c.dock.state('rootA').items.length === 0, '页签关闭后旧异步结果作废——绝不重开关闭的页签')
  const reopened = c.dock.open(file)
  ok(c.dock.update(handle, { payload: { diff: 'stale' } }) === false, '关闭后重开 = 新打开请求标识，旧结果被拒绝')
  ok(c.dock.state('rootA').items[0].payload.diff === undefined && c.dock.state('rootA').items[0].token === reopened.token, '重开的项保持新快照（旧结果未写入）')
  ok(c.dock.update(reopened, { payload: { diff: 'fresh' } }) === true, '新打开请求的回写正常生效')

  const second = c.dock.open({ id: 'task:kid', kind: 'task', title: 'kid', payload: { taskId: 'kid' } }, { rootId: 'rootA' })
  ok(c.dock.state('rootA').items.length === 2 && c.dock.state('rootA').activeId === 'task:kid', '同根任务可同时挂多个分页，新开的激活')
  c.dock.activate(file.id, { rootId: 'rootA' })
  ok(c.dock.state('rootA').activeId === file.id && c.dock.update(reopened, { payload: { diff: 'still' } }) === true, '纯切换激活不改打开请求标识（进行中的回写仍有效）')
  c.dock.close('task:kid', { rootId: 'rootA' })
  ok(c.dock.state('rootA').items.length === 1 && c.dock.state('rootA').activeId === file.id, '关闭非激活页签不影响激活项')
  c.dock.close(file.id, { rootId: 'rootA' })
  ok(c.dock.state('rootA').items.length === 0 && c.dock.state('rootA').activeId === null, '关掉最后一页后桶清空（SideDock 整体卸载）')
  ok(c.dock.update(second, { payload: { diff: 'x' } }) === false, '关闭后的任何异步回写都是空操作')
}

/* --------------------------------------------------------------- 浮层键盘 */

section('浮层键盘：最上层 Escape / 焦点陷阱 / 快捷键让路')
{
  const layers = createLayerStack()
  let escaped = []
  const modal = layers.push({ kind: 'modal', name: 'confirm', trap: true, onEscape: () => escaped.push('modal') })
  const menu = layers.push({ kind: 'popover', name: 'menu', trap: false, onEscape: () => escaped.push('menu') })
  ok(layers.size() === 2 && layers.topName() === 'menu' && !layers.isTop(modal) && layers.isTop(menu), '层栈后进先出，只有最上层 isTop')
  ok(layers.escape() && escaped.join() === 'menu', 'Escape 只由最上层消费')
  ok(layers.isTopTrap(modal), '非 trap 的菜单浮在上层时，模态仍是最上层 trap（Tab 循环不丢）')
  layers.release(menu)
  ok(layers.escape() && escaped.join() === 'menu,modal', '上层释放后 Escape 回到模态')
  layers.release(modal)
  ok(!layers.hasOpen() && layers.escape() === false, '全部释放后无层可消费 Escape')

  let outsideHits = []
  const pop = layers.push({ kind: 'popover', name: 'menu', trap: false, onOutside: () => outsideHits.push('pop'), contains: (node) => node === 'inside' })
  ok(layers.outside('inside') === false && outsideHits.length === 0, '层内点击不触发外点关闭')
  ok(layers.outside('outside') === true && outsideHits.join() === 'pop', '层外点击触发最上层关闭')
  layers.release(pop)

  ok(trapTargetIndex(3, 2, false) === 0 && trapTargetIndex(3, 0, true) === 2, 'Tab / Shift+Tab 在层内环绕')
  ok(trapTargetIndex(3, 1, false) === null && trapTargetIndex(0, 0, false) === null, '层内中间位置与空层不强制改焦点')

  const c = createInteractionCenter({ layers })
  c.setTasks([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
  c.openTask('a'); c.openTask('b')
  ok(c.handleKey({ key: 'k', ctrlKey: true }) === 'palette-toggle' && c.getState().paletteOpen, 'Ctrl+K 打开命令面板')
  // 面板宿主挂载 → 层栈里出现 palette 层（React 侧由 useInteractionLayer 压入）
  const paletteLayer = layers.push({ kind: 'modal', name: 'palette', trap: true, onEscape: () => c.palette.close() })
  ok(c.handleKey({ key: 'k', ctrlKey: true }) === 'palette-toggle' && !c.getState().paletteOpen, '面板打开时 Ctrl+K 收起')
  ok(c.handleKey({ key: 'n', ctrlKey: true }) === null && c.getState().composerTick === 0, '浮层打开时 Ctrl+N 不抢键')
  ok(layers.escape() && !c.getState().paletteOpen, '面板层消费 Escape（最上层）')
  layers.release(paletteLayer)
  ok(c.handleKey({ key: 'n', ctrlKey: true }) === 'new-task' && c.getState().composerTick === 1, '无浮层时 Ctrl+N 聚焦输入框')
  ok(c.handleKey({ key: 'c' }) === 'focus-composer', '裸 c 聚焦输入框')
  ok(c.handleKey({ key: 'w', ctrlKey: true }) === 'close-tab' && c.getState().activeId === 'a', 'Ctrl+W 关闭当前页签')
  c.openTask('b')
  ok(c.handleKey({ key: 'Tab', ctrlKey: true }) === 'cycle-tab-next' && c.getState().activeId === 'a', 'Ctrl+Tab 循环页签')
  ok(c.handleKey({ key: 'Tab', ctrlKey: true, shiftKey: true }) === 'cycle-tab-prev' && c.getState().activeId === 'b', 'Ctrl+Shift+Tab 反向循环')
  ok(c.handleKey({ key: 'c', target: { tagName: 'TEXTAREA' } }) === null, '焦点在输入框：裸键不抢')
  ok(c.handleKey({ key: 'w', ctrlKey: true, target: { tagName: 'INPUT' } }) === null, '焦点在输入框：Ctrl+W 不抢（不误关页签）')
  ok(c.handleKey({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT' } }) === 'palette-toggle', '焦点在输入框仍保留全局 Ctrl+K')
  ok(c.handleKey({ key: 'c', target: { tagName: 'DIV', isContentEditable: true } }) === null, 'contenteditable 同样不抢裸键')
  ok(c.handleKey({ key: 'k', ctrlKey: true, isComposing: true }) === null && c.handleKey({ key: 'k', ctrlKey: true, keyCode: 229 }) === null, '输入法组合中（isComposing / keyCode 229）一律不抢键')
  const layerId = layers.push({ kind: 'modal', name: 'confirm', trap: true, onEscape: () => c.navigate('board') })
  const beforeOverlay = c.getState().activeId
  ok(c.handleKey({ key: 'w', ctrlKey: true }) === null && c.getState().activeId === beforeOverlay, '模态打开时 Ctrl+W 让路')
  layers.release(layerId)
  // 非模态浮窗/菜单不封锁页面快捷键：overlay 只看最上层**模态**（layers.topModal），不是所有浮层
  const tickBefore = c.getState().composerTick
  const pageMenu = layers.push({ kind: 'popover', name: 'menu', trap: false })
  ok(c.handleKey({ key: 'n', ctrlKey: true }) === 'new-task' && c.getState().composerTick === tickBefore + 1, '菜单（popover）打开：Ctrl+N 不被封锁')
  const floatWin = layers.push({ kind: 'window', name: 'float-window', trap: false })
  ok(layers.topModal() === null && c.handleKey({ key: 'w', ctrlKey: true }) === 'close-tab', '非模态浮窗同样不封锁（topModal 为空）')
  const modalOverMenu = layers.push({ kind: 'modal', name: 'confirm', trap: true })
  ok(c.handleKey({ key: 'w', ctrlKey: true }) === null && c.handleKey({ key: 'n', ctrlKey: true }) === null, '菜单之上压了模态：快捷键重新让路')
  layers.release(modalOverMenu)
  layers.release(floatWin)
  layers.release(pageMenu)
  const paletteWasOpen = c.getState().paletteOpen
  ok(c.handleKey({ key: 'k', ctrlKey: true }) === 'palette-toggle' && c.getState().paletteOpen === !paletteWasOpen, '全部浮层关闭后 Ctrl+K 照常切换命令面板')
  c.palette.close()
  ok(resolveShortcut({ key: 'Escape' }, { overlay: null }) === null, 'Escape 不是应用快捷键（由层栈处理）')
}

/* ------------------------------------------------------------- 兼容转发 */

section('兼容转发：旧导出仍是同一个中心')
{
  ok(toast.success('旧导出转发') === 1 && ui.getState().toasts.length === 1, 'ui/Toasts 的 toast 转发到中心（业务调用已迁走，旧导出仍可用）')
  const pending = confirmDialog({ title: '兼容确认框' })
  ok(ui.getState().confirm?.title === '兼容确认框', 'ui/Confirm 的 confirmDialog 转发到中心的确认队列')
  ui.confirmHost.respond(true)
  ok(await pending === true, '兼容转发的 Promise 正常结算')
  ui.reset()
}

/* --------------------------------------------------------- 结构回归（源码） */

section('结构回归：导入环 / DOM 事件 / pet 路由')
{
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
  const app = read('src/renderer/src/App.tsx')
  const sideDock = read('src/renderer/src/ui/SideDock.tsx')
  const turnTimeline = read('src/renderer/src/components/task/TurnTimeline.tsx')
  const workspaceView = read('src/renderer/src/components/WorkspaceView.tsx')

  ok(!/new CustomEvent|dispatchEvent|addEventListener\('agentdeck:dock'/.test(sideDock) && /ui\.dock\.open/.test(sideDock), 'SideDock 不再派发/监听 DOM 自定义事件（改走中心订阅）')
  ok(/export function openDockItem\(item: DockItem\): DockHandle \{\s*return ui\.dock\.open\(item\)/.test(sideDock) && /export function closeDockItem\(id: string\): boolean \{\s*return ui\.dock\.close\(id\)/.test(sideDock), 'openDockItem/closeDockItem 为纯转发（转发到中心）')
  const petSettings = read('src/renderer/src/pet/PetSettingsPage.tsx')
  ok(/from '\.\.\/ui\/Toasts'/.test(petSettings) && /toast\.success\(/.test(petSettings), 'pet/ 未改动：仍走 ui/Toasts 兼容导出（证明转发是必需的）')
  ok(!/new KeyboardEvent|dispatchEvent/.test(app), 'App 已移除模拟键盘与自定义事件派发')
  ok(!/setTimeout\(/.test(app), 'App 已移除 60ms 延时补派发')
  ok(/ui\.handleKey\(/.test(app) && /useInteractionSelector/.test(app), 'App 快捷键走交互中心，界面状态改为订阅读取')
  ok(/\^#\\\/\?pet\$/.test(app) && /\^#\\\/\?pet-settings\$/.test(app), 'App 保留 #/pet 与 #/pet-settings 两个小助理路由')
  ok(!/from '\.\.\/ui\/SideDock'|from '\.\.\/\.\.\/ui\/SideDock'/.test(turnTimeline) && /ui\.dock\.update/.test(turnTimeline), 'TurnTimeline 不再 import SideDock（导入环已断），异步 diff 走 token 回写')
  ok(!/addEventListener\(FOCUS_WORKSPACE/.test(workspaceView) && /composerTick/.test(workspaceView), 'WorkspaceView 不再监听 DOM 事件，改用中心 composer 请求')

  // 触发焦点记录：必须在渲染期快照（早于 React autoFocus）+ 层用 useLayoutEffect（关闭当帧归还）
  const layerHook = read('src/renderer/src/hooks/useInteractionLayer.ts')
  const layerCore = read('src/renderer/src/ui/interaction-layer.ts')
  ok(/if \(open\) \{[\s\S]{0,200}captureTrigger\(/.test(layerHook), '触发焦点在**渲染期**抓（open 由 false→true 的那次 render），不是等 useEffect')
  ok(!/\buseEffect\b/.test(layerHook.split('\n')[0]) && /useLayoutEffect/.test(layerHook.split('\n')[0]), '浮层挂载/归还走 useLayoutEffect（不再 import useEffect）：关闭当帧就把焦点还回去，不留 body 空档')
  ok(/queueMicrotask/.test(layerHook) && /restoreFocusRef/.test(layerHook), '触发元素被就地替换（重命名）时有显式归还目标 + 微任务补挂')
  ok(/containsNode/.test(layerCore) && /pickRestoreTarget/.test(layerCore), '层栈提供「焦点是否还在浮层内」与归还目标挑选（纯逻辑可测）')

  // SideDock 页签焦点：不能再用分割线容器去找 tab
  ok(!/stripRef\.current\?\.querySelectorAll/.test(sideDock) && /tabRefs\.current\.get\(/.test(sideDock), 'SideDock 页签焦点改按 id 登记的 tabRefs 定位（不再从分割线 ref 里按序号找 tab）')
  ok(/const closeTab = \(index: number\)/.test(sideDock) && /focusTab\(next\.id\)/.test(sideDock), 'SideDock 关页签（Delete）后焦点交给接棒页签')

  // App 页签条：与 openTask 同源的过滤
  ok(/rootTabsOf\(tasks, tabs\)/.test(app) && /<TabBar tabs=\{rootTabs\}/.test(app), 'App 页签条用 rootTabsOf 过滤（与 openTask 路由同源）')
  ok(!/tabs\.filter\(\(id\) => !tasks\.find/.test(app), 'App 不再按 parentTaskId 一刀切过滤页签（断裂祖先任务被藏掉的根因）')

  // 目录就绪门控与草稿创建后的导航（本轮 Review Follow-up：先见目录再路由 + 防刷新乱序）
  const center = read('src/renderer/src/ui/interaction-center.ts')
  ok(/if \(ready\) ui\.setTasks/.test(app) && /waitForTaskListed/.test(app), 'App 只在目录就绪后喂目录；草稿创建后等目录可见再导航')
  ok(/topModal\(\)/.test(center) && !/overlay: layers\.topName\(\)/.test(center), '快捷键 overlay 只看最上层模态（topModal），非模态浮窗/菜单不封锁')

  // 全量渲染层导入环检测（相对导入，.ts/.tsx 双扩展名解析）
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(root, 'src/renderer/src'))
  const resolveImport = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec)
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return null
  }
  const graph = new Map()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const deps = []
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      if (!match[1].startsWith('.')) continue
      const resolved = resolveImport(file, match[1])
      if (resolved) deps.push(resolved)
    }
    graph.set(file, deps)
  }
  const cycles = []
  const visited = new Set()
  const stack = []
  const visit = (node) => {
    if (stack.includes(node)) { cycles.push([...stack.slice(stack.indexOf(node)), node].map((f) => path.relative(root, f).replace(/\\/g, '/'))); return }
    if (visited.has(node)) return
    visited.add(node)
    stack.push(node)
    for (const dep of graph.get(node) ?? []) visit(dep)
    stack.pop()
  }
  for (const file of graph.keys()) visit(file)
  ok(cycles.length === 0, `渲染层无导入环（SideDock↔TurnTimeline 环已打断），实测 ${cycles.length} 个环`)
  if (cycles.length) for (const cycle of cycles.slice(0, 5)) console.log('    ', cycle.join(' -> '))
}

console.log(`\n${failures === 0 ? '✅ UI INTERACTION CENTER SMOKE PASSED' : `❌ ${failures} 项断言失败`}`)

// L0 壳自替换（设计 docs/INSTALLER-FREE-HOT-UPDATE.md §5，Chromium 同款 rename dance）。
// 实测修正：完整 Electron 应用有多个子进程持有 exe/dll/asar，**目录级改名不可行**；
// 改用文件级腾挪（Chromium install_worker 同款）：被占用的目标先改名 .old-<ts> 让位再放新。
// OS 语义依据 E3：Windows 运行中 exe 可改名不可删除——清理必然延后到下次启动。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { extractZipStore } from './zip'

/** 文件级 dance 的放置顺序：普通文件 → asar → exe（ABI 配对文件最后动，缩小不一致窗口） */
const PLACE_ORDER = (rel: string): number => {
  if (rel === 'AgentDeck.exe') return 2
  if (/^resources[/\\]app\.asar$/i.test(rel)) return 1
  return 0
}

function walkRel(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkRel(p, base, out)
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

export interface ShellDirs {
  /** 应用目录（exe 所在，如 …\AgentDeck 便携目录） */
  appDir: string
  /** appDir 的父目录（staging 工作区所在，同卷保证 rename 原子） */
  parentDir: string
}

/** staging 工作区：<appDir>.staging-<ts>（新壳解压目录；与 appDir 同卷） */
export const stagingDirFor = (appDir: string, ts = Date.now()) => path.join(path.dirname(appDir), `${path.basename(appDir)}.staging-${ts}`)

/** 单文件让位名：X → X.old-<ts>（保留在原目录，sweep 清扫） */
const agedName = (file: string, ts: number) => `${file}.old-${ts}`

/**
 * 壳 zip → staging 解压核对（§5.1 下载与校验；files 清单核对由调用方 updater 做）。
 * 返回 staging 目录（内容 = zip 根 = 应用目录内容）。
 */
export function stageShellZip(zipPath: string, appDir: string): string {
  const staging = stagingDirFor(appDir)
  fs.mkdirSync(staging, { recursive: true })
  try {
    extractZipStore(zipPath, staging)
    if (!fs.existsSync(path.join(staging, path.basename(process.execPath)))) {
      throw new Error(`壳 zip 内容异常：解压根未见 ${path.basename(process.execPath)}（zip 布局必须是应用目录内容而非外层再包一层）`)
    }
    return staging
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch { /* 清理失败不放大错误 */ }
    throw error
  }
}

/**
 * §5.3 第一阶段（进程存活期）：把 staging 中**未被占用**的文件先放到位（直改不腾挪），
 * 返回剩余（被占用）的相对路径清单——交给 swap helper 在进程退出后处理。
 */
export function placeUnlockedFiles(appDir: string, stagedDir: string): string[] {
  const rels = walkRel(stagedDir).sort((a, b) => PLACE_ORDER(a) - PLACE_ORDER(b) || (a < b ? -1 : 1))
  const remaining: string[] = []
  for (const rel of rels) {
    const src = path.join(stagedDir, ...rel.split('/'))
    const dst = path.join(appDir, ...rel.split('/'))
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.renameSync(src, dst)
    } catch {
      remaining.push(rel)
    }
  }
  return remaining
}

/**
 * §5.3 第二阶段（swap helper，Chromium setup 同款）：分离的助手进程（本 exe +
 * ELECTRON_RUN_AS_NODE，机制与 sidecar 一致）等主进程 PID 消失后，把 staging 剩余文件
 * 逐个就位（此时无锁；仍失败的反复重试），完毕后拉起新壳并自退。让位文件 .old-<ts> 留证，
 * 下次启动由 sweepOldShellDirs 清扫。helper 脚本落盘在 userData（不随壳目录变化）。
 */
export function spawnSwapHelper(appDir: string, stagedDir: string, parentPid: number, version: string, userDataDir: string): void {
  const exeName = path.basename(process.execPath)
  const helperDir = path.join(userDataDir, 'hot-shell')
  fs.mkdirSync(helperDir, { recursive: true })
  const helperPath = path.join(helperDir, `swap-helper-${Date.now()}.cjs`)
  const script = `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
const [mode,appDir,stagedDir,parentPid,version,exeName,logFile]=process.argv.slice(2)
const log=(m)=>{try{fs.appendFileSync(logFile,new Date().toISOString()+' ['+mode+'] '+m+'\\n')}catch{}}
const waitExit=(pid)=>new Promise((res)=>{const t=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(t);res()}},200)})
const walk=(d,b=d,o=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,b,o);else if(e.isFile())o.push(path.relative(b,p).split(path.sep).join('/'))}return o}
const launchNewExe=()=>{const exe=path.join(appDir,exeName);log('launching '+exe);const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;spawn(exe,['--agentdeck-hot-applied',version,'--agentdeck-relaunch-retry'],{detached:true,stdio:'ignore',env}).unref();setTimeout(()=>process.exit(0),1000)}
;(async()=>{
  log('start; waiting pid '+parentPid)
  await waitExit(Number(parentPid))
  const ts=Date.now()
  for(let round=0;round<40;round++){
    const rels=walk(stagedDir)
    if(rels.length===0)break
    let placed=0
    for(const rel of rels){
      const src=path.join(stagedDir,...rel.split('/'))
      const dst=path.join(appDir,...rel.split('/'))
      try{
        fs.mkdirSync(path.dirname(dst),{recursive:true})
        try{fs.renameSync(src,dst)}
        catch{fs.renameSync(dst,dst+'.old-'+ts);fs.renameSync(src,dst)}
        placed++
      }catch(e){log('retry '+rel+': '+e.code)}
    }
    log('round '+round+' placed='+placed+' left='+rels.length)
    if(rels.length===0)break
    await new Promise((r)=>setTimeout(r,500))
  }
  if(mode!=='finish'){
    const left=walk(stagedDir)
    if(left.length===0){
      try{fs.rmSync(stagedDir,{recursive:true,force:true})}catch{}
      launchNewExe()
      return
    }
    // 自举死角：icudtl/v8 快照被本进程（exe 即 node）持有 → 第三棒 = staging 内新 exe 跑同脚本
    // finish 模式（它映射的是 staging 自己的数据文件，appDir 的副本随本进程死亡解锁）
    log('handing '+left.length+' stragglers to staging-exe finisher: '+left.join(', '))
    const binDir=path.join(path.dirname(logFile),'finisher-bin')
    fs.rmSync(binDir,{recursive:true,force:true})
    fs.mkdirSync(binDir,{recursive:true})
    for(const n of [exeName,'icudtl.dat','v8_context_snapshot.bin']){const s=fs.existsSync(path.join(stagedDir,n))?path.join(stagedDir,n):(n===exeName?path.join(appDir,n):null);if(s)fs.copyFileSync(s,path.join(binDir,n))}
    spawn(path.join(binDir,exeName),[process.argv[1],'finish',appDir,stagedDir,String(process.pid),version,exeName,logFile],{stdio:'ignore'}).unref()
    log('finisher spawned')
    // exe/asar 已就位：helper 直接拉起新壳（与 finisher 的启动由单实例锁去重；
    // 若 finisher 被安全软件拦截，用户至少已经运行在新壳上，仅 2 个数据文件暂留旧版）
    launchNewExe()
    log('helper launched exe; exiting')
    return
  }
  try{fs.rmSync(stagedDir,{recursive:true,force:true})}catch{}
  try{fs.rmSync(path.join(path.dirname(logFile),'finisher-bin'),{recursive:true,force:true})}catch{}
  launchNewExe()
})().catch((e)=>{log('FATAL '+e.message);process.exit(1)})
`
  fs.writeFileSync(helperPath, script)
  // detached 必须：Chromium 主进程把子进程纳入 KILL_ON_JOB_CLOSE 的 Job，app 退出即团灭；
  // libuv detached 带 CREATE_BREAKAWAY_FROM_JOB 逃逸（实测非 detached 的 helper 活不过 app 退出）
  const child = spawn(process.execPath, [helperPath, 'swap', appDir, stagedDir, String(parentPid), version, exeName, path.join(helperDir, 'swap-helper.log')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  child.unref()
}

/** appDir 内（任意深度）的 .old-<ts> 让位文件，按时间戳分组：Map<ts, files[]>（新→旧） */
export function listAgedFiles(appDir: string): Array<{ ts: number; files: string[] }> {
  const groups = new Map<number, string[]>()
  const visit = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) visit(p)
      else if (e.isFile()) {
        const m = /\.old-(\d+)$/.exec(e.name)
        if (m) {
          const ts = Number(m[1]) || 0
          groups.set(ts, [...(groups.get(ts) ?? []), p])
        }
      }
    }
  }
  visit(appDir)
  return [...groups.entries()].map(([ts, files]) => ({ ts, files })).sort((a, b) => b.ts - a.ts)
}

/**
 * 壳回滚（§6）：把最新一批 .old-<ts> 让位文件换回来（当前对应文件让位为新的 .old-<ts2>）。
 * 调用方随后 relaunch。
 */
export function rollbackShell(appDir: string, clearPointers: () => void): void {
  const newest = listAgedFiles(appDir)[0]
  if (!newest) throw new Error('没有可回退的壳版本（无 .old-<ts> 让位文件）')
  const ts2 = Date.now()
  for (const aged of newest.files) {
    const original = aged.replace(/\.old-\d+$/, '')
    let backupCurrent: string | null = null
    try {
      if (fs.existsSync(original)) {
        backupCurrent = agedName(original, ts2)
        fs.renameSync(original, backupCurrent)
      }
      fs.renameSync(aged, original)
    } catch (error) {
      if (backupCurrent) {
        try { fs.renameSync(backupCurrent, original) } catch { /* 极端 */ }
      }
      throw new Error(`壳回滚失败 ${path.relative(appDir, original)}：${(error as Error).message}（该文件已回滚原状）`)
    }
  }
  clearPointers()
}

/**
 * 下次启动残留清扫（§5.4）：staging 工作区整体删除 + appDir 内 .old-<ts> 让位文件删除
 * （保留最近一批作回滚源，更旧的清理；被占用则跳过下次再试）。后台执行，不阻塞启动。
 */
export function sweepOldShellDirs(appDir: string): void {
  const parent = path.dirname(appDir)
  const base = path.basename(appDir)
  if (fs.existsSync(parent)) {
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(`${base}.staging-`)) {
        try {
          fs.rmSync(path.join(parent, name), { recursive: true, force: true })
        } catch { /* 占用：下次再试 */ }
      }
    }
  }
  const groups = listAgedFiles(appDir)
  groups.forEach((group, index) => {
    if (index < 1) return // 最新一批保留 = 壳回滚源
    for (const file of group.files) {
      try {
        fs.rmSync(file, { force: true })
      } catch { /* 句柄未释放：下次再试 */ }
    }
  })
}

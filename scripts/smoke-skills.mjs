// smoke-skills.mjs：共享目录 + 技能库冒烟（按 docs/SKILLS-SHARED-DIR.md §6）
// 覆盖：frontmatter 往返、list/save/rename/delete、import 重名、
// install→in-sync→改源→outdated→重装→in-sync、uninstall、`..` 逃逸拒绝、CRLF 归一不误报
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-skills-smoke-'))
const skillsBundle = path.join(outDir, 'skills.cjs')
const targetsBundle = path.join(outDir, 'skill-targets.cjs')
await build({ entryPoints: [path.join(root, 'src/main/skills.ts')], outfile: skillsBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
await build({ entryPoints: [path.join(root, 'src/main/skill-targets.ts')], outfile: targetsBundle, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const skills = await import(pathToFileURL(skillsBundle).href)
const targets = await import(pathToFileURL(targetsBundle).href)

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}
const expectReject = (fn, label) => {
  try { fn(); ok(false, `${label}（应拒绝却通过了）`) } catch { ok(true, label) }
}
const skillFile = (base, name) => path.join(base, 'skills', name, 'SKILL.md')

// === 场景 1：首次访问生成 README.md 与 skills/（幂等）===
const shared = path.join(outDir, 'shared')
skills.ensureSharedDir(shared)
ok(fs.existsSync(path.join(shared, 'README.md')), '首次访问生成 README.md')
ok(fs.statSync(path.join(shared, 'skills')).isDirectory(), '首次访问生成 skills/ 目录')
const readmeBefore = fs.readFileSync(path.join(shared, 'README.md'), 'utf8')
skills.ensureSharedDir(shared)
ok(fs.readFileSync(path.join(shared, 'README.md'), 'utf8') === readmeBefore, '重复访问不覆盖 README.md')

// === 场景 2：save/read 往返（frontmatter 生成与剥离）===
const meta = skills.saveSkill(shared, 'code-review', { description: '按仓库约定审查代码', body: '# 步骤\n\n1. 读 diff\n2. 给结论' })
ok(meta.name === 'code-review' && meta.description === '按仓库约定审查代码', 'saveSkill 返回 SkillMeta')
ok(meta.updatedAt > 0 && meta.bodyBytes > 0 && meta.files.includes('SKILL.md'), 'SkillMeta 带 updatedAt/bodyBytes/files')
const detail = skills.readSkill(shared, 'code-review')
ok(detail.description === '按仓库约定审查代码', 'readSkill 描述往返')
ok(detail.body === '# 步骤\n\n1. 读 diff\n2. 给结论', 'readSkill body 为去 frontmatter 后正文')
const raw = fs.readFileSync(skillFile(shared, 'code-review'), 'utf8')
ok(raw.startsWith('---\nname: code-review\ndescription: 按仓库约定审查代码\n---'), 'SKILL.md 落盘含 frontmatter')
ok(!fs.existsSync(`${skillFile(shared, 'code-review')}.tmp`), 'tmp+rename 后不留临时文件')

// === 场景 3：list 排序与无 frontmatter 兼容 ===
skills.saveSkill(shared, 'daily-report', { description: '汇总日报', body: 'body' })
const metas = skills.listSkills(shared)
ok(metas.length === 2 && metas[0].name === 'code-review' && metas[1].name === 'daily-report', 'listSkills 按名升序')
fs.mkdirSync(path.join(shared, 'skills', 'legacy'), { recursive: true })
fs.writeFileSync(skillFile(shared, 'legacy'), '纯正文，没有 frontmatter')
const legacy = skills.readSkill(shared, 'legacy')
ok(legacy && legacy.description === '' && legacy.body.includes('纯正文'), '无 frontmatter 的 SKILL.md 可列出且不丢内容')

// === 场景 4：重命名（originName）与冲突拒绝 ===
skills.saveSkill(shared, 'renamed', { description: 'd', body: 'b', originName: 'daily-report' })
ok(!fs.existsSync(path.join(shared, 'skills', 'daily-report')) && fs.existsSync(path.join(shared, 'skills', 'renamed')), '重命名即目录改名')
expectReject(() => skills.saveSkill(shared, 'code-review', { description: '', body: '', originName: 'renamed' }), '重命名到已存在目录被拒绝')

// === 场景 5：非法名 / `..` 逃逸拒绝 ===
for (const bad of ['../evil', '..', 'a/b', 'a\\b', 'Upper', '', '.hidden', '-lead']) {
  expectReject(() => skills.saveSkill(shared, bad, { description: '', body: '' }), `saveSkill 拒绝非法名: ${JSON.stringify(bad)}`)
}
expectReject(() => skills.readSkill(shared, '../evil'), 'readSkill 拒绝 .. 逃逸')
expectReject(() => skills.deleteSkill(shared, '../../outside'), 'deleteSkill 拒绝 .. 逃逸')
ok(fs.readdirSync(path.join(shared, 'skills')).every((name) => /^[a-z0-9][a-z0-9._-]*$/.test(name)), '共享目录外没有被写入的目录')

// === 场景 6：删除 ===
skills.deleteSkill(shared, 'renamed')
ok(!fs.existsSync(path.join(shared, 'skills', 'renamed')), 'deleteSkill 移除技能目录')

// === 场景 7：导入（目录 / 单文件 / 重名 -2 后缀）===
const srcDir = path.join(outDir, 'src-skill')
fs.mkdirSync(srcDir)
fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '---\nname: ignored\ndescription: 导入源\n---\nhi')
fs.writeFileSync(path.join(srcDir, 'extra.txt'), '附加文件')
const imp1 = skills.importSkill(shared, srcDir)
ok(imp1.name === 'src-skill' && skills.readSkill(shared, 'src-skill').description === '导入源', '导入目录（名字取目录名）')
ok(imp1.files.includes('extra.txt'), '附加文件跟随导入')
const imp2 = skills.importSkill(shared, srcDir)
ok(imp2.name === 'src-skill-2', '重名导入自动 -2 后缀')
const fileSrc = path.join(outDir, 'notes.md')
fs.writeFileSync(fileSrc, '# notes')
ok(skills.importSkill(shared, fileSrc).name === 'notes', '导入单个 .md 文件')
expectReject(() => skills.importSkill(shared, path.join(outDir, 'no-such-dir')), '导入不存在的路径被拒绝')
const dirNoSkill = path.join(outDir, 'empty-dir')
fs.mkdirSync(dirNoSkill)
expectReject(() => skills.importSkill(shared, dirNoSkill), '导入缺 SKILL.md 的目录被拒绝')

// === 场景 8：安装目标注册表 ===
const home = path.join(outDir, 'home')
const tgts = targets.resolveSkillTargets(home)
ok(tgts.length === 4 && tgts.map((t) => t.id).join(',') === 'claude,codex,zcode,agents', '固定四项目标')
ok(tgts.find((t) => t.id === 'claude').dir === path.join(home, '.claude', 'skills'), 'claude 目标指向 ~/.claude/skills')
ok(tgts.find((t) => t.id === 'agents').dir === path.join(home, '.agents', 'skills'), 'agents 目标指向 ~/.agents/skills（跨工具共享位）')

// === 场景 9：install → in-sync → 改源 → outdated → 重装 → in-sync ===
const sourceDir = path.join(shared, 'skills', 'code-review')
const claudeSkills = path.join(home, '.claude', 'skills')
targets.installSkill(shared, 'claude', 'code-review', home)
ok(fs.existsSync(path.join(claudeSkills, 'code-review', 'SKILL.md')), 'install 整目录拷贝到目标')
ok(targets.skillSyncState(sourceDir, claudeSkills, 'code-review') === 'in-sync', '安装后 in-sync')
// CRLF 归一：同内容不同换行不误报
const lf = fs.readFileSync(skillFile(shared, 'code-review'), 'utf8')
fs.writeFileSync(skillFile(shared, 'code-review'), lf.replace(/\n/g, '\r\n'))
ok(targets.skillSyncState(sourceDir, claudeSkills, 'code-review') === 'in-sync', 'CRLF→LF 归一，换行差异不误报 outdated')
// 改源 → outdated
skills.saveSkill(shared, 'code-review', { description: 'v2 描述', body: 'new body' })
ok(targets.skillSyncState(sourceDir, claudeSkills, 'code-review') === 'outdated', '改源后 outdated')
// 重装 → in-sync（先删后拷不残留）
fs.writeFileSync(path.join(claudeSkills, 'code-review', 'stale.txt'), '旧残留')
targets.installSkill(shared, 'claude', 'code-review', home)
ok(!fs.existsSync(path.join(claudeSkills, 'code-review', 'stale.txt')), '重装先删后拷，不残留旧文件')
ok(targets.skillSyncState(sourceDir, claudeSkills, 'code-review') === 'in-sync', '重装后恢复 in-sync')
// 未安装目标 → missing
ok(targets.skillSyncState(sourceDir, path.join(home, '.codex', 'skills'), 'code-review') === 'missing', '未安装目标为 missing')

// === 场景 10：uninstall ===
targets.uninstallSkill('claude', 'code-review', home)
ok(!fs.existsSync(path.join(claudeSkills, 'code-review')), 'uninstall 只删目标同名目录')
ok(targets.skillSyncState(sourceDir, claudeSkills, 'code-review') === 'missing', '卸载后 missing')

// === 场景 11：目标侧 `..` 逃逸拒绝 ===
expectReject(() => targets.installSkill(shared, 'claude', '../evil', home), 'installSkill 拒绝 .. 逃逸')
expectReject(() => targets.uninstallSkill('claude', '../evil', home), 'uninstallSkill 拒绝 .. 逃逸')
expectReject(() => targets.uninstallSkill('claude', '..', home), 'uninstallSkill 拒绝纯 ..')
expectReject(() => targets.skillSyncState(sourceDir, claudeSkills, '../../evil'), 'skillSyncState 拒绝 .. 逃逸')
expectReject(() => targets.installSkill(shared, 'nope', 'code-review', home), '未知 targetId 被拒绝')
ok(!fs.existsSync(path.join(home, 'evil')) && !fs.existsSync(path.join(shared, 'evil')), '逃逸尝试没有在任何根外留下目录')

if (failed > 0) {
  console.error(`\n❌ SKILLS SMOKE FAILED: ${failed} 项未通过`)
  process.exit(1)
}
console.log('\n✅ SKILLS SMOKE PASSED')

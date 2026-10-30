#!/usr/bin/env node
/**
 * scripts/install.mjs —— 把自己登记成 DSH 的**正经插件**（幂等，可以反复跑）
 * ============================================================================
 * 目标只有一个：**插件库里的「卸载」能真的删干净**（2026-10-28 的教训）。
 *
 * 插件管理器卸载时会做三件事，也只会做这三件：
 *   ① 从 `dependencies` 里去掉包（pnpm remove）
 *   ② 从 `dsh.profile.bundles` 里去掉名字
 *   ③ 删掉「市场自己写的 patch 行」和「包自带 bundle patch 里的行」
 * 它**绝不改写用户的 cordis.patch.yml** —— 只要那里还有一条 insert 引用这个包，
 * 卸载就直接 409 拒绝（lib/routes.js：「市场不会自动改写用户补丁」）。
 *
 * ⇒ 所以本插件的规矩是：**用户的 cordis.patch.yml 里一行都不写**。
 *   入口（insert）和配置（root）都放在本包自带的 cordis.patch.yml 里 ——
 *   那是包的一部分，卸载时跟着包一起消失，天然干净。
 *
 * 做四件事：
 *   ① 建知识库目录骨架
 *   ② junction 进 <profile>/node_modules（pnpm 还没装时的兜底）
 *   ③ package.json：dependencies 加 `link:<本包>`，bundles 加包名
 *   ④ 清掉历史遗留的 `# >>> feiyu-kb … # <<< feiyu-kb` 块（早期版本写过的）
 *
 * 用法：node scripts/install.mjs [--profiles desktop,headless] [--dry] [--root <路径>]
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DEFAULT_ROOT, resolveRoot, ensureRoot } from '../lib/kb.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const PKG = pkg.name

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const pIdx = argv.indexOf('--profiles')
const profiles = (pIdx >= 0 ? String(argv[pIdx + 1] || '') : 'desktop,headless')
  .split(',').map((s) => s.trim()).filter(Boolean)
const rootIdx = argv.indexOf('--root')
const kbRoot = resolveRoot(rootIdx >= 0 ? argv[rootIdx + 1] : DEFAULT_ROOT)

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const log = (...a) => console.log(...a)
const posix = (p) => String(p).replace(/\\/g, '/')

const MARK_BEGIN = '# >>> feiyu-kb'
const MARK_END = '# <<< feiyu-kb'

/** 清掉早期版本写进用户 patch 的块（现在一行都不该留） */
function stripLegacyRows(text) {
  let out = text
  out = out.replace(new RegExp(`\\n?${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'g'), '\n')
  out = out.replace(/\n?# ── 大肥鱼知识库[\s\S]*$/, '\n')
  // 只剩注释 = 空补丁；loader 要的是数组，补回 `[]`，别留一个 null 给宿主
  const meaningful = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
  if (meaningful === 0) return out.trimEnd() + '\n[]\n'
  return out.trimEnd() + '\n'
}

/** 写 package.json：dependency(link:) + bundles */
function registerPackage(packageFile, name, dir) {
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  const changed = []
  manifest.dependencies = manifest.dependencies || {}
  const spec = `link:${posix(dir)}`
  if (manifest.dependencies[name] !== spec) {
    manifest.dependencies[name] = spec
    changed.push('dependencies')
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { ok: false, why: '这份 profile 没有 dsh.profile.bundles', changed }
  if (!bundles.includes(name)) { bundles.push(name); changed.push('bundles') }
  if (changed.length) writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { ok: true, changed }
}

log(`插件目录：${posix(pluginDir)}`)
log(`知识库根：${kbRoot}`)
if (!dry) ensureRoot(kbRoot)

for (const profile of profiles) {
  const dir = join(dshHome, 'profiles', profile)
  if (!existsSync(dir)) { log(`⚠️ 跳过 ${profile}：没有这个 profile（${dir}）`); continue }
  log(`\n[${profile}]`)

  // ② junction（pnpm 未接管前的兜底；接管后 pnpm 会自己建链接）
  const nm = join(dir, 'node_modules')
  const link = join(nm, PKG)
  if (!dry) mkdirSync(nm, { recursive: true })
  let linked = false
  try { const st = lstatSync(link); linked = st.isSymbolicLink() || st.isDirectory() } catch { linked = false }
  if (linked) log(`  · 链接已存在（${PKG}）`)
  else if (dry) log(`  · [dry] 会建 junction → ${link}`)
  else {
    try { symlinkSync(pluginDir, link, 'junction'); log(`  · junction 建好 → ${link}`) }
    catch (e) { log(`  · ⚠️ junction 失败（${e?.message ?? e}）`) }
  }

  // ③ 依赖 + bundle
  const packageFile = join(dir, 'package.json')
  if (dry) { log('  · [dry] 会写 dependencies(link:) + dsh.profile.bundles'); continue }
  const r = registerPackage(packageFile, PKG, pluginDir)
  if (!r.ok) log(`  · ⚠️ ${r.why}（插件库不会显示它）`)
  else log(r.changed.length ? `  · 已登记：${r.changed.join(' + ')}` : '  · 依赖与 bundles 都已登记')

  // ④ 清掉历史遗留行（只看非注释行 —— 注释里提到 feiyu-kb 不算"有行"）
  const patchFile = join(dir, 'cordis.patch.yml')
  const hasRow = (t) => t.split('\n').some((l) => !l.trim().startsWith('#') && /feiyu-kb/.test(l))
  if (existsSync(patchFile)) {
    const before = readFileSync(patchFile, 'utf8')
    if (hasRow(before)) {
      writeFileSync(patchFile, stripLegacyRows(before), 'utf8')
      log('  · 已清掉用户 patch 里的 feiyu-kb 行（卸载要干净，就不能留这些）')
    } else {
      log('  · 用户 patch 里没有 feiyu-kb 行（干净）')
    }
  }
}

log('\n完成。')
log(`  现在就能用：node "${join(pluginDir, 'lib', 'kb-cli.mjs')}" status`)
log('  插件库可见 / 工具回到会话里：**重启一次 GUI**（bundles 是启动时组合的）')
log('  卸载：插件库里点「卸载」即可 —— 包、依赖、bundles、入口全在包里，不会有残留行')

// ── 顺手把两条通道的搭档也装上（--no-peers 可跳过）──────────────────────
if (!argv.includes('--no-peers')) {
  const extra = [join(here, 'install-peers.mjs')]
  if (dry) extra.push('--dry')
  if (argv.includes('--no-network')) extra.push('--no-network')
  const pIdx2 = argv.indexOf('--profiles')
  if (pIdx2 >= 0) extra.push('--profiles', String(argv[pIdx2 + 1] || ''))
  const { spawnSync } = await import('node:child_process')
  spawnSync(process.execPath, extra, { stdio: 'inherit' })
} else {
  log('\n（--no-peers：没装搭档插件；之后可单独跑 node scripts/install-peers.mjs）')
}

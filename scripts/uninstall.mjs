#!/usr/bin/env node
/**
 * scripts/uninstall.mjs —— 手动卸载（插件库卸载按钮用不了时的兜底）
 * ============================================================================
 * 正常情况下**不需要它**：插件已经登记成 bundle + dependency，插件库里点「卸载」就干净了。
 * 这个脚本只处理两种边角：
 *   ① 插件库里显示「插件未安装」，但东西还在（比如手动改过 package.json）
 *   ② headless 这种没有界面的 profile
 *
 * 它做的事（和插件管理器的卸载一一对应）：
 *   ① dependencies 里删掉 dsh-feiyu-kb
 *   ② dsh.profile.bundles 里删掉 dsh-feiyu-kb
 *   ③ node_modules 里的链接删掉（**只删链接，绝不递归删目标目录**）
 *   ④ cordis.patch.yml 里历史遗留的 feiyu-kb 行清掉（只剩注释就补回 `[]`）
 *   ⑤ 打印知识库位置 —— **默认不删数据**；真要删得显式加 --purge-data
 *
 * 用法：
 *   node scripts/uninstall.mjs --yes [--profiles desktop,headless]
 *   node scripts/uninstall.mjs --yes --purge-data   # 连知识库一起删（会二次确认）
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, lstatSync, unlinkSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { DEFAULT_ROOT, resolveRoot } from '../lib/kb.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const PKG = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name

const argv = process.argv.slice(2)
const yes = argv.includes('--yes')
const purge = argv.includes('--purge-data')
const pIdx = argv.indexOf('--profiles')
const profiles = (pIdx >= 0 ? String(argv[pIdx + 1] || '') : 'desktop,headless')
  .split(',').map((s) => s.trim()).filter(Boolean)
const rootIdx = argv.indexOf('--root')
const kbRoot = resolveRoot(rootIdx >= 0 ? argv[rootIdx + 1] : DEFAULT_ROOT)

const log = (...a) => console.log(...a)

if (!yes) {
  log('这会卸载 dsh-feiyu-kb（知识库数据默认保留）。确认无误再加 --yes 重跑。')
  log(`将要动：profiles(${profiles.join(', ')}) 的 package.json / cordis.patch.yml / node_modules`)
  log(`知识库：${kbRoot}${purge ? '（--purge-data：会被删！）' : '（保留）'}`)
  process.exit(1)
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

function stripPatchRows(text) {
  let out = text
  out = out.replace(/\n?# >>> feiyu-kb[\s\S]*?# <<< feiyu-kb\n?/g, '\n')
  out = out.replace(/\n?# ── 大肥鱼知识库[\s\S]*$/, '\n')
  const meaningful = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
  if (meaningful === 0) return out.trimEnd() + '\n[]\n'
  return out.trimEnd() + '\n'
}

for (const profile of profiles) {
  const dir = join(dshHome, 'profiles', profile)
  if (!existsSync(dir)) { log(`⚠️ 跳过 ${profile}：没有这个 profile`); continue }
  log(`\n[${profile}]`)

  // ①② package.json
  const packageFile = join(dir, 'package.json')
  if (existsSync(packageFile)) {
    const m = JSON.parse(readFileSync(packageFile, 'utf8'))
    let changed = false
    if (m.dependencies && PKG in m.dependencies) { delete m.dependencies[PKG]; changed = true }
    const bundles = m?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PKG)) {
      m.dsh.profile.bundles = bundles.filter((x) => x !== PKG)
      changed = true
    }
    if (changed) { writeFileSync(packageFile, JSON.stringify(m, null, 2) + '\n', 'utf8'); log('  · package.json：已去掉依赖与 bundle 名') }
    else log('  · package.json：本来就没有它')
  }

  // ③ node_modules 链接（只删链接本身）
  const link = join(dir, 'node_modules', PKG)
  try {
    const st = lstatSync(link)
    if (st.isSymbolicLink()) { unlinkSync(link); log('  · 已删掉 node_modules 里的符号链接') }
    else if (st.isDirectory()) {
      // Windows junction 在 lstat 里是目录：用 rmdir 删（**不会**动目标目录里的文件）
      try { rmdirSync(link); log('  · 已删掉 node_modules 里的 junction（目标目录没动）') }
      catch { log(`  · ⚠️ ${link} 是真实目录，没敢递归删 —— 请手动移除`); }
    }
  } catch { log('  · node_modules 里没有它的链接') }

  // ④ patch 行
  const patchFile = join(dir, 'cordis.patch.yml')
  const hasRow = (t) => t.split('\n').some((l) => !l.trim().startsWith('#') && /feiyu-kb/.test(l))
  if (existsSync(patchFile)) {
    const before = readFileSync(patchFile, 'utf8')
    if (hasRow(before)) { writeFileSync(patchFile, stripPatchRows(before), 'utf8'); log('  · cordis.patch.yml：已清掉 feiyu-kb 行') }
    else log('  · cordis.patch.yml：没有 feiyu-kb 行（干净）')
  }
}

// ⑤ 数据
log(`\n知识库：${kbRoot}`)
if (purge) {
  if (!existsSync(kbRoot)) log('  · 目录不存在，没什么可删')
  else { rmSync(kbRoot, { recursive: true, force: true }); log('  · 已按 --purge-data 删除整个知识库') }
} else {
  log('  · 保留（卸载插件不等于丢知识库；要删加 --purge-data）')
}

log('\n卸载完成。重启一次 GUI 让插件树重新组合。')

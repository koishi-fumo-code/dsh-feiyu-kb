#!/usr/bin/env node
/**
 * scripts/compose-check.mjs —— 模拟一次 DSH 启动时的插件树合成
 * ============================================================================
 * 为什么要有它：之前崩机不是因为某个插件"写得烂"，而是**包清单不自洽**
 * （声明 dsh.client 却没有 exports["./client"]），启动期 client-modules 直接抛致命错误。
 * preflight 查包本身，这个脚本查**合起来会不会出事**：
 *
 *   ① 按 profile 的 dsh.profile.bundles 顺序，逐个读它的 dsh.bundle.patch
 *   ② 像 loader 那样把 insert / id 覆盖 / disabled 叠起来
 *   ③ 再叠 profile 自己的 cordis.patch.yml
 *   ④ 报告：最终条目、重复 id、解析不到的 bundle、每个包的 client 出口是否完整
 *
 * 用法：node scripts/compose-check.mjs [--profile <目录>]
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

const pi = process.argv.indexOf('--profile')
const profileDir = resolve(
  (pi >= 0 ? process.argv[pi + 1] : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop'))
    .replace(/^~/, homedir()),
)

let fatal = 0
const bad = (m) => { fatal++; console.log(`  [FAIL] ${m}`) }
const ok = (m) => console.log(`  [OK]   ${m}`)
const info = (m) => console.log(`  ·      ${m}`)

const req = createRequire(join(profileDir, 'package.json'))
const yamlMod = (() => { try { return req('js-yaml') } catch { return null } })()
if (!yamlMod) { console.log('拿不到 js-yaml，无法严格解析 —— 先跑 preflight 确认包清单'); process.exit(1) }

// ⚠️ DSH 的 patch 允许 `!!js` 表达式（如 dsh-better-sidebar 里的条件），
//    标准 js-yaml 遇到未知标签会直接抛错 —— 注册一个"原样收下"的类型，别把它当成语法错误。
const jsTag = new yamlMod.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (s) => s })
const SCHEMA = yamlMod.DEFAULT_SCHEMA.extend([jsTag])
const yaml = { load: (text, opt) => yamlMod.load(text, { ...opt, schema: SCHEMA }) }

const readYaml = (file) => {
  const text = readFileSync(file, 'utf8')
  const v = yaml.load(text)
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) throw new Error(`${file} 顶层不是数组`)
  return v
}

console.log(`\nprofile: ${profileDir}\n`)

/* ① profile manifest */
let manifest
try {
  manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  ok('profile package.json 合法')
} catch (e) { bad(`profile package.json 坏了：${e.message}`); process.exit(1) }

const bundles = manifest?.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.length) { bad('dsh.profile.bundles 不存在或为空'); process.exit(1) }
ok(`bundles：${bundles.length} 项`)

/* ② 逐层叠加 */
const tree = new Map()          // id -> { id, name, config, from }
const order = []
const problems = []

for (const name of bundles) {
  let pkg = null
  let pkgPath = ''
  try {
    pkgPath = req.resolve(name + '/package.json')
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    // @deepseek-ai/* 由 DSH 安装目录提供，从 profile 解析不到是正常的
    if (name.startsWith('@deepseek-ai/')) { info(`${name}（宿主自带，跳过解析）`); continue }
    bad(`${name}：解析不到（${e.code || e.message}）`)
    continue
  }

  // 宿主的硬要求：声明了 client 就必须有 ./client 出口
  if (pkg?.dsh?.client) {
    let okClient = false
    try { req.resolve(name + '/client'); okClient = true } catch { /* 下面报 */ }
    if (!okClient) problems.push(`${name}：声明了 dsh.client 但没有 ./client 出口（**启动会失败**）`)
  }

  const patchRel = pkg?.dsh?.bundle?.patch
  if (!patchRel) { info(`${name}：没有 bundle patch（纯 host 插件）`); continue }
  const patchFile = resolve(dirname(pkgPath), patchRel)
  if (!existsSync(patchFile)) { bad(`${name}：bundle patch 文件不存在 ${patchFile}`); continue }

  let rows
  try { rows = readYaml(patchFile) } catch (e) { bad(`${name}：bundle patch 解析失败 —— ${e.message}`); continue }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (Array.isArray(row.insert)) {
      for (const ins of row.insert) {
        if (!ins?.id) continue
        if (tree.has(ins.id)) problems.push(`重复 id「${ins.id}」：${tree.get(ins.id).from} 与 ${name} 都想 insert`)
        tree.set(ins.id, { id: ins.id, name: ins.name || ins.id, config: ins.config, from: name })
        order.push(ins.id)
      }
      continue
    }
    if (row.id) {
      const prev = tree.get(row.id)
      tree.set(row.id, {
        id: row.id,
        name: row.name || prev?.name || row.id,
        config: { ...(prev?.config || {}), ...(row.config || {}) },
        disabled: row.disabled ?? prev?.disabled,
        from: prev?.from || name,
      })
      if (!prev) info(`${name}：覆盖了一个不存在的条目 id「${row.id}」（无害，但可能是配置过期）`)
    }
  }
  ok(`${name}：patch 叠加完成（累计 ${tree.size} 条）`)
}

/* ③ 叠加 profile 自己的 patch */
const profilePatch = join(profileDir, 'cordis.patch.yml')
if (existsSync(profilePatch)) {
  let rows = []
  try { rows = readYaml(profilePatch) } catch (e) { bad(`profile patch 解析失败 —— ${e.message}`); rows = [] }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (Array.isArray(row.insert)) {
      for (const ins of row.insert) {
        if (!ins?.id) continue
        if (tree.has(ins.id)) problems.push(`profile patch 重复 insert 了「${ins.id}」（跟 ${tree.get(ins.id).from} 撞了）`)
        tree.set(ins.id, { id: ins.id, name: ins.name || ins.id, config: ins.config, from: 'profile' })
      }
      continue
    }
    if (row.id) {
      const prev = tree.get(row.id)
      if (!prev) info(`profile patch 覆盖了不存在的 id「${row.id}」（无害，等同没配）`)
      tree.set(row.id, {
        id: row.id,
        name: row.name || prev?.name,
        config: { ...(prev?.config || {}), ...(row.config || {}) },
        disabled: row.disabled ?? prev?.disabled,
        from: prev?.from || 'profile',
      })
    }
  }
  ok(`profile patch：${rows.length} 条（累计 ${tree.size} 条）`)
}

/* ④ 报告 */
console.log('\n最终插件树：')
for (const id of [...new Set([...order, ...tree.keys()])]) {
  const row = tree.get(id)
  if (!row) continue
  const flag = row.disabled ? ' [disabled]' : ''
  console.log(`  - ${id.padEnd(26)} ${String(row.name || '').padEnd(42)} ← ${row.from}${flag}`)
}

if (problems.length) {
  console.log('\n问题：')
  for (const p of problems) bad(p)
} else {
  ok('没有重复 id、没有缺 client 出口')
}

console.log(`\n${fatal === 0 ? '通过' : '失败'}：${fatal} 个致命问题`)
if (fatal) { console.log('别重启 —— 先修上面的问题。'); process.exit(1) }
console.log('合成结果干净，重启风险低。')

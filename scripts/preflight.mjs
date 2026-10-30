#!/usr/bin/env node
/**
 * scripts/preflight.mjs —— 重启之前先跑这个（零依赖，秒级）
 * ============================================================================
 * 存在的理由：2026-10-28 一次发布把整个 DSH 搞到起不来 —— 插件声明了 `dsh.client`
 * 却没在 `exports` 里导出 `./client`，client-modules（必需插件）直接抛致命错误，
 * 连崩三次后应用把 profile 回滚成最小配置，使用者所有插件"消失"。
 *
 * 所以把"会崩机的清单问题"做成可执行检查。每条检查都对应一次真实事故或差点出的事故。
 *
 * 用法：
 *   node scripts/preflight.mjs                        # 只查包本身
 *   node scripts/preflight.mjs --profile <profile目录>  # 再查 profile 一致性
 *   node scripts/preflight.mjs --profile ~/.dsh/profiles/desktop
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(here, '..')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
}
const warn = (label, detail = '') => console.log(`  [WARN] ${label}${detail ? ' —— ' + detail : ''}`)

/* ── ① 包清单 ─────────────────────────────────────────── */
console.log('\n① package.json')

let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  ok(true, 'package.json 是合法 JSON')
} catch (e) {
  ok(false, 'package.json 是合法 JSON', e.message)
  process.exit(1)
}

ok(typeof pkg.name === 'string' && pkg.name.length > 0, '有 name', String(pkg.name))
ok(/^\d+\.\d+\.\d+/.test(String(pkg.version || '')), '有版本号', String(pkg.version))
ok(typeof pkg.main === 'string' && existsSync(resolve(PKG_DIR, pkg.main)), 'main 指向的文件存在', String(pkg.main))
ok(pkg.type === 'module', 'type 是 module（否则 ESM 导入会炸）', String(pkg.type))

/* ── ② 关键：dsh.client 必须有 ./client 出口 ───────────── */
console.log('\n② client 半端（这条不满足会**整机起不来**）')

if (pkg?.dsh?.client) {
  const exp = pkg?.exports?.['./client']
  ok(Boolean(exp), '声明了 dsh.client ⇒ exports["./client"] 必须存在',
    '缺它 ⇒ client-modules 报 "declares dsh.client but exports no ./client bundle"')
  const clientFile = exp ? resolve(PKG_DIR, exp) : join(PKG_DIR, 'client.js')
  ok(existsSync(clientFile), 'client 出口指向的文件真实存在', clientFile)
  if (existsSync(clientFile)) {
    const r = spawnSync(process.execPath, ['--check', clientFile], { encoding: 'utf8' })
    ok(r.status === 0, 'client.js 语法可通过', (r.stderr || '').split('\n').slice(0, 3).join(' '))
    const src = readFileSync(clientFile, 'utf8')
    ok(/__ModuleLoader__\.load/.test(src), 'client.js 用自注册写法（__ModuleLoader__.load）')
    ok(new RegExp(`id:\\s*['"]${pkg.name}['"]`).test(src), 'client.js 里的 id 等于包名')
    ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 是数组')
  }
  ok(Array.isArray(pkg.files) && pkg.files.includes('client.js'), 'files 里带上了 client.js（否则 npm 包里没有它）')
} else {
  ok(true, '没有声明 dsh.client（跳过 client 检查）')
}

/* ── ③ bundle patch ──────────────────────────────────── */
// ── ②c 相对 import 必须都有对应文件
//    2026-10-30 事故：commit 了 index.js（含 import ./lib/qq-bot.mjs），但那个文件没提交
//    ⇒ 装机即 ERR_MODULE_NOT_FOUND，插件整条不激活（entry did not activate）
console.log('\n②c 相对 import 解析')
{
  const files = [String(pkg.main || "index.js")]
  try {
    for (const f of readdirSync(join(PKG_DIR, "lib"))) {
      if (f.endsWith(".mjs") || f.endsWith(".js")) files.push("lib/" + f)
    }
  } catch { /* 没有 lib */ }
  const bad = []
  for (const rel of files) {
    const p = resolve(PKG_DIR, rel)
    if (!existsSync(p)) continue
    const src = readFileSync(p, "utf8")
    const re = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g
    for (const m of src.matchAll(re)) {
      const spec = m[1]
      const base = resolve(dirname(p), spec)
      const cands = [base, base + ".mjs", base + ".js", join(base, "index.mjs"), join(base, "index.js")]
      if (!cands.some((c) => existsSync(c))) bad.push(rel + " → " + spec)
    }
  }
  ok(bad.length === 0, "所有相对 import 都能找到文件", bad.join("；"))
}

console.log('\n③ bundle patch')

const patchRel = pkg?.dsh?.bundle?.patch
if (patchRel) {
  const patchAbs = resolve(PKG_DIR, patchRel)
  ok(existsSync(patchAbs), 'dsh.bundle.patch 指向的文件存在', patchAbs)
  if (existsSync(patchAbs)) {
    const text = readFileSync(patchAbs, 'utf8')
    ok(checkPatchText(text).ok, 'bundle patch 是合法的条目数组', checkPatchText(text).why)
    const ids = [...text.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9_.-]+)\s*$/gm)].map((m) => m[1])
    ok(ids.length > 0, 'bundle patch 里至少有一条 id', ids.join(', '))
  }
} else {
  ok(true, '没有 dsh.bundle.patch（纯 host 插件）')
}

/* ── ④ 宿主入口 ───────────────────────────────────────── */
console.log('\n④ 宿主入口 index.js')

const entry = resolve(PKG_DIR, pkg.main || 'index.js')
if (existsSync(entry)) {
  const src = readFileSync(entry, 'utf8')
  ok(/export\s+(const|function|\{)[^]*\bname\b/.test(src) || /export\s+const\s+name\s*=/.test(src), '导出了 name')
  ok(/export\s+(async\s+)?function\s+apply|export\s+const\s+apply/.test(src), '导出了 apply')
  const injectMatch = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(src)
  const injects = injectMatch ? injectMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : []
  ok(Array.isArray(injects), 'inject 是数组', injects.join(', '))
  ok(!injects.includes('webServer'),
    'inject 里不含 webServer（headless 没有它 ⇒ 塞进去整条插件不激活）',
    injects.join(', '))
  if (injects.includes('webServer')) {
    console.log('         正确写法：ctx.inject([\'webServer\'], (sub) => { ... }) 运行时注入')
  }
  const r = spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8' })
  ok(r.status === 0, 'index.js 语法可通过', (r.stderr || '').split('\n').slice(0, 3).join(' '))
}

/* ── ⑤ profile 一致性（可选） ──────────────────────────── */
const pi = process.argv.indexOf('--profile')
if (pi >= 0) {
  const raw = process.argv[pi + 1] || ''
  const profileDir = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw)
  console.log(`\n⑤ profile 一致性：${profileDir}`)

  const pkgFile = join(profileDir, 'package.json')
  const patchFile = join(profileDir, 'cordis.patch.yml')

  let prof = null
  try { prof = JSON.parse(readFileSync(pkgFile, 'utf8')); ok(true, 'profile package.json 合法') }
  catch (e) { ok(false, 'profile package.json 合法', e.message) }

  const bundles = prof?.dsh?.profile?.bundles
  ok(Array.isArray(bundles), 'profile 有 bundles 数组', Array.isArray(bundles) ? `${bundles.length} 项` : '')
  if (Array.isArray(bundles)) {
    ok(new Set(bundles).size === bundles.length, 'bundles 没有重复项',
      bundles.filter((x, i) => bundles.indexOf(x) !== i).join(', '))
    ok(bundles.includes(pkg.name), `bundles 里登记了本插件（${pkg.name}）`, '没登记 ⇒ 插件库看不到、重启也不加载')
    const req = createRequire(join(profileDir, 'package.json'))
    try {
      const p = req.resolve(pkg.name + '/package.json')
      ok(true, '从 profile 能解析到本包', p)
    } catch (e) {
      ok(false, '从 profile 能解析到本包', `${e.code}（junction / 依赖没建好）`)
    }
    // 同 id 既 bundle insert 又 profile insert = 重复挂载
    if (existsSync(patchFile) && patchRel) {
      const pp = readFileSync(patchFile, 'utf8')
      const ids = [...readFileSync(resolve(PKG_DIR, patchRel), 'utf8')
        .matchAll(/^\s*-\s*id:\s*([A-Za-z0-9_.-]+)\s*$/gm)].map((m) => m[1])
      const dup = ids.filter((id) => new RegExp(`insert:[\\s\\S]{0,200}?- id: ${id}`, 'm').test(pp))
      ok(dup.length === 0, 'profile patch 里没有重复 insert 本插件的条目', dup.join(', '))
    }
  }

  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const r = checkPatchText(text)
    ok(r.ok, 'profile cordis.patch.yml 是合法条目数组', r.why)
    if (/\n\s*\[\s*\]\s*\n[\s\S]*-/.test(text)) {
      warn('文件里出现了 `[]` 占位后面又跟条目（手工追加的典型翻车点）')
    }
  } else {
    ok(true, '没有 cordis.patch.yml（可以只有 bundle）')
  }
}

console.log(`\n${fail === 0 ? '通过' : '失败'}：${pass} 项 OK / ${fail} 项 FAIL`)
if (fail > 0) {
  console.log('别重启 —— 先修上面标 FAIL 的项。')
  process.exit(1)
}
console.log('包清单自洽，可以继续（发布前再跑一次 selftest）。')

/**
 * 轻量 YAML 直觉检查：不引 js-yaml，只认「是不是条目数组」这个形状。
 * 抓的是真实踩过的坑：空文件、`[]` 后面还跟条目、顶层不是数组。
 */
function checkPatchText(text) {
  const lines = String(text || '').split(/\r?\n/)
  const meaningful = lines
    .map((l, i) => ({ l: l.trim(), i }))
    .filter(({ l }) => l && !l.startsWith('#'))
  if (meaningful.length === 0) return { ok: false, why: '文件是空的（loader 需要数组）' }
  const first = meaningful[0].l
  const placeholderIdx = meaningful.findIndex(({ l }) => l === '[]' || l === '---' || l === 'null')
  if (placeholderIdx >= 0 && meaningful.some(({ l }, k) => k > placeholderIdx && l.startsWith('-'))) {
    return { ok: false, why: '出现了 `[]`/`---` 占位，后面又跟条目 ⇒ YAML 非法（追加前先把占位删掉）' }
  }
  if (first === '[]') return { ok: true, why: '' }
  if (!first.startsWith('-')) return { ok: false, why: `顶层第一条不是 "-"，而是 "${first.slice(0, 40)}"` }
  return { ok: true, why: '' }
}

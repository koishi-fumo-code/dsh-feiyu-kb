/**
 * lib/doctor.mjs —— DSH 体检（崩溃/异常时自动跑，也能手动跑）
 * ============================================================================
 * 起因：2026-10-28 插件把整个 DSH 搞到起不来，连崩三次后 profile 被回滚，
 * 使用者完全不知道发生了什么，只能看着"插件全没了"。
 *
 * 这份体检回答三个问题：
 *   ① 上次是不是崩过？崩在哪一步、错误是什么？（读 crash-*.log）
 *   ② profile 现在是不是被回滚过？（bundles 数量、patch 里缺了什么）
 *   ③ 本插件自己的包清单/知识库有没有毛病？
 *
 * 输出一份 markdown 报告 + 结构化 findings（每条带"怎么办"）。
 * 零依赖：不 spawn 子进程、不碰网络。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const pad = (n) => String(n).padStart(2, '0')

export function crashDirs() {
  const out = []
  const appData = process.env.APPDATA
  if (appData) out.push(join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'))
  out.push(join(homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'logs'))
  return [...new Set(out)]
}

/** 最近 N 个崩溃日志（按修改时间倒序） */
export function listCrashes(limit = 5) {
  const found = []
  for (const dir of crashDirs()) {
    if (!existsSync(dir)) continue
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!/^crash-.*\.log$/i.test(n)) continue
      const p = join(dir, n)
      try { found.push({ name: n, path: p, mtime: statSync(p).mtimeMs, size: statSync(p).size }) } catch { /* 忽略 */ }
    }
    if (found.length) break
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found.slice(0, limit)
}

/** 从崩溃日志里抽关键信息 */
export function parseCrash(path) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return null }
  const grab = (re) => (re.exec(text) || [])[1] || ''
  const block = /---\s*error\s*---\s*\n([\s\S]*?)(?:\n---|\nPlugins waiting|\n$)/i.exec(text)
  return {
    time: grab(/^time:\s*(.+)$/m),
    phase: grab(/^phase:\s*(.+)$/m),
    app: grab(/^app:\s*(.+)$/m),
    fatal: grab(/^([A-Za-z]*Error:.*)$/m),
    errorBlock: (block?.[1] || '').trim().split('\n').slice(0, 12).join('\n'),
    raw: text,
  }
}

/** profile 是否像"被回滚过" */
function inspectProfile(profileDir) {
  const out = { dir: profileDir, ok: false, bundles: [], patchEntries: [], problems: [] }
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) { out.problems.push('profile 不存在'); return out }
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    out.bundles = pkg?.dsh?.profile?.bundles || []
    out.ok = true
  } catch (e) { out.problems.push(`package.json 读不动：${e.message}`) }
  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    out.patchEntries = [...text.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9_.-]+)\s*$/gm)].map((m) => m[1])
    if (/^\s*\[\s*\]\s*$/m.test(text) && /\n\s*-/.test(text)) out.problems.push('patch 里有 `[]` 占位又跟条目（YAML 非法）')
    if (/enabled:\s*false/.test(text) && /ui-settings/.test(text)) out.problems.push('ui-settings 被关掉了（设置页会打不开）')
  }
  return out
}

/** 本插件包清单自洽（挑最致命的几条，preflight 是完整版） */
function inspectPackage(pkgDir) {
  const out = { dir: pkgDir, problems: [] }
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch (e) {
    out.problems.push(`package.json 读不动：${e.message}`)
    return out
  }
  out.name = pkg.name
  out.version = pkg.version
  if (pkg?.dsh?.client && !pkg?.exports?.['./client']) {
    out.problems.push('声明了 dsh.client 但 exports 里没有 "./client"（**会整机启动失败**）')
  }
  const patchRel = pkg?.dsh?.bundle?.patch
  if (patchRel && !existsSync(resolve(pkgDir, patchRel))) out.problems.push('dsh.bundle.patch 指向的文件不存在')
  return out
}

/** 知识库健康 */
function inspectKb(kbRoot) {
  const out = { root: kbRoot, entries: -1, problems: [] }
  if (!kbRoot) { out.problems.push('库位置未知'); return out }
  if (!existsSync(kbRoot)) { out.problems.push(`库目录不存在：${kbRoot}`); return out }
  try {
    let n = 0
    const walk = (d, dep) => {
      if (dep > 3) return
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name), dep + 1)
        else if (e.name.endsWith('.md')) n++
      }
    }
    walk(join(kbRoot, 'entries'), 0)
    out.entries = n
  } catch (e) { out.problems.push(`entries 读不动：${e.message}`) }
  return out
}

/**
 * 体检主入口。
 * @param {object} o
 * @param {string[]} [o.profileDirs] 要检查的 profile 目录
 * @param {string} [o.pkgDir] 本插件目录
 * @param {string} [o.kbRoot] 知识库根
 * @param {string} [o.reason] 触发原因（写进报告标题）
 * @param {boolean} [o.includeRaw] 报告里带崩溃原文（默认只带前 12 行）
 */
export function collectDiagnosis(o = {}) {
  const profileDirs = o.profileDirs || [join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop')]
  // ⚠️ 别用 new URL(...).pathname：Windows 上它是百分号编码的（中文路径会变成 %E5%B7%A5…）
  const pkgDir = o.pkgDir || resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const findings = []

  // ① 崩溃
  const crashes = listCrashes(3)
  const latest = crashes[0] ? parseCrash(crashes[0].path) : null
  if (latest) {
    findings.push({
      level: 'warn',
      title: `上次崩溃：${latest.phase || '?'} 阶段`,
      detail: (latest.fatal || latest.errorBlock || '').slice(0, 400),
      fix: '先读 crash 日志确认是不是包清单问题；修好插件再重启，别反复重启（连崩三次 profile 会被回滚）。',
    })
  } else {
    findings.push({ level: 'ok', title: '没有崩溃日志', detail: `查过：${crashDirs().join(' , ')}` })
  }

  // ② profile
  for (const dir of profileDirs) {
    const p = inspectProfile(dir)
    const name = dir.split(/[\\/]/).pop()
    if (p.bundles.length && p.bundles.length < 4) {
      findings.push({
        level: 'error',
        title: `profile「${name}」像是被回滚过`,
        detail: `bundles 只剩 ${p.bundles.length} 项：${p.bundles.join(', ')}`,
        fix: '把原来的 bundles 列表补回去（备份在 ~/.dsh/feiyu-rescue/），补完先跑 preflight --profile 再重启。',
      })
    } else if (p.ok) {
      findings.push({ level: 'ok', title: `profile「${name}」正常`, detail: `${p.bundles.length} 个 bundle、${p.patchEntries.length} 条 patch` })
    }
    for (const prob of p.problems) findings.push({ level: 'error', title: `profile「${name}」有问题`, detail: prob })
  }

  // ③ 包清单
  const pk = inspectPackage(pkgDir)
  if (pk.problems.length) {
    for (const prob of pk.problems) findings.push({ level: 'error', title: '本插件包清单有问题', detail: prob, fix: '跑 scripts/preflight.mjs 看完整检查项。' })
  } else {
    findings.push({ level: 'ok', title: `插件包清单自洽（${pk.name}@${pk.version}）` })
  }

  // ④ 知识库
  const kb = inspectKb(o.kbRoot)
  if (kb.problems.length) {
    for (const prob of kb.problems) findings.push({ level: 'warn', title: '知识库有问题', detail: prob })
  } else {
    findings.push({ level: 'ok', title: '知识库可读', detail: `${kb.entries} 条 · ${kb.root}` })
  }

  const report = renderReport({ at: new Date(), reason: o.reason || '手动体检', findings, crashes, latest, profileDirs, pkgDir, kbRoot: kb.root })
  return { at: new Date().toISOString(), reason: o.reason || '手动体检', findings, crashes, latest, report, ok: findings.every((f) => f.level !== 'error') }
}

function renderReport({ at, reason, findings, crashes, latest, profileDirs, pkgDir, kbRoot }) {
  const L = []
  L.push(`# DSH 体检报告 · ${reason}`)
  L.push('')
  L.push(`- 时间：${at.toISOString()}`)
  L.push(`- 插件：${pkgDir}`)
  L.push(`- 知识库：${kbRoot || '(未知)'}`)
  L.push(`- profile：${profileDirs.join(', ')}`)
  L.push('')
  L.push('## 结论')
  L.push('')
  for (const f of findings) {
    const icon = f.level === 'error' ? '❌' : f.level === 'warn' ? '⚠️' : '✅'
    L.push(`- ${icon} **${f.title}**${f.detail ? '：' + f.detail.replace(/\n/g, ' ') : ''}`)
    if (f.fix) L.push(`  - 怎么办：${f.fix}`)
  }
  if (latest) {
    L.push('')
    L.push('## 最近一次崩溃原文（前 12 行）')
    L.push('')
    L.push('```')
    L.push([latest.time, latest.phase, latest.fatal, latest.errorBlock].filter(Boolean).join('\n'))
    L.push('```')
    if (crashes.length > 1) L.push(`\n（另有 ${crashes.length - 1} 份更早的崩溃日志）`)
  }
  return L.join('\n') + '\n'
}

/** 报告存哪：$DSH_HOME/diagnostics/<时间>-<原因>.md */
export function reportPath(reason = 'diagnosis') {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return join(home, 'diagnostics', `${stamp}-${String(reason).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 30)}.md`)
}

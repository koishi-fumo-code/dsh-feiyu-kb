#!/usr/bin/env node
/**
 * scripts/doctor.mjs —— 手动体检（崩溃排查、发版前、怀疑环境有问题时跑）
 * ============================================================================
 *   node scripts/doctor.mjs                  # 体检 + 报告落盘 + 打印摘要
 *   node scripts/doctor.mjs --print          # 只打印，不落盘
 *   node scripts/doctor.mjs --reason "升级后起不来"
 *
 * 报告默认写到 <DSH_HOME>/diagnostics/<时间>-<原因>.md
 * 插件里的看门狗（lib/watchdog.mjs）用的就是同一套 collectDiagnosis。
 * ============================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { collectDiagnosis, reportPath } from '../lib/doctor.mjs'
import { resolveRoot } from '../lib/kb.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const argv = process.argv.slice(2)
const printOnly = argv.includes('--print')
const ri = argv.indexOf('--reason')
const reason = ri >= 0 ? String(argv[ri + 1] || '手动体检') : '手动体检'
const pi = argv.indexOf('--profile')
const profileDirs = pi >= 0
  ? [resolve(String(argv[pi + 1] || '').replace(/^~/, homedir()))]
  : undefined

const d = collectDiagnosis({ reason, pkgDir, profileDirs, kbRoot: resolveRoot() })

if (!printOnly) {
  const file = reportPath(reason)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, d.report, 'utf8')
    console.log(`报告已写入：${file}\n`)
  } catch (e) {
    console.log(`报告写不进去：${e.message}\n`)
  }
}

console.log(d.report)
const errors = d.findings.filter((f) => f.level === 'error')
const warns = d.findings.filter((f) => f.level === 'warn')
console.log(`\n结论：${errors.length ? `${errors.length} 个错误` : '无错误'}${warns.length ? `、${warns.length} 个警告` : ''}`)
process.exit(errors.length ? 1 : 0)

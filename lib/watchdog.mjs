/**
 * lib/watchdog.mjs —— 异常自动触发体检
 * ============================================================================
 * 需求（2026-10-28）：「每次 DSH 出现异常，自动触发这个功能」。
 *
 * 做两件事：
 *   ① **启动时**看崩溃日志：比上次检查新出现的 crash-*.log ⇒ 自动体检 + 写报告
 *   ② **运行中**每 5 分钟扫一次：抓新崩溃、抓 profile 被回滚（bundles 骤降）
 *
 * 去重靠状态文件 `$DSH_HOME/feiyu-kb.watchdog.json`（记已处理过的崩溃文件名）。
 * 报告写到 `$DSH_HOME/diagnostics/`。
 *
 * ⚠️ 边界：**启动期的致命崩溃里插件根本没机会加载**，所以那种情况由"下一次成功启动"
 *    来补报（读崩溃日志）。要覆盖"永远起不来"，得靠外部的计划任务，那是另一套方案。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { collectDiagnosis, listCrashes, reportPath } from './doctor.mjs'

const statePath = () => {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feiyu-kb.watchdog.json')
}

function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return { seen: [], lastRun: '' } }
}
function writeState(s) {
  try { mkdirSync(dirname(statePath()), { recursive: true }); writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n', 'utf8') } catch { /* 记不住就算了 */ }
}

/**
 * 跑一次体检并把报告落盘。
 * @param {object} o
 * @param {string} o.reason
 * @param {(msg: string) => void} [o.log]
 * @param {string} [o.kbRoot]
 * @param {string[]} [o.profileDirs]
 * @param {string} [o.pkgDir]
 */
export function runDiagnosis(o = {}) {
  const d = collectDiagnosis(o)
  const file = reportPath(d.reason)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, d.report, 'utf8')
    o.log?.(`体检报告：${file}`)
  } catch (e) {
    o.log?.(`体检报告写不进去：${e?.message ?? e}`)
  }
  return { ...d, file }
}

/**
 * 启动看门狗。
 * @param {object} o
 * @param {(msg: string) => void} o.log
 * @param {() => string} [o.getRoot] 当前知识库位置（每次调用时取，别缓存启动值）
 * @param {string} [o.pkgDir]
 * @param {number} [o.intervalMs] 默认 5 分钟
 * @param {(r: any) => void} [o.onDiagnosis] 有新异常时回调（插件里用来看要不要提示使用者）
 */
export function startWatchdog(o) {
  const log = o.log || (() => {})
  const intervalMs = Math.max(60_000, Number(o.intervalMs) || 5 * 60_000)
  const dirs = o.profileDirs || undefined
  let timer = null
  let stopped = false

  const check = ({ boot = false } = {}) => {
    if (stopped) return null
    try {
      const state = readState()
      const seen = new Set(state.seen || [])
      const crashes = listCrashes(5)
      const fresh = crashes.filter((c) => !seen.has(c.name))

      if (fresh.length) {
        // 有新崩溃：先体检，再记账（记账放在后面，写报告失败下次还会重试）
        const r = runDiagnosis({
          reason: boot ? '启动时发现上次崩溃' : '运行中检测到新崩溃',
          log, kbRoot: o.getRoot?.(), pkgDir: o.pkgDir, profileDirs: dirs,
        })
        for (const c of fresh) seen.add(c.name)
        writeState({ seen: [...seen].slice(-50), lastRun: new Date().toISOString(), lastReport: r.file })
        log(`检测到 ${fresh.length} 份新崩溃日志（最近：${fresh[0].name}）⇒ 已体检：${r.file}`)
        o.onDiagnosis?.(r)
        return r
      }

      // 没有新崩溃，但 profile 可能被回滚过（bundles 极少）—— 一天最多报一次
      const rolled = collectDiagnosis({ reason: '例行体检', log, kbRoot: o.getRoot?.(), pkgDir: o.pkgDir, profileDirs: dirs })
      const bad = rolled.findings.filter((f) => f.level === 'error')
      const day = new Date().toDateString()
      if (bad.length && state.alarmDay !== day) {
        writeState({ ...state, seen: [...seen].slice(-50), lastRun: new Date().toISOString(), alarmDay: day, lastReport: rolled.file })
        log(`例行体检发现问题：${bad.map((b) => b.title).join('；')}`)
        o.onDiagnosis?.(rolled)
      }
      return null
    } catch (e) {
      log(`看门狗这次没跑成：${e?.message ?? e}`)
      return null
    }
  }

  // 启动后 3 秒跑第一次（别和插件加载抢时间），之后定时
  const bootTimer = setTimeout(() => { check({ boot: true }) }, 3000)
  bootTimer.unref?.()
  timer = setInterval(() => check({ boot: false }), intervalMs)
  timer.unref?.()

  return {
    check,
    stop() {
      stopped = true
      try { clearTimeout(bootTimer) } catch { /* 忽略 */ }
      try { clearInterval(timer) } catch { /* 忽略 */ }
    },
  }
}

/** 给设置页/接口用：最近一次体检的信息 */
export function lastWatchdogState() {
  const s = readState()
  return {
    lastRun: s.lastRun || '',
    lastReport: s.lastReport || '',
    seenCrashes: (s.seen || []).length,
    alarmDay: s.alarmDay || '',
  }
}

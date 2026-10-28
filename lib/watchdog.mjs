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
 * 便宜体检：只看「崩溃日志列表」和「profile 的 bundles 数量」。
 * ⚠️ 2026-10-28 修：原来每 5 分钟都调 collectDiagnosis() —— 那个会**扫知识库 entries**、
 *    读包清单，纯属浪费（实测一次 1.6ms 但含磁盘 IO，且每 5 分钟一次）。
 *    现在例行 tick 只做这两项（读一两个 json + 列目录），发现异常才升级成完整体检。
 */
function quickProbe(profileDirs = []) {
  const crashes = listCrashes(5)
  let rolled = false
  for (const dir of profileDirs) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const n = (pkg?.dsh?.profile?.bundles || []).length
      if (n > 0 && n < 4) rolled = true
    } catch { /* 读不到就当正常，别在这儿误报 */ }
  }
  return { crashes, rolled }
}

/**
 * 启动看门狗。
 * @param {object} o
 * @param {(msg: string) => void} o.log
 * @param {() => string} [o.getRoot] 当前知识库位置（每次调用时取，别缓存启动值）
 * @param {string} [o.pkgDir]
 * @param {string} [o.intervalMs] 默认 10 分钟（例行只做便宜探测）
 * @param {(r: any) => void} [o.onDiagnosis] 有新异常时回调
 */
export function startWatchdog(o) {
  const log = o.log || (() => {})
  const intervalMs = Math.max(60_000, Number(o.intervalMs) || 10 * 60_000)
  const dirs = o.profileDirs || undefined
  let timer = null
  let stopped = false

  const check = ({ boot = false } = {}) => {
    if (stopped) return null
    try {
      const state = readState()
      const seen = new Set(state.seen || [])
      const probe = quickProbe(dirs || [])
      const fresh = probe.crashes.filter((c) => !seen.has(c.name))

      const shouldDiagnose = fresh.length > 0 || probe.rolled
      if (!shouldDiagnose) return null

      // 只有"有新崩溃"或"profile 像被回滚"才跑完整体检（含知识库扫描）
      const r = runDiagnosis({
        reason: fresh.length
          ? (boot ? '启动时发现上次崩溃' : '运行中检测到新崩溃')
          : '例行体检：profile 像被回滚过',
        log, kbRoot: o.getRoot?.(), pkgDir: o.pkgDir, profileDirs: dirs,
      })
      for (const c of fresh) seen.add(c.name)
      const day = new Date().toDateString()
      writeState({ seen: [...seen].slice(-50), lastRun: new Date().toISOString(), lastReport: r.file, alarmDay: day })
      if (fresh.length) log(`检测到 ${fresh.length} 份新崩溃日志（最近：${fresh[0].name}）⇒ 已体检：${r.file}`)
      else log(`profile 像被回滚过 ⇒ 已体检：${r.file}`)
      o.onDiagnosis?.(r)
      return r
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

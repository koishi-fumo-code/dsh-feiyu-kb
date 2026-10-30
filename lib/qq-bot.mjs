/**
 * lib/qq-bot.mjs —— 让 QQ 机器人（AstrBot + SnowLuma）跟着 DSH 一起起落
 * ============================================================================
 * 需求（2026-10-30）：DSH 启动 ⇒ 机器人自动启动；DSH 关闭 ⇒ 机器人自动关闭。
 *
 * 三层保险（缺一层都不够）：
 *   ① 正常启动：插件 apply 后延迟几秒，拉起 `D:\QQBot\dsh-bot-lifecycle.ps1 -Mode start`
 *      （隐藏窗口；start-all.ps1 本身幂等，机器人在跑就什么都不做）
 *   ② 正常卸载：ctx.effect 的 disposer 立刻调 `-Mode stop`（插件被卸载/DSH 正常退出）
 *   ③ 异常退出：守夜 PowerShell 自己盯着 DSH 进程号，进程一没就执行 stop-all.ps1
 *      （DSH 被强杀、崩溃时 ② 不会执行，只能靠它）
 *
 * 为什么守夜进程由 PowerShell 脚本再通过 WMI 拉起（而不是 Node 直接 spawn）：
 *   · Electron 里的 `process.execPath` 是 `DeepSeek Harness.exe`，直接 spawn 跑 .mjs
 *     需要 ELECTRON_RUN_AS_NODE；
 *   · 更要紧的是，普通子进程会落进 DSH 的沙箱 job 对象，DSH 一退就被一起杀掉。
 *     `Win32_Process.Create` 建出来的进程在 job 之外，才能活到给机器人收尾。
 *
 * 防「快速重启误杀」：每次启动生成一个 bootId 写进状态文件；上一轮的守夜
 * 发现 bootId 变了就自己退出，不会把新一轮刚拉起来的机器人停掉。
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 默认根目录（可在 ~/.dsh/feiyu-kb.config.json 的 qqBot.root 覆盖） */
export const DEFAULT_QQ_BOT_ROOT = 'D:/QQBot'

/** 现在这个进程是不是桌面版 DSH（headless / 自测宿主不该碰真机器人） */
export function isDesktopDshApp() {
  try {
    return /deepseek[ -]?harness/i.test(basename(process.execPath || ''))
  } catch {
    return false
  }
}

/** 生命周期脚本位置 */
export function lifecycleScript(root = DEFAULT_QQ_BOT_ROOT) {
  return join(root, 'dsh-bot-lifecycle.ps1')
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const p = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(p) ? p : 'powershell.exe'
}

function baseArgs(script, dshPid, bootId, mode, root) {
  return [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DshPid', String(dshPid),
    '-BootId', String(bootId),
    '-Mode', mode,
    '-Root', root,
  ]
}

/**
 * 拉起机器人 + 守夜进程。不阻塞调用方，失败只记日志。
 * @param {{ root?: string, dshPid: number, bootId: string, log?: (s: string) => void }} o
 * @returns {number|null} 守夜进程的 pid
 */
export function startQqBot(o) {
  const root = o.root || DEFAULT_QQ_BOT_ROOT
  const log = o.log || (() => {})
  const script = lifecycleScript(root)
  if (!existsSync(script)) {
    log(`QQ 机器人生命周期脚本不存在：${script}`)
    return null
  }

  let fd = null
  try {
    const logDir = join(root, 'logs')
    mkdirSync(logDir, { recursive: true })
    fd = openSync(join(logDir, 'dsh-bot-lifecycle.out.log'), 'a')
    const child = spawn(powershellPath(), baseArgs(script, o.dshPid, o.bootId, 'start', root), {
      cwd: root,
      windowsHide: true,
      // 不 detached：这里只是**短命启动器**（跑完 start-all 再用 WMI 拉守夜），
      // 实测 detached 的 PowerShell 在当前环境里会直接空跑退出。
      stdio: ['ignore', fd, fd],
    })
    child.on?.('error', (e) => log(`QQ 机器人守夜进程出错：${e?.message ?? e}`))
    child.unref()
    log(`QQ 机器人自动启停已拉起（DSH pid ${o.dshPid}，守夜 pid ${child.pid}，root ${root}）`)
    return child.pid ?? null
  } catch (e) {
    log(`QQ 机器人没拉起来：${e?.message ?? e}`)
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 忽略 */ } }
  }
}

/**
 * 停掉机器人（并让守夜进程退出）。同步执行，确保 DSH 退出前真的跑完。
 * @param {{ root?: string, dshPid: number, bootId: string, log?: (s: string) => void, timeoutMs?: number }} o
 */
export function stopQqBot(o) {
  const root = o.root || DEFAULT_QQ_BOT_ROOT
  const log = o.log || (() => {})
  const script = lifecycleScript(root)
  if (!existsSync(script)) {
    log(`QQ 机器人生命周期脚本不存在：${script}`)
    return { ok: false }
  }
  try {
    const r = spawnSync(powershellPath(), baseArgs(script, o.dshPid, o.bootId, 'stop', root), {
      cwd: root,
      windowsHide: true,
      timeout: Math.max(5000, Number(o.timeoutMs) || 20000),
      encoding: 'utf8',
    })
    if (r.error) log(`QQ 机器人停止器出错：${r.error.message}`)
    else if (r.status !== 0) log(`QQ 机器人停止器退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}`)
    else log('QQ 机器人已停止（DSH 生命周期）')
    return { ok: r.status === 0 }
  } catch (e) {
    log(`QQ 机器人没停下来：${e?.message ?? e}`)
    return { ok: false }
  }
}

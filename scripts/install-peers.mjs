#!/usr/bin/env node
/**
 * scripts/install-peers.mjs —— 装本插件时，顺手把「另外两个」也装上
 * ============================================================================
 * 为了让它一装好就能演示完整功能，补上两条通道：
 *
 *   ① B站 通道 → DSH 插件 `dsh-bili-whale`（GitHub 上的刷视频插件）
 *   ② QQ  通道 → AstrBot 插件 `astrbot_plugin_feiyu_bridge`（本包 bridge/ 里的源码）
 *
 * 原则：
 *   - **幂等**：已经有的不动，反复跑没事
 *   - **不硬来**：找不到 AstrBot 就跳过（只提示一句），不会因为缺它就装挂
 *   - **先看后动**：`--dry` 只打印要做什么
 *   - **网络可关**：`--no-network` 只登记依赖、不跑 pnpm install
 *
 * 用法：
 *   node scripts/install-peers.mjs [--profiles desktop,headless] [--dry] [--no-network]
 * ============================================================================
 */
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const noNetwork = argv.includes('--no-network')
const pIdx = argv.indexOf('--profiles')
const profiles = (pIdx >= 0 ? String(argv[pIdx + 1] || '') : 'desktop,headless')
  .split(',').map((s) => s.trim()).filter(Boolean)

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const say = (...a) => console.log(...a)

// 两个搭档：一个是 DSH 插件（B站），一个是 AstrBot 插件（QQ）
const BILI = {
  name: 'dsh-bili-whale',
  spec: 'github:Alterssss/dsh-bili-whale',
  why: 'B站 通道：刷视频、归档进知识库、写日记',
}
const BRIDGE = {
  name: 'astrbot_plugin_feiyu_bridge',
  src: join(pluginDir, 'bridge', 'astrbot_plugin_feiyu_bridge'),
  why: 'QQ 通道：把私聊转发给 DSH',
}

/** 找 pnpm：环境变量 > DSH 运行时里的那份 */
function findPnpm() {
  if (process.env.PNPM && existsSync(process.env.PNPM)) return process.env.PNPM
  const rt = join(dshHome, 'dsh-runtimes')
  try {
    for (const d of readdirSafe(rt)) {
      const p = join(rt, d, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
      if (existsSync(p)) return p
    }
  } catch { /* 没有就算了 */ }
  return null
}

function readdirSafe(p) {
  try { return readdirSync(p) } catch { return [] }
}

/** ① B站 插件：登记依赖 + 加进 bundles（只动「本插件已经装了」的 profile） */
function ensureBiliWhale() {
  const changedDirs = []
  for (const prof of profiles) {
    const dir = join(dshHome, 'profiles', prof)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) { say(`   · ${prof}: 没有 profile，跳过`); continue }
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    // 只补「本插件在这里」的环境 —— 不给没装本插件的 profile 添乱
    if (!pkg.dependencies || !pkg.dependencies['dsh-feiyu-kb']) {
      say(`   · ${prof}: 没装 dsh-feiyu-kb，跳过`)
      continue
    }
    pkg.dsh ||= {}
    pkg.dsh.profile ||= {}
    pkg.dsh.profile.bundles ||= []

    const hasDep = Boolean(pkg.dependencies[BILI.name])
    const hasBundle = pkg.dsh.profile.bundles.includes(BILI.name)
    if (hasDep && hasBundle && existsSync(join(dir, 'node_modules', BILI.name))) {
      say(`   · ${prof}: ${BILI.name} 已在，跳过`)
      continue
    }
    if (!hasDep) { pkg.dependencies[BILI.name] = BILI.spec }
    if (!hasBundle) pkg.dsh.profile.bundles.push(BILI.name)
    say(`   · ${prof}: 登记 ${BILI.name}${hasDep ? '' : ' = ' + BILI.spec}`)
    if (!dry) writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    changedDirs.push(dir)
  }
  return changedDirs
}

/** 跑 pnpm install，把刚登记的依赖真的拉下来（只跑改过的 profile） */
function runInstall(dirs) {
  if (!dirs.length) return true
  if (noNetwork) { say('   · --no-network：只登记，不下载'); return true }
  const pnpm = findPnpm()
  if (!pnpm) { say('   ⚠️ 找不到 pnpm，跳过下载；重启 DSH 后市场会自动补装'); return false }
  for (const dir of dirs) {
    say(`   · ${dir}: pnpm install …`)
    if (dry) continue
    const r = spawnSync(process.execPath, [pnpm, 'install', '--prefer-offline'], {
      cwd: dir, stdio: 'inherit', env: { ...process.env },
    })
    if (r.status !== 0) say(`   ⚠️ ${dir}: pnpm install 退出码 ${r.status}，可稍后重试`)
  }
  return true
}

/** ② QQ 桥：AstrBot 在哪就把 bridge/ 拷过去 */
function ensureBridge() {
  const candidates = [
    process.env.ASTRBOT_PLUGINS,
    'D:/QQBot/AstrBot/data/plugins',
    join(homedir(), 'QQBot', 'AstrBot', 'data', 'plugins'),
    join(homedir(), 'AstrBot', 'data', 'plugins'),
  ].filter(Boolean)
  const root = candidates.find((p) => existsSync(p))
  if (!root) {
    say('   · 没找到 AstrBot 插件目录 —— 跳过（只用 DSH 的话不影响）')
    say('     想装 QQ 通道时：ASTRBOT_PLUGINS=<目录> node scripts/install-bridge.mjs')
    return false
  }
  if (!existsSync(BRIDGE.src)) { say('   ⚠️ bridge/ 源码缺失，跳过'); return false }
  const dest = join(root, BRIDGE.name)
  say(`   · 部署到 ${dest}`)
  if (!dry) {
    mkdirSync(root, { recursive: true })
    cpSync(BRIDGE.src, dest, { recursive: true })
  }
  say('     → 在 AstrBot 里重载插件即可生效')
  return true
}

say(`安装搭档插件（DSH_HOME=${dshHome}）`)
say(`\n① ${BILI.name} —— ${BILI.why}`)
const depChanged = ensureBiliWhale()
if (depChanged.length) runInstall(depChanged)
else say('   · 都已就位，不用安装')

say(`\n② ${BRIDGE.name} —— ${BRIDGE.why}`)
ensureBridge()

say(`\n完成${dry ? '（--dry：什么都没改）' : ''}。重启 DSH 让新插件生效。`)

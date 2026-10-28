/**
 * lib/config.mjs —— 设置页能改的那点东西（存在 `$DSH_HOME/feiyu-kb.config.json`）
 * ============================================================================
 * 为什么单独存一份、不和 bundle patch 混在一起：
 *   · bundle patch 是**包里的文件**，升级包就被覆盖了；
 *   · profile 的 cordis.patch.yml 改起来麻烦（要 YAML、要重启/热重载）；
 *   · 设置页写一个自己的 json，最直白：改完立刻生效，卸载插件也不会污染 profile。
 *
 * 只有三项（2026-10-28 使用者要求"方便人类使用"）：
 *   · root            知识库文件夹（空 = 跟随 bundle config / 环境变量 / 默认）
 *   · tools.ingest    是否开放 kb_ingest（抓网页 / 导文件 / 目录 / RSS）
 *   · tools.capture   是否开放 kb_capture（随手记）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_NAME = 'feiyu-kb.config.json'
export const DEFAULT_TOOLS = { ingest: true, capture: true }

export function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, CONFIG_NAME)
}

/** 读配置（文件不存在就是默认值；读坏了也不抛，免得把插件带崩） */
export function loadConfig() {
  const empty = { root: '', tools: { ...DEFAULT_TOOLS } }
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    return {
      root: typeof raw?.root === 'string' ? raw.root.trim() : '',
      tools: {
        ingest: typeof raw?.tools?.ingest === 'boolean' ? raw.tools.ingest : DEFAULT_TOOLS.ingest,
        capture: typeof raw?.tools?.capture === 'boolean' ? raw.tools.capture : DEFAULT_TOOLS.capture,
      },
    }
  } catch { return empty }
}

/** 合并式保存：只覆盖传进来的键 */
export function saveConfig(patch = {}) {
  const cur = loadConfig()
  const next = {
    root: patch.root === undefined ? cur.root : String(patch.root || '').trim(),
    tools: {
      ingest: patch?.tools?.ingest === undefined ? cur.tools.ingest : Boolean(patch.tools.ingest),
      capture: patch?.tools?.capture === undefined ? cur.tools.capture : Boolean(patch.tools.capture),
    },
    updatedAt: new Date().toISOString(),
  }
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

export { existsSync }

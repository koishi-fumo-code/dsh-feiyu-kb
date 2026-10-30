/**
 * lib/config.mjs —— 设置页能改的那点东西（存在 `$DSH_HOME/feiyu-kb.config.json`）
 * ============================================================================
 * 为什么单独存一份、不和 bundle patch 混在一起：
 *   · bundle patch 是**包里的文件**，升级包就被覆盖了；
 *   · profile 的 cordis.patch.yml 改起来麻烦（要 YAML、要重启/热重载）；
 *   · 设置页写一个自己的 json，最直白：改完立刻生效，卸载插件也不会污染 profile。
 *
 * 四组：
 *   · root            知识库文件夹（空 = 跟随 bundle config / 环境变量 / 默认）
 *   · tools.ingest    是否开放 kb_ingest（抓网页 / 导文件 / 目录 / RSS）
 *   · tools.capture   是否开放 kb_capture（随手记）
 *   · ctx             上下文压缩调参（开关 + 阈值 + 保留比例）—— 会写 profile 的 patch
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_NAME = 'feiyu-kb.config.json'
export const DEFAULT_TOOLS = { ingest: true, capture: true }
// 默认关：打开会改 profile 的 cordis.patch.yml（虽然会备份+校验，但默认不擅自动别人的环境）
export const DEFAULT_CTX = { enabled: false, thresholdRatio: 0.6, retainRatio: 0.12 }
// 目录同步：默认盯着新刷视频插件的会话工作目录（它写的日记/笔记会落在这儿）
export const DEFAULT_SYNC = { enabled: false, dirs: [], intervalMinutes: 10 }
// 记忆库：和知识库分开的另一本账（见 lib/memory.mjs）
export const DEFAULT_MEMORY = { enabled: true, root: '', inject: 5, sessionOff: [] }
// 大脑：会话名 / 工作目录 / 人设文件。留空 = 按 DSH_HOME 推默认，换机器不用改代码。
export const DEFAULT_BRAIN = { session: '', cwd: '', persona: '' }

const num = (v, fallback, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) && n > lo && n < hi ? n : fallback
}

export function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, CONFIG_NAME)
}

/** 读配置（文件不存在就是默认值；读坏了也不抛，免得把插件带崩） */
export function loadConfig() {
  const empty = { root: '', tools: { ...DEFAULT_TOOLS }, ctx: { ...DEFAULT_CTX }, sync: { ...DEFAULT_SYNC }, memory: { ...DEFAULT_MEMORY }, brain: { ...DEFAULT_BRAIN } }
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    return {
      root: typeof raw?.root === 'string' ? raw.root.trim() : '',
      tools: {
        ingest: typeof raw?.tools?.ingest === 'boolean' ? raw.tools.ingest : DEFAULT_TOOLS.ingest,
        capture: typeof raw?.tools?.capture === 'boolean' ? raw.tools.capture : DEFAULT_TOOLS.capture,
      },
      ctx: {
        enabled: typeof raw?.ctx?.enabled === 'boolean' ? raw.ctx.enabled : DEFAULT_CTX.enabled,
        thresholdRatio: num(raw?.ctx?.thresholdRatio, DEFAULT_CTX.thresholdRatio, 0.05, 1),
        retainRatio: num(raw?.ctx?.retainRatio, DEFAULT_CTX.retainRatio, 0, 0.9),
      },
      sync: {
        enabled: typeof raw?.sync?.enabled === 'boolean' ? raw.sync.enabled : DEFAULT_SYNC.enabled,
        dirs: Array.isArray(raw?.sync?.dirs) ? raw.sync.dirs.filter((d) => typeof d === 'string' && d.trim()).slice(0, 8) : [],
        intervalMinutes: num(raw?.sync?.intervalMinutes, DEFAULT_SYNC.intervalMinutes, 0.5, 24 * 60),
      },
      memory: {
        enabled: typeof raw?.memory?.enabled === 'boolean' ? raw.memory.enabled : DEFAULT_MEMORY.enabled,
        root: typeof raw?.memory?.root === 'string' ? raw.memory.root.trim() : '',
        inject: num(raw?.memory?.inject, DEFAULT_MEMORY.inject, 0, 50),
        sessionOff: Array.isArray(raw?.memory?.sessionOff)
          ? raw.memory.sessionOff.filter((s) => typeof s === 'string' && s.trim()).slice(0, 200)
          : [],
      },
      brain: {
        session: typeof raw?.brain?.session === 'string' ? raw.brain.session.trim() : '',
        cwd: typeof raw?.brain?.cwd === 'string' ? raw.brain.cwd.trim() : '',
        persona: typeof raw?.brain?.persona === 'string' ? raw.brain.persona.trim() : '',
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
    ctx: {
      enabled: patch?.ctx?.enabled === undefined ? cur.ctx.enabled : Boolean(patch.ctx.enabled),
      thresholdRatio: num(patch?.ctx?.thresholdRatio, cur.ctx.thresholdRatio, 0.05, 1),
      retainRatio: num(patch?.ctx?.retainRatio, cur.ctx.retainRatio, 0, 0.9),
    },
    sync: {
      enabled: patch?.sync?.enabled === undefined ? cur.sync.enabled : Boolean(patch.sync.enabled),
      dirs: Array.isArray(patch?.sync?.dirs)
        ? patch.sync.dirs.filter((d) => typeof d === 'string' && d.trim()).slice(0, 8)
        : cur.sync.dirs,
      intervalMinutes: num(patch?.sync?.intervalMinutes, cur.sync.intervalMinutes, 0.5, 24 * 60),
    },
    memory: {
      enabled: patch?.memory?.enabled === undefined ? cur.memory.enabled : Boolean(patch.memory.enabled),
      root: patch?.memory?.root === undefined ? cur.memory.root : String(patch.memory.root || '').trim(),
      inject: num(patch?.memory?.inject, cur.memory.inject, 0, 50),
      sessionOff: Array.isArray(patch?.memory?.sessionOff)
        ? patch.memory.sessionOff.filter((s) => typeof s === 'string' && s.trim()).slice(0, 200)
        : cur.memory.sessionOff,
    },
    brain: {
      session: patch?.brain?.session === undefined ? cur.brain.session : String(patch.brain.session || '').trim(),
      cwd: patch?.brain?.cwd === undefined ? cur.brain.cwd : String(patch.brain.cwd || '').trim(),
      persona: patch?.brain?.persona === undefined ? cur.brain.persona : String(patch.brain.persona || '').trim(),
    },
    updatedAt: new Date().toISOString(),
  }
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

export { existsSync }

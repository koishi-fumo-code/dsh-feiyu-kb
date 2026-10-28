/**
 * dsh-feiyu-kb —— 大肥鱼知识库 · DSH 插件（host 半端）
 * ============================================================================
 * 它做什么：把 `D:/dsh工作区/大肥鱼知识库/` 暴露成一组 DSH 工具 —— 于是**任何模型运行时**
 * （桌面会话、headless 值班轮、subagent…）只要在这台机器上跑，就都能搜 / 读 / 写这个库。
 *
 * 工具：
 *   kb_search  搜知识库（标题 / UP / 标签 / 正文，多词 AND）
 *   kb_read    读一篇全文（id / BV号 / 相对路径）
 *   kb_add     新增或更新一篇（判重键：BV号；没有 BV 号就用日期+标题）
 *   kb_index   重建 INDEX.md + index.jsonl + .kb/meta.json
 *   kb_status  看一眼：多少条、最近几条、标签分布
 *
 * 设计约束（都是踩过的坑）：
 *   · **零依赖**：不 require 任何 @deepseek-ai/* —— 桌面 profile 是 autoInstallPeers: false，
 *     裸 import peer 会让整条插件不激活（dsh-bili-scroll 的 hostdeps.mjs 就是为这个写的）。
 *   · **apply 绝不抛**：定时器/加载器里抛异常会带走整个 dsh 进程。
 *   · **返回值必须是无损 JSON**（函数 / 循环引用 / 类实例都会让宿主报 lossless 错误）。
 * ============================================================================
 */
import { existsSync, mkdirSync, appendFileSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_ROOT, KINDS, TIERS, STATUSES, resolveRoot, ensureRoot, writeEntry,
  searchEntries, relatedEntries, findEntry, rebuildIndex, stats, listEntries,
} from './lib/kb.mjs'

export const name = 'feiyu-kb'
export const inject = ['tools']

/** 宿主那边 defineTool 的等价物（只做「裸属性表 → JSONSchema」+ additionalProperties 补全） */
function wrapTool(options) {
  const out = { ...options }
  const raw = out.parameters
  const params = raw && typeof raw === 'object' && typeof raw.type !== 'string'
    ? { type: 'object', properties: raw }
    : (raw || { type: 'object', properties: {} })
  if (params.type === 'object' && params.additionalProperties === undefined) params.additionalProperties = false
  out.parameters = params
  if (!out.output) out.output = TEXT_OUTPUT
  return out
}

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 宿主只吃无损 JSON */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

export function apply(ctx, config) {
  let root
  try {
    root = resolveRoot(config?.root || process.env.FEIYU_KB_ROOT || DEFAULT_ROOT)
    ensureRoot(root)
  } catch (e) {
    // 连目录都建不出来：不能因此让整条插件不激活，工具里再报错
    root = resolveRoot(DEFAULT_ROOT)
    console?.warn?.(`[feiyu-kb] 建知识库目录失败：${e?.message ?? e}`)
  }

  const logFile = join(root, '.kb', 'plugin.log')
  const log = (msg) => {
    try {
      if (existsSync(logFile) && statSync(logFile).size > 256 * 1024) writeFileSync(logFile, '', 'utf8')
      mkdirSync(join(root, '.kb'), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()}  ${msg}\n`, 'utf8')
    } catch { /* 日志写不进去不致命 */ }
  }

  /** 路径必须落在知识库里 —— kb_read 传绝对路径时用它把关 */
  const insideRoot = (p) => {
    const norm = String(p).replace(/\\/g, '/')
    const r = root.replace(/\\/g, '/')
    return norm === r || norm.startsWith(r + '/')
  }

  const tool = (spec) => {
    try {
      return ctx.tools.register(wrapTool({ ...spec, async execute(args, exec) { return safe(await spec.execute(args ?? {}, exec)) } }))
    } catch (e) {
      log(`注册工具 ${spec.name} 失败：${e?.message ?? e}`)
      return null
    }
  }

  log(`插件加载：root=${root}`)

  /* ─────────────── kb_status ─────────────── */
  tool({
    name: 'kb_status',
    description: '看一眼「大肥鱼知识库」的状态：一共多少条、按类型/档位怎么分、最近收了哪几条、标签排行。'
      + '不确定库里有没有相关材料时，先调它。',
    parameters: {},
    async execute() {
      const s = stats(root)
      return { ok: true, ...s, kinds: KINDS, tiers: TIERS }
    },
  })

  /* ─────────────── kb_search ─────────────── */
  tool({
    name: 'kb_search',
    description: '搜「大肥鱼知识库」（视频笔记 / 技术要点）。多个词用空格隔开、**每个词都要命中**（AND）。\n'
      + '不给 query 就是「列最近收录的」。返回 id / 标题 / UP / 标签 / 档位 / 命中片段 / 相对路径；'
      + '要看全文再用 kb_read。',
    parameters: {
      query: { type: 'string', description: '关键词，空格分隔（例：`DeepSeek 推理`）；留空 = 列最近' },
      tags: { type: 'string', description: '按标签过滤，逗号分隔（例：`KVCache,推理`）' },
      kind: { type: 'string', description: `只收某一类：${KINDS.join(' / ')}` },
      tier: { type: 'string', description: `只收某一档：${TIERS.join(' / ')}` },
      limit: { type: 'number', description: '返回几条（默认 8，最多 50）' },
    },
    async execute(args) {
      const r = searchEntries(root, {
        query: String(args.query || ''),
        tags: String(args.tags || ''),
        kind: String(args.kind || ''),
        tier: String(args.tier || ''),
        limit: args.limit,
      })
      return { ok: true, root, ...r }
    },
  })

  /* ─────────────── kb_read ─────────────── */
  tool({
    name: 'kb_read',
    description: '读知识库里某一篇的全文（Markdown）。用 id、BV号 或相对路径指定 —— 三个给一个就行。',
    parameters: {
      id: { type: 'string', description: '条目 id（形如 2026-10-27-BV1Mxn26eEh5）' },
      bvid: { type: 'string', description: 'BV号（例：BV1Mxn26eEh5）' },
      path: { type: 'string', description: '相对知识库根目录的路径（kb_search 返回的 path）' },
    },
    async execute(args) {
      const p = String(args.path || '').trim()
      if (p && !insideRoot(p) && !/^entries[\\/]/.test(p)) {
        return { ok: false, error: 'path 必须在知识库目录里（用 kb_search 返回的 path）' }
      }
      try {
        const e = findEntry(root, { id: args.id, bvid: args.bvid, path: p })
        return { ok: true, meta: e.meta, body: e.body, text: e.text.length > 24000 ? e.text.slice(0, 24000) + '\n…（截断）' : e.text }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_add ─────────────── */
  tool({
    name: 'kb_add',
    description: '往「大肥鱼知识库」里新增/更新一篇笔记。**刷B站每轮把「有用的」视频都该调它归档一次**。\n'
      + '判重键是 BV号（同一个 BV 再写就是更新，不会多出一条）；没有 BV 号时用日期+标题。\n'
      + '⚠️ 要点必须是**真读到的**（字幕 / 热评 / 简介），读不到就只写一句话，别编。',
    parameters: {
      title: { type: 'string', description: '标题（必填）' },
      bvid: { type: 'string', description: 'BV号（判重用）' },
      url: { type: 'string', description: '链接（不给就用 BV号 拼）' },
      up: { type: 'string', description: 'UP 主' },
      date: { type: 'string', description: '视频日期 YYYY-MM-DD（默认今天）' },
      kind: { type: 'string', description: `类型：${KINDS.join(' / ')}（默认 知识）` },
      tier: { type: 'string', description: `档位：${TIERS.join(' / ')}` },
      status: { type: 'string', description: `状态：${STATUSES.join(' / ')}（默认 待看）` },
      tags: { type: 'string', description: '标签，逗号分隔（3~6 个最好用）' },
      summary: { type: 'string', description: '一句话：这条到底讲了什么' },
      points: { type: 'string', description: '要点，一行一条（会写成 - 列表）' },
      excerpt: { type: 'string', description: '原文摘录（字幕里最关键的几句）' },
      notes: { type: 'string', description: '备注 / 以后怎么用得上' },
      source: { type: 'string', description: '来源（默认 bili-scroll）' },
    },
    async execute(args) {
      try {
        const r = writeEntry(root, args)
        const meta = rebuildIndex(root)
        log(`kb_add ${r.action} ${r.id}`)
        return { ok: true, ...r, total: meta.entries }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_related ─────────────── */
  tool({
    name: 'kb_related',
    description: '找知识库里跟这条**相关**的旧条目（标签加权 + 中文二字组相似度 + 英文/型号词，纯本地、毫秒级）。\n'
      + '刷完一轮写报告时用它：给每条视频配一句「库里有相关的」，让三个月前那条同主题的笔记重新浮上来。\n'
      + '⚠️ 用**你打算给这条的标签**去比最准；`exclude` 传正在归档的 BV 号，别让它跟自己匹配。',
    parameters: {
      text: { type: 'string', description: '这条视频的标题 / 摘要 / 要点，粘一段就行' },
      tags: { type: 'string', description: '标签，逗号分隔（用你准备给这条打的标签）' },
      exclude: { type: 'string', description: '排除这个 BV 号 / id（通常就是正在归档的这条）' },
      limit: { type: 'number', description: '最多几条（默认 3，最多 10）' },
    },
    async execute(args) {
      try {
        const r = relatedEntries(root, {
          text: String(args.text || ''),
          tags: String(args.tags || ''),
          exclude: String(args.exclude || ''),
          limit: args.limit,
        })
        return { ok: true, root, ...r }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_index ─────────────── */
  tool({
    name: 'kb_index',
    description: '重建知识库索引（INDEX.md / index.jsonl / .kb/meta.json）。手改过 entries 之后调一次。',
    parameters: {},
    async execute() {
      try {
        const meta = rebuildIndex(root)
        return { ok: true, ...meta, indexPath: join(root, 'INDEX.md') }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })
}

/** 给宿主/排查看的：库在哪、有几条（不注册成工具） */
export function describe() {
  const root = resolveRoot(process.env.FEIYU_KB_ROOT || DEFAULT_ROOT)
  let n = 0
  try { n = listEntries(root).length } catch { /* 目录还没建 */ }
  return { name, root, entries: n, exists: existsSync(root) }
}

// 直接 `node index.js` 时打印一下（方便人工排查，不进 DSH 也无副作用）
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  try { console.log(JSON.stringify(describe(), null, 2)) } catch (e) { console.error(e) }
  try { readFileSync(join(DEFAULT_ROOT, 'INDEX.md'), 'utf8') } catch { /* 索引还没建就算了 */ }
}

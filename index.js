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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const PKG_DIR = dirname(fileURLToPath(import.meta.url))
import {
  DEFAULT_ROOT, KINDS, TIERS, STATUSES, resolveRoot, ensureRoot, writeEntry,
  rememberRoot, searchEntries, relatedEntries, findEntry, rebuildIndex, afterWriteIndex, stats, listEntries,
} from './lib/kb.mjs'

import { ingestUrl, ingestFile, ingestDir, ingestFeed, capture } from './lib/ingest.mjs'
import { loadConfig, saveConfig, configPath, DEFAULT_TOOLS, DEFAULT_CTX, DEFAULT_SYNC } from './lib/config.mjs'
import { syncCompaction, compactionStatus } from './lib/ctx-save.mjs'
import { syncDirs, syncStatus, DEFAULT_SYNC_DIRS } from './lib/sync-dirs.mjs'
import { startWatchdog, runDiagnosis, lastWatchdogState } from './lib/watchdog.mjs'
import {
  resolveMemoryRoot, writeMemory, searchMemories, searchChats, readMemory,
  memoryStatus, appendChat, recentMemories, rebuildMemoryIndex, writeDigest,
} from './lib/memory.mjs'

export const name = 'feiyu-kb'
// ⚠️ 只 inject tools：webServer 在 headless profile 里可能没有，
//    写成 inject 会让整条插件在那种环境**不激活**（工具全没了）。所以在 apply 里可选地取。
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
  let cfg = loadConfig()
  let root = ''
  const bundleRoot = config?.root

  /** 重算生效库位置（设置页改 root 后立刻调用） */
  const applyRoot = (raw) => {
    root = resolveRoot(raw || cfg.root || bundleRoot)
    ensureRoot(root)
    // ⭐ 把自己的生效路径记下来：命令行（kb-cli）看不到 profile 配置，
    //    只有靠这个备忘文件才跟插件对齐，否则 CLI 兜底会写进另一个库（知识被劈成两半）。
    rememberRoot(root)
    return root
  }

  try {
    applyRoot()
  } catch (e) {
    // 连目录都建不出来：不能因此让整条插件不激活，工具里再报错
    root = resolveRoot()
    console?.warn?.(`[feiyu-kb] 建知识库目录失败：${e?.message ?? e}`)
  }

  const logFile = () => join(root, '.kb', 'plugin.log')
  const log = (msg) => {
    try {
      const f = logFile()
      if (existsSync(f) && statSync(f).size > 256 * 1024) writeFileSync(f, '', 'utf8')
      mkdirSync(join(root, '.kb'), { recursive: true })
      appendFileSync(f, `${new Date().toISOString()}  ${msg}\n`, 'utf8')
    } catch { /* 日志写不进去不致命 */ }
  }

  /** 路径必须落在知识库里 —— kb_read 传绝对路径时用它把关 */
  const insideRoot = (p) => {
    const norm = String(p).replace(/\\/g, '/')
    const r = root.replace(/\\/g, '/')
    return norm === r || norm.startsWith(r + '/')
  }

  /** ctx.effect 不一定存在（测试宿主、老版本宿主）—— apply 绝不抛是硬规矩，所以包一层 */
  const effect = (fn, label) => {
    try { if (typeof ctx.effect === 'function') return ctx.effect(fn, label) } catch (e) { log('effect 注册失败：' + (e?.message ?? e)) }
    return undefined
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
    description: '库概况：条数、类型/档位分布、最近几条、标签排行。',
    parameters: {},
    async execute() {
      const s = stats(root)
      // 精简返回：标签榜 12 条压到 6 条、最近 5 条压到 3 条（这个调用一次能省 ~150 token）
      return { ok: true, ...s, topTags: (s.topTags || []).slice(0, 6), latest: (s.latest || []).slice(0, 3), kinds: KINDS, tiers: TIERS }
    },
  })

  /* ─────────────── kb_search ─────────────── */
  tool({
    name: 'kb_search',
    description: '搜知识库：标题/UP/标签/正文，空格分隔多词（全部命中）。留空=列最近。看全文用 kb_read。',
    parameters: {
      query: { type: 'string', description: '关键词，空格分隔；留空列最近' },
      tags: { type: 'string', description: '标签过滤，逗号分隔' },
      kind: { type: 'string', description: '知识|有意思' },
      tier: { type: 'string', description: '值得看|可以看|不值当' },
      limit: { type: 'number', description: '条数，默认 8' },
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
    description: '读一条笔记全文。id / bvid / path 给一个即可。',
    parameters: {
      id: { type: 'string', description: '条目 id' },
      bvid: { type: 'string', description: 'BV号' },
      path: { type: 'string', description: '相对路径' },
      full: { type: 'boolean', description: '返回完整正文（默认截到 8000 字）' },
    },
    async execute(args) {
      const p = String(args.path || '').trim()
      if (p && !insideRoot(p) && !/^entries[\\/]/.test(p)) {
        return { ok: false, error: 'path 必须在知识库目录里（用 kb_search 返回的 path）' }
      }
      try {
        const e = findEntry(root, { id: args.id, bvid: args.bvid, path: p })
        // ⭐ 默认截到 8000 字（≈2.5k token）：读一条笔记不该吃掉半个上下文窗口。
        //    确实要全文再传 full: true（上限 60k 字）。
        const cap = args.full ? 60000 : 8000
        const text = e.text.length > cap ? e.text.slice(0, cap) + `\n…（已截断，原 ${e.text.length} 字；要全文传 full: true）` : e.text
        return { ok: true, meta: e.meta, body: cap >= 60000 ? e.body : undefined, text, truncated: e.text.length > cap }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_add ─────────────── */
  // ⚠️ 描述从 1050 字符压到 ~300：工具定义是**每轮请求都带上**的固定 token 开销（2026-10-28 实测
  //    8 只工具共 4547 字符 ≈ 1.5k~2.1k token）。功能不变，只把话说短。
  tool({
    name: 'kb_add',
    description: '新增/更新一条笔记。按 BV号 → URL → 日期+标题 判重（再次写是同一条的更新）。要点必须是原文里读到的，别编。',
    parameters: {
      title: { type: 'string', description: '标题（必填）' },
      bvid: { type: 'string', description: 'BV号' },
      url: { type: 'string', description: '链接' },
      up: { type: 'string', description: 'UP主' },
      date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
      kind: { type: 'string', description: '知识|有意思' },
      tier: { type: 'string', description: '值得看|可以看|不值当' },
      status: { type: 'string', description: '待看|已看|略过' },
      tags: { type: 'string', description: '逗号分隔，3~6 个' },
      summary: { type: 'string', description: '一句话' },
      points: { type: 'string', description: '要点，一行一条' },
      excerpt: { type: 'string', description: '原文摘录' },
      notes: { type: 'string', description: '备注' },
      source: { type: 'string', description: '来源' },
      origin: { type: 'string', description: '来源渠道：b站|qq|dsh' },
    },
    async execute(args) {
      try {
        const r = writeEntry(root, args)
        afterWriteIndex(root)              // INDEX.md 一分钟最多重写一次；jsonl 已增量更新
        const total = listEntries(root).length
        log(`kb_add ${r.action} ${r.id}`)
        return { ok: true, ...r, total }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_related ─────────────── */
  tool({
    name: 'kb_related',
    description: '找同主题的旧笔记（标签+关键词+文字相似度，纯本地）。用你打算给它打的标签比最准；exclude 传当前 BV号。',
    parameters: {
      text: { type: 'string', description: '标题/摘要/要点' },
      tags: { type: 'string', description: '标签，逗号分隔' },
      exclude: { type: 'string', description: '排除的 BV号 / id' },
      limit: { type: 'number', description: '条数，默认 3' },
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

  /* ─────────────── kb_ingest：其它进料通道 ─────────────── */
  tool({
    name: 'kb_ingest',
    description: '收外部内容进知识库：from=url 抓网页 / file 导文件 / dir 批量导目录 / feed 收 RSS·Atom。'
      + '要点如实摘取、不是总结；同一 url 再收是更新。只支持 http/https，不抓内网。',
    parameters: {
      from: { type: 'string', description: 'url|file|dir|feed' },
      url: { type: 'string', description: 'url/feed 的地址' },
      path: { type: 'string', description: 'file 的路径' },
      dir: { type: 'string', description: 'dir 的目录' },
      ext: { type: 'string', description: 'dir 只收该扩展名，如 .md' },
      limit: { type: 'number', description: 'dir/feed 最多几条' },
      tags: { type: 'string', description: '逗号分隔' },
      kind: { type: 'string', description: '知识|有意思' },
      tier: { type: 'string', description: '值得看|可以看|不值当' },
      summary: { type: 'string', description: '覆盖自动摘要' },
      notes: { type: 'string', description: '备注' },
    },
    async execute(args) {
      if (!cfg.tools.ingest) return { ok: false, error: 'kb_ingest 已在设置里关掉（设置 → 知识库 → 工具开关）' }
      const from = String(args.from || '').trim().toLowerCase()
      const common = {
        tags: String(args.tags || ''), kind: String(args.kind || '知识'),
        tier: String(args.tier || '可以看'), notes: String(args.notes || ''), summary: String(args.summary || ''),
      }
      try {
        if (from === 'url') {
          if (!args.url) return { ok: false, error: 'from=url 需要 url' }
          return { ok: true, ...(await ingestUrl(root, { url: String(args.url), ...common })) }
        }
        if (from === 'file') {
          if (!args.path) return { ok: false, error: 'from=file 需要 path' }
          return { ok: true, ...ingestFile(root, { path: String(args.path), ...common }) }
        }
        if (from === 'dir') {
          if (!args.dir) return { ok: false, error: 'from=dir 需要 dir' }
          return { ok: true, ...ingestDir(root, { dir: String(args.dir), ext: String(args.ext || ''), limit: args.limit, ...common }) }
        }
        if (from === 'feed') {
          if (!args.url) return { ok: false, error: 'from=feed 需要 url' }
          return { ok: true, ...(await ingestFeed(root, { url: String(args.url), limit: args.limit, ...common })) }
        }
        return { ok: false, error: `from 只能是 url / file / dir / feed，收到「${from || '(空)'}」` }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_capture：随手记 ─────────────── */
  tool({
    name: 'kb_capture',
    description: '随手记一段文本，自动起标题、抽要点（标 via: note）。比 kb_add 轻，只要给 text。',
    parameters: {
      text: { type: 'string', description: '要存的内容（必填）' },
      title: { type: 'string', description: '标题，默认取第一句' },
      tags: { type: 'string', description: '标签，逗号分隔' },
      source: { type: 'string', description: '来源，默认 chat' },
    },
    async execute(args) {
      if (!cfg.tools.capture) return { ok: false, error: 'kb_capture 已在设置里关掉（设置 → 知识库 → 工具开关）' }
      try {
        const r = capture(root, {
          title: args.title ? String(args.title) : '',
          text: String(args.text || ''),
          tags: String(args.tags || ''),
          kind: '知识',
          tier: '可以看',
          source: String(args.source || 'chat'),
        })
        afterWriteIndex(root)
        const total = listEntries(root).length
        log(`kb_capture ${r.action} ${r.id}`)
        return { ok: true, ...r, total }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  /* ─────────────── kb_index ─────────────── */
  tool({
    name: 'kb_index',
    description: '重建索引（手改过 entries 后调用）。',
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
  /* ─────────────── 记忆库（和知识库分开的另一本账） ───────────────
   * 知识库 = 「那期视频讲了什么」，查档案；
   * 记忆库 = 「你上次跟我说过什么」，记人和事。
   * 存储见 lib/memory.mjs；原始对话流水由 /api/feiyu-chat 自动追加，不靠模型动手。
   */
  // 环境变量优先：selftest 靠它把记忆库也隔离到临时目录（否则会写进真库）
  const memRoot = () => process.env.FEIYU_MEMORY_ROOT || resolveMemoryRoot(cfg.memory?.root)
  const memOn = () => cfg.memory?.enabled !== false

  tool({
    name: 'mem_add',
    description: '记下值得记住的事（对方说过什么、约定、偏好、重要事件）。这是「记忆」不是「知识」；视频知识才用 kb_add。',
    parameters: {
      text: { type: 'string', description: '要记住的内容（一两句话，别写流水账）' },
      title: { type: 'string', description: '短标题，默认取第一行' },
      kind: { type: 'string', description: '对话|偏好|约定|事件|人物' },
      who: { type: 'string', description: '跟谁有关' },
      tags: { type: 'string', description: '逗号分隔，最多 8 个' },
      importance: { type: 'number', description: '1~3，默认 2' },
    },
    async execute(args) {
      if (!memOn()) return { ok: false, error: '记忆库已在配置里关闭' }
      try {
        const r = writeMemory(memRoot(), args)
        try { rebuildMemoryIndex(memRoot()) } catch { /* 索引坏了不影响正文 */ }
        try { writeDigest(memRoot()) } catch { /* 摘要只是给别的通道用，失败无妨 */ }
        log(`mem_add ${r.id}`)
        return { ok: true, ...r }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  tool({
    name: 'mem_search',
    description: '搜记忆：说过的话、约定、偏好、旧对话。关键词用空格分开（全部命中才算）。',
    parameters: {
      query: { type: 'string', description: '关键词，空格分隔' },
      tags: { type: 'string', description: '标签过滤' },
      limit: { type: 'number', description: '条数，默认 5' },
      chats: { type: 'boolean', description: '是否也搜原始对话流水（默认 true）' },
    },
    async execute(args) {
      if (!memOn()) return { ok: false, error: '记忆库已关闭' }
      try {
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))
        const mems = searchMemories(memRoot(), { query: args.query || '', tags: args.tags || [], limit })
        const chats = args.chats === false ? [] : searchChats(memRoot(), { query: args.query || '', limit: 3 })
        return {
          ok: true,
          memories: mems.map((m) => ({
            id: m.meta.id, date: m.meta.date, time: m.meta.time, kind: m.meta.kind,
            title: m.meta.title, tags: m.meta.tags,
            text: m.body.replace(/^#.*$/m, '').trim().slice(0, 400),
          })),
          chats,
          total: mems.length + chats.length,
        }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  })

  tool({
    name: 'mem_read',
    description: '按 id 读一条完整记忆。',
    parameters: { id: { type: 'string', description: '记忆 id' } },
    async execute(args) {
      const hit = readMemory(memRoot(), args.id)
      return hit ? { ok: true, id: hit.meta.id, meta: hit.meta, text: hit.body } : { ok: false, error: '没这条记忆' }
    },
  })

  tool({
    name: 'mem_status',
    description: '记忆库概况：多少条、最近一条、对话流水天数。',
    parameters: {},
    async execute() {
      try { return { ok: true, ...memoryStatus(memRoot()), enabled: memOn() } }
      catch (err) { return { ok: false, error: String(err?.message ?? err) } }
    },
  })

  /* ─────────────── 全局记忆记录器：三个通道都进同一本账 ───────────────
   * 不在各通道分别写，而是订阅会话事件：QQ 走 /api/feiyu-chat、B站 走生物钟投递、
   * DSH 直接聊 —— 最后都会落进同一个 dsh-feiyu 会话。记在会话上，等于全记了。
   */
  try { writeDigest(memRoot()) } catch { /* 摘要失败无妨 */ }
  const BRAIN_SESSION = 'dsh-feiyu'
  if (typeof ctx.on === 'function' && cfg.memory?.enabled !== false) {
    const pend = new Map()
    const cleanUser = (t) => {
      const s = String(t || '')
      const i = s.lastIndexOf('［用户消息］')
      if (i >= 0) return { text: s.slice(i + '［用户消息］'.length).trim(), src: 'qq' }
      if (s.includes('【生物钟】')) {
        const line = (s.match(/【生物钟】[^\n]*/) || [''])[0].replace('【生物钟】', '').trim()
        return { text: '【B站轮次】' + line, src: 'bili' }
      }
      if (/Time sampled|system-reminder/.test(s)) return null
      return { text: s.trim(), src: 'dsh' }
    }
    try {
      const dispose = ctx.on('session/event', (session, event) => {
        try {
          if (cfg.memory?.enabled === false) return
          const sid = String(session?.header?.id ?? session?.id ?? '')
          if (sid !== BRAIN_SESSION) return
          const type = event?.type
          if (type === 'user/message' && event?.data?.source?.kind === 'user') {
            const parts = (event.data.content || []).map((b) => (b && b.type === 'text' ? b.text : '')).join('\n')
            const cleaned = cleanUser(parts)
            if (!cleaned || !cleaned.text) return
            // 按会话关闭：只对 DSH 侧生效 —— QQ / B站 两条通道始终记录
            const off = Array.isArray(cfg.memory?.sessionOff) ? cfg.memory.sessionOff : []
            if (off.includes(sid) && cleaned.src !== 'qq' && cleaned.src !== 'bili') return
            pend.set(sid, { ...cleaned, at: event.time || Date.now(), reply: '' })
            return
          }
          if (type === 'assistant/message') {
            const p = pend.get(sid)
            if (!p) return
            const t = (event?.data?.message?.content || [])
              .filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('')
            if (t) p.reply = p.reply ? p.reply + '\n' + t : t
            return
          }
          if (type === 'turn/end') {
            const p = pend.get(sid)
            if (!p) return
            pend.delete(sid)
            if (!p.text && !p.reply) return
            appendChat(memRoot(), {
              user: p.text, reply: p.reply, source: p.src, at: p.at,
              who: p.src === 'qq' ? '狗修鲸' : '',
            })
          }
        } catch { /* 记不上不影响对话 */ }
      })
      try { ctx.effect(() => () => { try { dispose?.() } catch { /* 忽略 */ } }, 'feiyu-kb: 记忆记录器') } catch { /* 没有 effect 就常驻 */ }
      log(`记忆记录器已挂上（会话 ${BRAIN_SESSION}）`)
    } catch (e) {
      log(`记忆记录器没起来：${e?.message ?? e}`)
    }
  }

  /* ─────────────── 设置页用的 HTTP 接口（可选：没有 webServer 就跳过） ─────────────── */
  /**
   * 只接本机同源请求 —— 别的网页在浏览器里也能打到 127.0.0.1，
   * 所以要比对 Host 是本机、Origin/Referer 与请求同源（抄 dsh-bili-scroll 的加固）。
   */
  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers?.host || '')
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const site = req.headers?.origin || req.headers?.referer
      if (!site) return true
      const u = new URL(site)
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return false
      return !u.port || u.port === String(host).split(':')[1]
    } catch { return false }
  }

  /** 要体检的 profile 目录（headless 里跑的时候名字不一样，用环境变量兜底） */
  const profileDirs = () => {
    const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
    return [join(dshHome, 'profiles', process.env.DSH_PROFILE || 'desktop')]
  }

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch { /* 客户端断了就算了 */ }
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const statusView = () => {
    const s = stats(root)
    let ctxApplied = { applied: false }
    try { ctxApplied = compactionStatus(profileDirs()[0]) } catch { /* 读不到就算了 */ }
    const syncDirsEff = (cfg.sync.dirs && cfg.sync.dirs.length) ? cfg.sync.dirs : DEFAULT_SYNC_DIRS
    let syncState = { files: 0, updatedAt: '', dirs: [] }
    try { syncState = syncStatus(syncDirsEff) } catch { /* 忽略 */ }
    return {
      ok: true, root, configPath: configPath(), tools: cfg.tools, ctx: cfg.ctx, ctxApplied, sync: cfg.sync, syncState,
      defaults: { tools: DEFAULT_TOOLS, ctx: DEFAULT_CTX, sync: DEFAULT_SYNC },
      entries: s.entries, byKind: s.byKind, byTier: s.byTier, latest: s.latest, topTags: s.topTags,
      indexPath: s.indexPath,
    }
  }

  /* ─────────────── /api/feiyu-chat：QQ 通道 → 唯一大脑 ───────────────
   * 2026-10-30（合并三条鱼 · P3）。三条实测结论决定了写法：
   *   R2 —— `prompt()` 只回 `{ accepted: true }`，**拿不到回复文本**。
   *   ⚠️ 别用 `page({throughSeq:-1})` 取尾部：源码 `end = min(-1+1, …) = 0` ⇒ 永远空页（踩过）。
   *      正确姿势是 `follow()`：先给 `{ type:'snapshot', cursor, records }`，
   *      之后按 seq 推 `{ type:'event', event }`；assistant 正文在
   *      `event.type==='assistant/message'` 的 `event.message.content[*].text`。
   *   会话不存在时 `follow`/`prompt` 都 SESSION_NOT_FOUND ⇒ 必须先 `create()`。
   *   R3 —— 同一会话串行（writer lock + `session/agent-busy`）⇒ 忙时必须降级回话。
   */
  // 生产默认 120s；测试可用 FEIYU_CHAT_TIMEOUT_MS 缩短
  const CHAT_TIMEOUT_MS = Number(process.env.FEIYU_CHAT_TIMEOUT_MS) || 120_000
  // 大脑会话的工作目录。**每次现读配置**，换目录不用重启 DSH。
  //   优先级：feiyu-kb.config.json 的 brainCwd > 环境变量 > 默认（D 盘工作区里的独立子目录）
  //   放独立子目录而不是工作区根：根目录的 AGENTS.md 是施工约定，会被注入成人格，跟人设打架。
  const chatCwd = () => {
    try {
      const c = JSON.parse(readFileSync(configPath(), 'utf8'))
      if (typeof c.brainCwd === 'string' && c.brainCwd.trim()) return c.brainCwd.trim()
    } catch { /* 读不到就用默认 */ }
    return process.env.FEIYU_BRAIN_CWD || 'D:\\dsh工作区\\feiyu-brain'
  }
  const CHAT_BUSY_TEXT = '我在忙，等我一下喵……'

  /**
   * 从一条事件里抠出她的回答正文。
   * ⚠️ 实测事件形状是 `{ type, seq, time, data:{ turn, step, message } }` —— 正文在 `data.message`；
   *    且 content 里混着 `reasoning` / `tool-call`，**只认 `type==='text'`**（否则会把内心独白发给用户）。
   */
  const chatTextOf = (event) => {
    const message = event?.data?.message ?? event?.message ?? event
    if (!message) return ''
    if (typeof message === 'string') return message
    const blocks = Array.isArray(message.content) ? message.content : []
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }

  /** 读唯一人设源。插件跑在宿主进程里，不受会话沙箱限制，能读到 D: 上的 whale.md */
  const chatPersona = () => {
    const candidates = [
      process.env.FEIYU_PERSONA_FILE,
      join('D:', 'dsh工作区', 'persona', 'whale.md'),
      join(process.env.USERPROFILE || process.env.HOME || '.', '.bili-ai', 'persona.md'),
    ].filter(Boolean)
    for (const p of candidates) {
      try {
        const t = readFileSync(p, 'utf8').trim()
        if (t) return t
      } catch { /* 试下一个 */ }
    }
    return ''
  }

  /**
   * 投一个问题、跟一段历史、攒出她的回答。
   *
   * ⚠️ 2026-10-30 实测踩坑：两个请求并发时**都拿到了同一条回复**（B 回了 A 的答案）。
   *    根因是大家共用"看到 assistant/message 就收"的策略。现在改成：
   *      ① 先 follow 拿 snapshot → 再 prompt（带唯一 requestId）
   *      ② 在事件流里**认领** `user/message` 中 rpcId 等于自己 requestId 的那条
   *      ③ 等它之后第一个 `turn/start`，**锁死自己的 turn 号**
   *      ④ 只收 `data.turn === 我的 turn` 的 assistant/message，只在这个 turn 的 `turn/end` 收工
   *    这样并发、排队都不会串台。
   * @param {() => void} stopStream 看完 turn/end 后主动叫停生成器（否则它会卡在等事件上）
   */
  const chatAsk = async (ctl, sessionId, text, signal, stopStream) => {
    if (typeof ctl.follow !== 'function') throw new Error('sessionController.follow 不可用')
    const address = { kind: 'session', sessionId }
    const requestId = `feiyu-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const texts = []
    let done = false
    let mineSeen = false
    let myTurn = null
    let lastTurn = null
    let myItemId = null   // 排队里那条消息的 id：超时后用它撤销，避免"幽灵回答"
    let prompted = false
    const stream = ctl.follow({ address, maxMessages: 200 }, signal)
    try {
      for await (const rec of stream) {
        if (signal?.aborted) break
        if (rec?.type === 'snapshot' && !prompted) {
          prompted = true
          try {
            await ctl.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, signal)
          } catch (e) {
            stopStream?.()   // 先叫停：否则异常冒泡时 IteratorClose 会一直等生成器
            throw e
          }
          continue
        }
        if (rec?.type !== 'event') continue
        const ev = rec.event
        if (!ev) continue
        // ⚠️ 实测顺序：turn/start(seq 4) **早于** user/message(seq 8)。
        //    所以先记住最近一次 turn/start，等自己的用户消息到了再绑定。
        if (ev.type === 'turn/start' && typeof ev.data?.turn === 'number') {
          lastTurn = ev.data.turn
          if (mineSeen && myTurn === null) myTurn = lastTurn
          continue
        }
        // ② 认领自己那条用户消息 → 绑定到它所属的 turn
        if (!mineSeen) {
          if (ev.type === 'user/message' && ev.data?.source?.rpcId === requestId) {
            mineSeen = true
            myItemId = ev.data?.id ?? null
            if (lastTurn !== null) myTurn = lastTurn
          }
          continue
        }
        // ④ 只收自己这一轮的
        if (ev.type === 'assistant/message' && ev.data?.turn === myTurn) {
          const t = chatTextOf(ev)
          if (t) texts.push(t)
        } else if (ev.type === 'turn/end' && ev.data?.turn === myTurn) {
          done = true
          stopStream?.()   // 先叫停再 break：否则 IteratorClose 会一直等生成器醒来
          break
        }
      }
    } catch (e) {
      if (!signal?.aborted) throw e   // 主动叫停/超时导致的 AbortError 不算失败
    }
    return { text: texts.join('').trim(), done, myItemId, myTurn }
  }

  const handleChat = async (req, res, ctxRef) => {
    if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
    let body
    try { body = await readBody(req) } catch { return sendJson(res, 400, { ok: false, error: '请求体读不出来' }) }
    const text = String(body?.text ?? '').trim()
    if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' })
    const sessionId = String(body?.sessionId ?? 'dsh-feiyu').trim() || 'dsh-feiyu'
    // 大脑会话 cwd 在 D:/dsh工作区/feiyu-brain（workspace-write 沙箱），读不到 D: 上的人设 ⇒ 由插件注入
    const persona = chatPersona()
    // 记忆：把最近几条「值得记住的事」塞进提示，让她张口就知道上次聊到哪
    const memBlock = (() => {
      try {
        if (cfg.memory?.enabled === false) return ''
        // 注意：QQ/B站 通道默认**总是**引用全局记忆，不受界面开关影响（开关只对会话生效）
        const n = Number(cfg.memory?.inject ?? 5) || 0
        if (n <= 0) return ''
        const recent = recentMemories(memRoot(), n)
        if (!recent.length) return ''
        return '［最近的记忆］\n' + recent.map((m) => `· ${m.date} ${m.title}${m.line ? '：' + String(m.line).slice(0, 60) : ''}`).join('\n') + '\n\n'
      } catch { return '' }
    })()
    const payload = `${memBlock}${persona
      ? `［她的人设］以下是她专属的设定，说话 / 写日记 / 选题都以它为准；与其它说法冲突时以这一份为准：\n${persona}\n\n`
      : ''}［用户消息］\n${text}`

    // 运行时取控制器：不能写进 inject（headless 可能没有）
    let ctl
    for (const c of [ctxRef, ctx]) {
      try {
        const v = c?.get?.('sessionController') || c?.sessionController
        if (v?.prompt) { ctl = v; break }
      } catch { /* 继续找 */ }
    }
    if (!ctl?.prompt) return sendJson(res, 503, { ok: false, error: 'sessionController 不可用' })

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS)
    const started = Date.now()
    try {
      // 会话不存在时 follow/prompt 都会 SESSION_NOT_FOUND ⇒ 先 create（已存在则复用）
      try { await ctl.create?.({ sessionId, cwd: chatCwd() }) } catch { /* 已存在或正被占用 */ }
      const outcome = await chatAsk(ctl, sessionId, payload, ac.signal, () => ac.abort())
      // 超时且还没轮到自己 ⇒ 把排队的 prompt 撤掉，别让它事后自己跑出个"幽灵回答"
      if (!outcome.done && ac.signal.aborted && outcome.myItemId && outcome.myTurn === null && typeof ctl.updateQueue === 'function') {
        try { await ctl.updateQueue({ sessionId, itemId: outcome.myItemId, action: { kind: 'remove' } }) } catch { /* 已经开跑就撤不掉，正常 */ }
      }
      if (!outcome.text) return sendJson(res, 200, { ok: true, busy: !outcome.done, text: outcome.done ? '（她这次没说话）' : CHAT_BUSY_TEXT, sessionId })
      // 对话流水不在这里写：统一由「全局记忆记录器」在 session/event 上记，避免两条通道重复记一遍
      return sendJson(res, 200, { ok: true, text: outcome.text, sessionId, ms: Date.now() - started })
    } catch (e) {
      const s = String(e?.code ?? '') + ' ' + String(e?.message ?? '')
      if (/busy/i.test(s)) return sendJson(res, 200, { ok: true, busy: true, text: CHAT_BUSY_TEXT, sessionId })
      const timedOut = ac.signal.aborted
      return sendJson(res, 200, {
        ok: false, busy: timedOut, sessionId,
        error: timedOut ? '超时' : String(e?.message ?? e),
        text: timedOut ? CHAT_BUSY_TEXT : undefined,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  const mountRoutes = (ws, hostCtx) => {
    if (!ws?.register) { log('没有 webServer（或没有 register）：设置页接口没挂（工具照常可用）'); return }
    try {
      ;(typeof hostCtx.effect === 'function' ? hostCtx.effect : effect)(() => ws.register({
        kind: 'prefix',
        path: '/api/feiyu-kb',
        handler: async (req, res) => {
          if (!sameOriginOk(req)) { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }); return }
          const url = new URL(req.url, 'http://127.0.0.1')
          const path = url.pathname
          try {
            if (req.method === 'GET' && path === '/api/feiyu-kb/status') return sendJson(res, 200, statusView())
            // 输入框下的「全局记忆」开关：按会话记开/关。QQ/B站 两条通道不受它影响。
            if (req.method === 'POST' && path === '/api/feiyu-kb/memory/session') {
              const body = await readBody(req)
              const sid = String(body?.sessionId || '').trim()
              if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId 不能为空' })
              const off = new Set(cfg.memory?.sessionOff || [])
              if (body?.off === true) off.add(sid)
              else if (body?.off === false) off.delete(sid)
              cfg = saveConfig({ memory: { sessionOff: [...off] } })
              return sendJson(res, 200, { ok: true, sessionId: sid, off: off.has(sid), sessionOff: cfg.memory.sessionOff })
            }
            if (req.method === 'GET' && path === '/api/feiyu-kb/config') {
              return sendJson(res, 200, { ok: true, config: cfg, root, configPath: configPath(), defaults: { tools: DEFAULT_TOOLS } })
            }
            if (req.method === 'POST' && path === '/api/feiyu-kb/config') {
              const body = await readBody(req)
              const patch = {}
              if (typeof body.root === 'string') patch.root = body.root
              if (body.tools && typeof body.tools === 'object') {
                patch.tools = {}
                for (const k of ['ingest', 'capture']) {
                  if (typeof body.tools[k] === 'boolean') patch.tools[k] = body.tools[k]
                }
              }
              if (body.ctx && typeof body.ctx === 'object') {
                patch.ctx = {}
                if (typeof body.ctx.enabled === 'boolean') patch.ctx.enabled = body.ctx.enabled
                for (const k of ['thresholdRatio', 'retainRatio']) {
                  if (body.ctx[k] !== undefined) patch.ctx[k] = body.ctx[k]
                }
              }
              if (body.sync && typeof body.sync === 'object') {
                patch.sync = {}
                if (typeof body.sync.enabled === 'boolean') patch.sync.enabled = body.sync.enabled
                if (Array.isArray(body.sync.dirs)) patch.sync.dirs = body.sync.dirs
                if (body.sync.intervalMinutes !== undefined) patch.sync.intervalMinutes = body.sync.intervalMinutes
              }
              if (body.memory && typeof body.memory === 'object') {
                patch.memory = {}
                if (typeof body.memory.enabled === 'boolean') patch.memory.enabled = body.memory.enabled
                if (typeof body.memory.root === 'string') patch.memory.root = body.memory.root
                if (body.memory.inject !== undefined) patch.memory.inject = body.memory.inject
                if (Array.isArray(body.memory.sessionOff)) patch.memory.sessionOff = body.memory.sessionOff
              }
              cfg = saveConfig(patch)
              if (patch.sync) startSync()          // 目录同步改了：重启定时器（立即生效，不用重启）
              if (typeof body.root === 'string') {
                const next = applyRoot()
                log(`设置页：库位置改为 ${next}`)
              }
              // 上下文压缩是**写 profile** 的操作：备份 + 校验 + 失败还原都在 syncCompaction 里
              let sync = null
              if (patch.ctx) {
                sync = syncCompaction({
                  profileDir: profileDirs()[0], enabled: cfg.ctx.enabled,
                  thresholdRatio: cfg.ctx.thresholdRatio, retainRatio: cfg.ctx.retainRatio, log,
                })
                if (!sync.ok) log(`设置页：压缩配置没改成功 —— ${sync.error}`)
                else if (sync.changed) log('设置页：压缩配置已更新（需要热重载/重启才生效）')
              }
              return sendJson(res, 200, { ok: true, config: cfg, sync, ...statusView() })
            }
            if (req.method === 'POST' && path === '/api/feiyu-kb/index') {
              const meta = rebuildIndex(root)
              log('设置页：重建索引')
              return sendJson(res, 200, { ok: true, ...meta, indexPath: join(root, 'INDEX.md') })
            }
            // 体检：看上次报告 / 立刻跑一次
            if (req.method === 'GET' && path === '/api/feiyu-kb/diagnostics') {
              const st = lastWatchdogState()
              let report = ''
              try { if (st.lastReport) report = readFileSync(st.lastReport, 'utf8').slice(0, 20000) } catch { /* 没报告就算了 */ }
              return sendJson(res, 200, { ok: true, ...st, report })
            }
            if (req.method === 'POST' && path === '/api/feiyu-kb/diagnose') {
              const r = runDiagnosis({ reason: '手动体检（设置页）', log, kbRoot: root, profileDirs: profileDirs() })
              return sendJson(res, 200, { ok: true, file: r.file, findings: r.findings, report: r.report })
            }
            return sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${path}` })
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
          }
        },
      }), 'feiyu-kb: /api/feiyu-kb 路由')
      // 2026-10-30（合并三条鱼 · P3）：QQ 通道 → 唯一大脑（只本机可调）
      ;(typeof hostCtx.effect === 'function' ? hostCtx.effect : effect)(() => ws.register({
        kind: 'prefix',
        path: '/api/feiyu-chat',
        handler: (req, res) => handleChat(req, res, hostCtx),
      }), 'feiyu-kb: /api/feiyu-chat 路由')
      log('设置页接口已挂载：/api/feiyu-kb · 大脑通道已挂载：/api/feiyu-chat')
    } catch (e) {
      log(`设置页接口没挂上：${e?.message ?? e}`)
    }
  }

  // ⭐ webServer 是**异步就绪**的服务：在 apply() 里直接 ctx.get('webServer') 时有时无
  //    （2026-10-28 实测：同一份代码，13:48 挂上了、14:00 又没挂上）⇒ 必须用运行时注入，
  //    等这个服务真的起来再挂路由。
  //    ⚠️ 不能写进 `inject`：headless profile 没有 webServer，那样整条插件都不激活、工具全没。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sub) =>
        mountRoutes((typeof sub.get === 'function' ? sub.get('webServer') : undefined) || sub.webServer, sub))
    } catch (e) {
      log(`运行时注入 webServer 失败：${e?.message ?? e}`)
    }
  } else {
    mountRoutes(typeof ctx.get === 'function' ? ctx.get('webServer') : undefined, ctx)
  }

  /* ─────────────── 上下文压缩调参（设置页开关） ─────────────── */
  // 打开时：把 profile 的 patch 写一块「thresholdRatio / retainRatio」覆盖（备份 + 校验 + 失败还原）。
  // 关着时：确认那块不存在（用户自己手写的行一个字不碰）。
  try {
    const r = syncCompaction({
      profileDir: profileDirs()[0], enabled: cfg.ctx.enabled,
      thresholdRatio: cfg.ctx.thresholdRatio, retainRatio: cfg.ctx.retainRatio, log,
    })
    if (!r.ok) log(`压缩配置同步失败：${r.error}`)
    else if (r.changed) log('压缩配置已按设置同步（需热重载/重启生效）')
  } catch (e) {
    log(`压缩配置同步没跑成：${e?.message ?? e}`)
  }

  /* ─────────────── 目录同步：从上游插件的产出里"捞"知识 ─────────────── */
  // 2026-10-29：刷视频的自动归档一次都没跑通（headless 在模型路由就失败了）。
  // 这一层是兜底：定时扫指定目录里的 .md，发现新的就收进知识库 —— 不管上游跑没跑成。
  let syncTimer = null
  let syncBootTimer = null
  const runSync = () => {
    try {
      const dirs = (cfg.sync.dirs && cfg.sync.dirs.length) ? cfg.sync.dirs : DEFAULT_SYNC_DIRS
      const r = syncDirs({ root, dirs, log })
      if (r.imported.length) log(`目录同步：+${r.imported.length} 条`)
      return r
    } catch (e) { log(`目录同步没跑成：${e?.message ?? e}`); return null }
  }
  const startSync = () => {
    try { if (syncTimer) clearInterval(syncTimer) } catch { /* 忽略 */ }
    try { if (syncBootTimer) clearTimeout(syncBootTimer) } catch { /* 忽略 */ }
    syncTimer = null
    syncBootTimer = null
    if (!cfg.sync.enabled) return
    syncBootTimer = setTimeout(runSync, 6000)
    syncBootTimer.unref?.()
    syncTimer = setInterval(runSync, Math.max(60_000, Number(cfg.sync.intervalMinutes || 10) * 60_000))
    syncTimer.unref?.()
    log(`目录同步已启动（每 ${cfg.sync.intervalMinutes || 10} 分钟，目录：${((cfg.sync.dirs && cfg.sync.dirs.length) ? cfg.sync.dirs : DEFAULT_SYNC_DIRS).join(' ; ')}）`)
  }
  startSync()
  effect(() => () => {
    try { if (syncTimer) clearInterval(syncTimer) } catch { /* 忽略 */ }
    try { if (syncBootTimer) clearTimeout(syncBootTimer) } catch { /* 忽略 */ }
  }, 'feiyu-kb: 目录同步定时器')

  /* ─────────────── 异常自动体检（看门狗） ─────────────── */
  // 启动 3 秒后先查一遍崩溃日志（补报"上次起不来"），之后每 5 分钟扫一次新崩溃 / profile 被回滚。
  try {
    const wd = startWatchdog({
      log,
      getRoot: () => root,
      profileDirs: profileDirs(),
      pkgDir: PKG_DIR,
      onDiagnosis: (r) => {
        const bad = r.findings.filter((f) => f.level !== 'ok').map((f) => f.title)
        log(`⚠️ 体检发现问题：${bad.join('；')} —— 报告：${r.file}`)
      },
    })
    effect(() => () => wd.stop(), 'feiyu-kb: 异常看门狗')
    log('异常看门狗已启动（启动 + 每 10 分钟查崩溃日志）')
  } catch (e) {
    log(`看门狗没起来：${e?.message ?? e}`)
  }
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


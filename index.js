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
  rememberRoot, searchEntries, relatedEntries, findEntry, rebuildIndex, stats, listEntries,
} from './lib/kb.mjs'

import { ingestUrl, ingestFile, ingestDir, ingestFeed, capture } from './lib/ingest.mjs'
import { loadConfig, saveConfig, configPath, DEFAULT_TOOLS } from './lib/config.mjs'

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

  /* ─────────────── kb_ingest：其它进料通道 ─────────────── */
  tool({
    name: 'kb_ingest',
    description: '把**外部东西**收进知识库 —— 不依赖刷B站插件：\n'
      + '- `from=url`：抓一个网页，抽标题 / 正文 / 要点（只 http/https，不抓内网）\n'
      + '- `from=file`：导入一个本地文本文件（md / txt / json / 代码…）\n'
      + '- `from=dir`：批量导入一个目录里的文本文件（一篇一个条目）\n'
      + '- `from=feed`：RSS / Atom 订阅，每条收一条（默认 status=待看）\n'
      + '⚠️ 要点是**从正文里如实摘的**（标题行 / 列表 / 句子），不是模型总结；抽不出来就只留一句话。\n'
      + '⚠️ 同一个 url / BV 号再收一次是「更新」，不会多出一条。',
    parameters: {
      from: { type: 'string', description: 'url | file | dir | feed' },
      url: { type: 'string', description: 'from=url 或 from=feed 时的地址' },
      path: { type: 'string', description: 'from=file 时的文件绝对/相对路径' },
      dir: { type: 'string', description: 'from=dir 时的目录' },
      ext: { type: 'string', description: 'from=dir 只收这个扩展名（例：.md）' },
      limit: { type: 'number', description: 'dir 最多几个文件 / feed 最多几条（默认 10~20）' },
      tags: { type: 'string', description: '标签，逗号分隔' },
      kind: { type: 'string', description: `类型：${KINDS.join(' / ')}` },
      tier: { type: 'string', description: `档位：${TIERS.join(' / ')}` },
      summary: { type: 'string', description: '（可选）自己写一句话，覆盖自动抽取的' },
      notes: { type: 'string', description: '(可选) 备注' },
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
    description: '随手记：把一段文本（聊天里的、书上的、脑子里的）直接存成条目 —— 自动起标题、抽要点、标 `via: note`。\n'
      + '比 kb_add 轻：不用想 id / url / 档位，只要给 text。',
    parameters: {
      text: { type: 'string', description: '要存的内容（必填）' },
      title: { type: 'string', description: '标题（不给就用第一句）' },
      tags: { type: 'string', description: '标签，逗号分隔' },
      kind: { type: 'string', description: `类型：${KINDS.join(' / ')}` },
      tier: { type: 'string', description: `档位：${TIERS.join(' / ')}` },
      notes: { type: 'string', description: '备注' },
      source: { type: 'string', description: '来源（默认 chat；例：book / podcast / 会议）' },
    },
    async execute(args) {
      if (!cfg.tools.capture) return { ok: false, error: 'kb_capture 已在设置里关掉（设置 → 知识库 → 工具开关）' }
      try {
        const r = capture(root, {
          title: args.title ? String(args.title) : '',
          text: String(args.text || ''),
          tags: String(args.tags || ''),
          kind: String(args.kind || '知识'),
          tier: String(args.tier || '可以看'),
          notes: String(args.notes || ''),
          source: String(args.source || 'chat'),
        })
        const meta = rebuildIndex(root)
        log(`kb_capture ${r.action} ${r.id}`)
        return { ok: true, ...r, total: meta.entries }
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
    return {
      ok: true, root, configPath: configPath(), tools: cfg.tools, defaults: DEFAULT_TOOLS,
      entries: s.entries, byKind: s.byKind, byTier: s.byTier, latest: s.latest, topTags: s.topTags,
      indexPath: s.indexPath,
    }
  }

  const mountRoutes = (ws, hostCtx) => {
    if (!ws?.register) { log('没有 webServer（或没有 register）：设置页接口没挂（工具照常可用）'); return }
    try {
      hostCtx.effect(() => ws.register({
        kind: 'prefix',
        path: '/api/feiyu-kb',
        handler: async (req, res) => {
          if (!sameOriginOk(req)) { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }); return }
          const url = new URL(req.url, 'http://127.0.0.1')
          const path = url.pathname
          try {
            if (req.method === 'GET' && path === '/api/feiyu-kb/status') return sendJson(res, 200, statusView())
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
              cfg = saveConfig(patch)
              if (typeof body.root === 'string') {
                const next = applyRoot()
                log(`设置页：库位置改为 ${next}`)
              }
              return sendJson(res, 200, { ok: true, config: cfg, ...statusView() })
            }
            if (req.method === 'POST' && path === '/api/feiyu-kb/index') {
              const meta = rebuildIndex(root)
              log('设置页：重建索引')
              return sendJson(res, 200, { ok: true, ...meta, indexPath: join(root, 'INDEX.md') })
            }
            return sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${path}` })
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
          }
        },
      }), 'feiyu-kb: /api/feiyu-kb 路由')
      log('设置页接口已挂载：/api/feiyu-kb')
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

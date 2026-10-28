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
import { loadConfig, saveConfig, configPath, DEFAULT_TOOLS } from './lib/config.mjs'
import { startWatchdog, runDiagnosis, lastWatchdogState } from './lib/watchdog.mjs'

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

  const statusView = () => {    const s = stats(root)
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

  /* ─────────────── 异常自动体检（看门狗） ─────────────── */
  // 2026-10-28 使用者要求：DSH 一出现异常就自动跑体检。
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
    ctx.effect(() => () => wd.stop(), 'feiyu-kb: 异常看门狗')
    log('异常看门狗已启动（启动 + 每 5 分钟查崩溃日志）')
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

/**
 * lib/kb.mjs —— 大肥鱼知识库的核心（纯 Node，零依赖）
 * ============================================================================
 * 为什么是「纯 Markdown + 每篇一个文件」：
 *   · 任何模型（有没有插件都行）都能直接 read/write 这些文件 —— 这是"所有运行时都能用"的底线；
 *   · 用 gpt 之类的通用工具也能搜（grep），不依赖任何数据库；
 *   · index.jsonl / INDEX.md 只是**派生缓存**，删了随时能从 entries/ 重建。
 *
 * 目录：
 *   <root>/entries/<年>/<月>/<id>.md   一篇一个文件（YAML front-matter + Markdown 正文）
 *   <root>/INDEX.md                    人看的索引（kb_index 重建）
 *   <root>/index.jsonl                 机器看的索引（一行一条 JSON）
 *   <root>/.kb/meta.json               统计信息
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { homedir } from 'node:os'

// 默认库位置放在家目录里（别写死某台机器的盘符 —— 这是要发出去的包）；
// 想换位置：profile 里 bundle patch 的 config.root，或环境变量 FEIYU_KB_ROOT。
export const DEFAULT_ROOT = join(homedir(), 'dsh-feiyu-kb')
export const KINDS = ['知识', '有意思']
export const TIERS = ['值得看', '可以看', '不值当']
export const STATUSES = ['待看', '已看', '略过']

/**
 * 「当前生效的库在哪」的备忘文件：`$DSH_HOME/feiyu-kb.root`
 *
 * 为什么需要它（2026-10-28 的真 bug）：插件拿到的 root 来自 profile 的
 * `config.root`，而**命令行（kb-cli）看不到 profile 配置** ⇒ 它只认环境变量和默认值。
 * 结果同一台机器上 `kb_status` 说库在 D 盘、`kb-cli where` 说在家目录 ——
 * 配置里换过库位置的人，一用 CLI 兜底就会把笔记写进第二个库里（知识被劈成两半）。
 * 所以插件每次加载把自己的生效路径记在这儿，CLI 读它来对齐。
 */
export function activeRootFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feiyu-kb.root')
}

export function rememberRoot(root) {
  try {
    mkdirSync(dirname(activeRootFile()), { recursive: true })
    writeFileSync(activeRootFile(), String(root).replace(/\\/g, '/') + '\n', 'utf8')
  } catch { /* 记不住不致命：CLI 会退回默认值 */ }
}

export function rememberedRoot() {
  try {
    const s = readFileSync(activeRootFile(), 'utf8').trim()
    return s && existsSync(s) ? s : ''
  } catch { return '' }
}

/** 解析配置里的 root（支持 ~/，统一成正斜杠）
 *  优先级：显式传入 > FEIYU_KB_ROOT > 插件记下的生效路径 > 默认值 */
export function resolveRoot(raw) {
  let p = String(raw || '').trim()
    || String(process.env.FEIYU_KB_ROOT || '').trim()
    || rememberedRoot()
    || DEFAULT_ROOT
  if (p === '~') p = homedir()
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2))
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 建好目录骨架（幂等） */
export function ensureRoot(root) {
  for (const d of ['', '/entries', '/.kb']) {
    const p = join(root, d)
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  }
  return root
}

/* ─────────────── YAML front-matter：只认我们自己写出来的那个子集 ─────────────── */

const esc = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\r?\n/g, '\\n')

const unesc = (s) => String(s ?? '')
  .replace(/\\n/g, '\n')
  .replace(/\\"/g, '"')
  .replace(/\\\\/g, '\\')

function yamlValue(key, v) {
  if (Array.isArray(v)) return `${key}: [${v.map((x) => `"${esc(x)}"`).join(', ')}]`
  if (typeof v === 'number' || typeof v === 'boolean') return `${key}: ${v}`
  return `${key}: "${esc(v)}"`
}

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!mm) continue
    const [, key, rawVal] = mm
    const val = rawVal.trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((x) => unesc(x.trim().replace(/^"|"$/g, ''))).filter(Boolean)
    } else if (val.startsWith('"') && val.endsWith('"')) {
      meta[key] = unesc(val.slice(1, -1))
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      meta[key] = Number(val)
    } else {
      meta[key] = val
    }
  }
  return { meta, body: text.slice(m[0].length) }
}

/* ─────────────── id / 路径 ─────────────── */

const pad = (n) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(off) / 60))
  const mm = pad(Math.abs(off) % 60)
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
}

/** 把标题压成一个还能看的短 slug（只用来做文件名，判重靠 bvid） */
export function slugify(title, max = 32) {
  const clean = String(title || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/[，。！？、；：“”‘’（）【】《》…—～·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean.slice(0, max).trim() || 'untitled').replace(/\s/g, '_')
}

export function entryId({ date, bvid, title }) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : dayKey()
  const key = String(bvid || '').trim()
  return key ? `${d}-${key}` : `${d}-${slugify(title, 24)}`
}

export function entryPath(root, meta) {
  const file = `${meta.id}.md`
  const rel = ['entries', meta.id.slice(0, 4), meta.id.slice(5, 7), file].join('/')
  return { rel, abs: join(root, rel) }
}

/* ─────────────── 读 / 写 / 列表 ─────────────── */

export function readEntry(root, abs) {
  const text = readFileSync(abs, 'utf8')
  const { meta, body } = parseFrontMatter(text)
  meta.id = meta.id || abs.split(/[\\/]/).pop().replace(/\.md$/, '')
  meta.path = abs
  meta.rel = relative(root, abs).replace(/\\/g, '/')
  meta.bytes = Buffer.byteLength(text, 'utf8')
  return { meta, body, text }
}

/**
 * 列表缓存（2026-10-28 提速）
 * ============================================================================
 * 原来每次 kb_search / kb_related / kb_add 判重都要 `listEntries()` ——
 * 把 entries 下**所有 .md 打开、解析、读正文**。实测：3000 条时一次搜索 200ms、
 * 写一条 350ms，而且随条数线性涨（一次调用 = 开 N 个文件）。
 *
 * 现在：列表结果按 root 缓存，用「目录 mtime 签名 + TTL」判断要不要重扫。
 *   · 写完一条：直接 upsert 进缓存（不用重扫）
 *   · 别处改了文件：最迟 TTL 之后重扫一次
 *   · kb_index / rebuildIndex：强制重扫
 */
const CACHE_TTL_MS = 30_000
const ENTRY_CACHE = new Map()   // root -> { sig, at, entries }

/** 便宜的变更探测：只看**目录**的 mtime（年月两层，几个而已），不碰文件 */
function dirSig(root) {
  const parts = []
  const walk = (d, dep) => {
    let list = []
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      if (!e.isDirectory()) continue
      const p = join(d, e.name)
      try { parts.push(e.name + ':' + statSync(p).mtimeMs) } catch { /* 忽略 */ }
      if (dep < 3) walk(p, dep + 1)
    }
  }
  walk(join(root, 'entries'), 0)
  try { parts.push('md:' + statSync(join(root, 'INDEX.md')).mtimeMs) } catch { parts.push('md:0') }
  return parts.sort().join('|')
}

export function invalidateCache(root) { ENTRY_CACHE.delete(root) }

/** 写完一条后把缓存就地更新（避免下一次搜索又全量重扫） */
function cacheUpsert(root, entry) {
  const c = ENTRY_CACHE.get(root)
  if (!c) return
  const rest = c.entries.filter((e) => e.meta.id !== entry.meta.id)
  rest.push(entry)
  rest.sort((a, b) => String(b.meta.added || b.meta.date || '').localeCompare(String(a.meta.added || a.meta.date || '')))
  c.entries = rest
  c.at = Date.now()
  c.sig = dirSig(root)
}

/** 真正的全量扫描（缓存未命中时才走这里） */
function scanEntries(root) {
  const out = []
  const base = join(root, 'entries')
  if (!existsSync(base)) return out
  const walk = (dir) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else if (n.endsWith('.md')) {
        try { out.push(readEntry(root, p)) } catch { /* 坏文件跳过，别让它把整次列表带崩 */ }
      }
    }
  }
  walk(base)
  out.sort((a, b) => String(b.meta.added || b.meta.date || '').localeCompare(String(a.meta.added || a.meta.date || '')))
  return out
}

/**
 * 扫全部条目（按 added 倒序）。
 * @param {string} root
 * @param {{force?: boolean}} [opt] force=true 强制重扫（kb_index / 排查时用）
 */
export function listEntries(root, opt = {}) {
  const now = Date.now()
  const c = ENTRY_CACHE.get(root)
  if (!opt.force && c && now - c.at < CACHE_TTL_MS && c.sig === dirSig(root)) return c.entries
  const entries = scanEntries(root)
  ENTRY_CACHE.set(root, { sig: dirSig(root), at: now, entries })
  return entries
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(/[,，、;；\s]+/)
  const seen = new Set()
  const out = []
  for (const t of arr) {
    const s = String(t).trim().replace(/^#/, '')
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s.slice(0, 24))
    if (out.length >= 12) break
  }
  return out
}

const asList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v || '').split(/\r?\n/).map((x) => x.replace(/^\s*[-*·]\s*/, '').trim()).filter(Boolean)
}

/**
 * 把正文按 `## 小节` 切开 —— 用来做「合并式更新」：
 * 同一个 BV 第二次归档时，**没给的字段保留原值**，给了才覆盖。
 * 没有这条，一次只写 summary 的补录就会把上次辛苦读出来的要点冲掉。
 */
function sectionsOf(body) {
  const out = {}
  for (const part of String(body || '').split(/\n(?=##\s)/)) {
    const m = /^##\s+([^\n]+)\n([\s\S]*)$/.exec(part)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

const quoteStrip = (s) => String(s || '').split(/\r?\n/).map((l) => l.replace(/^>\s?/, '')).join('\n').trim()

/**
 * 新增 / 更新一篇。返回 {ok, action, meta, path}
 * 判重键：有 bvid 用 bvid，没有用 date+标题 slug。
 */
export function writeEntry(root, input) {
  ensureRoot(root)
  const now = new Date()
  const title = String(input.title || '').trim()
  if (!title) throw new Error('kb_add 至少要给 title')

  const bvid = String(input.bvid || '').trim() || (/(BV[0-9A-Za-z]{8,})/.exec(String(input.url || ''))?.[1] ?? '')
  const urlIn = String(input.url || '').trim()
  // 入口类型：video / web / file / rss / note（决定 source 默认值，也方便以后按来源筛）
  const via = input.via || (bvid ? 'video' : 'note')

  // ⭐ 判重的第一顺位是 BV 号，不是"算出来的路径"：视频日期和归档日期可以不一样，
  //    按路径判重会在日期漂移时冒出第二条（同一个视频两次入库）。
  //    非视频条目（网页 / RSS / 文件）没有 BV 号，就按 **url 判重**：
  //    同一个链接再抓一次是"更新"，不会多出一条。
  let existing = null
  if (bvid) { try { existing = findEntry(root, { bvid }) } catch { existing = null } }
  if (!existing && urlIn) {
    try { existing = listEntries(root).find((e) => String(e.meta.url || '') === urlIn) || null } catch { existing = null }
  }
  // 没有 BV 号、也没有 url（本地文件 / 随手记）⇒ 按「日期 + 标题」算出的 id 判重：
  // 不然同一个文件再导一次会被当成新条目（虽然落在同一路径，但 action 会报错、added 也会重置）
  const dateIn = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : ''
  const probeId = entryId({ date: dateIn || dayKey(now), bvid, title })
  if (!existing) { try { existing = findEntry(root, { id: probeId }) } catch { existing = null } }

  const date = dateIn || existing?.meta.date || dayKey(now)
  const id = existing?.meta.id || probeId
  const loc = existing ? { rel: existing.meta.rel, abs: existing.meta.path } : entryPath(root, { id })

  // ── 合并式更新：给才覆盖，没给保留 ──
  const olds = existing ? sectionsOf(existing.body) : {}
  const oldPoints = asList(olds['要点'] || '')
  const oldTags = existing?.meta.tags || []
  const pick = (val, fallback) => (val === undefined || val === null || String(val).trim() === '' ? fallback : String(val).trim())

  const kind = KINDS.includes(input.kind) ? input.kind : (existing?.meta.kind || '知识')
  const tier = TIERS.includes(input.tier) ? input.tier : (existing?.meta.tier || '')
  const status = STATUSES.includes(input.status) ? input.status : (existing?.meta.status || '待看')
  const summary = pick(input.summary, olds['一句话'] || '')
  const givenPoints = asList(input.points)
  const points = givenPoints.length ? givenPoints : oldPoints
  const excerpt = pick(input.excerpt, quoteStrip(olds['原文摘录'] || ''))
  const notes = pick(input.notes, olds['备注'] || '')
  const tags = normalizeTags([...oldTags, ...normalizeTags(input.tags)])
  const up = pick(input.up, existing?.meta.up || '')
  // 2026-10-30（合并三条鱼 · P2）：来源渠道 —— 区分"这话在哪说的"，写库前过滤隐私用
  const origin = pick(input.origin, existing?.meta.origin || '')
  const url = pick(input.url, existing?.meta.url || '') || (bvid ? `https://www.bilibili.com/video/${bvid}` : '')

  const action = existing ? '更新' : '新增'
  const added = existing?.meta.added || localIso(now)

  const meta = {
    id, bvid, title, up, url, date,
    added, updated: localIso(now),
    source: String(input.source || (via === 'video' ? 'bili-scroll' : via)),
    via,
    origin,
    kind, tier, status, tags,
  }

  const body = []
  if (summary) body.push('## 一句话', '', summary, '')
  if (points.length) body.push('## 要点', '', ...points.map((p) => `- ${p}`), '')
  if (excerpt) body.push('## 原文摘录', '', ...excerpt.split(/\r?\n/).map((l) => `> ${l}`), '')
  if (notes) body.push('## 备注', '', notes, '')

  const text = '---\n'
    + Object.entries(meta).map(([k, v]) => yamlValue(k, v)).join('\n')
    + '\n---\n\n'
    + `# ${title}\n\n`
    + body.join('\n')
  mkdirSync(join(loc.abs, '..'), { recursive: true })
  const finalText = text.replace(/\n{3,}/g, '\n\n')
  writeFileSync(loc.abs, finalText, 'utf8')

  // ⭐ 增量维护：把这条塞进 index.jsonl + 内存缓存。
  //    别为了"索引新"就 rebuildIndex() 重写全库 —— 3000 条时那是 180ms/次（2026-10-28 实测）。
  const entryObj = {
    meta: { ...meta, path: loc.abs, rel: loc.rel, bytes: Buffer.byteLength(finalText, 'utf8') },
    body: text.slice(text.indexOf('\n---\n') + 5).replace(/^#\s.*\n+/, ''),
    text: finalText,
  }
  try { indexUpsert(root, entryObj.meta, !existing) } catch { /* 索引写坏了不影响正文 */ }
  cacheUpsert(root, entryObj)

  return { ok: true, action, id, path: loc.abs, rel: loc.rel, title, via, meta }
}

/** 把一行 upsert 进 index.jsonl（只解析 JSON 行，不碰 md 文件）
 *  appendOnly：新增条目直接追加（O(1)）；更新才重写整份（少见） */
function indexUpsert(root, meta, appendOnly = false) {
  const file = join(root, 'index.jsonl')
  const row = {
    id: meta.id, bvid: meta.bvid || '', title: meta.title || '', up: meta.up || '',
    url: meta.url || '', date: meta.date || '', added: meta.added || '',
    kind: meta.kind || '', tier: meta.tier || '', status: meta.status || '',
    origin: meta.origin || '',
    tags: meta.tags || [], path: meta.rel || '',
  }
  const json = JSON.stringify(row)
  if (appendOnly) {
    appendFileSync(file, json + '\n', 'utf8')
    return
  }
  let lines = []
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { lines = [] }
  const idx = lines.findIndex((l) => { try { return JSON.parse(l).id === row.id } catch { return false } })
  if (idx >= 0) lines[idx] = json
  else lines.push(json)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
}

/**
 * 写完一条之后该不该重写 INDEX.md？
 * 它是**给人看的索引**，没必要每条都重排：一分钟内最多刷一次。
 */
export function afterWriteIndex(root) {
  let age = Infinity
  try { age = Date.now() - statSync(join(root, 'INDEX.md')).mtimeMs } catch { age = Infinity }
  if (age > 60_000) {
    try { rebuildIndex(root) } catch { /* 重写失败不影响正文 */ }
    return { refreshed: true }
  }
  return { refreshed: false }
}

/* ─────────────── 搜索 ─────────────── */

function scoreEntry(entry, terms) {
  if (!terms.length) return 1
  const title = String(entry.meta.title || '').toLowerCase()
  const up = String(entry.meta.up || '').toLowerCase()
  const tags = (entry.meta.tags || []).join(' ').toLowerCase()
  const summary = String((/## 一句话\s*\n+([^\n#]+)/.exec(entry.body) || [])[1] || '').toLowerCase()
  const all = (title + '\n' + up + '\n' + tags + '\n' + entry.body).toLowerCase()
  let score = 0
  for (const t of terms) {
    if (!all.includes(t)) return 0          // 每个词都得出现（AND），避免搜"插件"回来八十条
    if (title.includes(t)) score += 5
    if (tags.includes(t)) score += 3
    if (up.includes(t)) score += 2
    if (summary.includes(t)) score += 2
    score += 1
  }
  return score
}

function snippet(entry, terms, width = 110) {
  const text = entry.body.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim()
  if (!terms.length) return text.slice(0, width)
  const low = text.toLowerCase()
  for (const t of terms) {
    const i = low.indexOf(t)
    if (i >= 0) {
      const from = Math.max(0, i - 30)
      return (from > 0 ? '…' : '') + text.slice(from, from + width) + (from + width < text.length ? '…' : '')
    }
  }
  return text.slice(0, width)
}

export function searchEntries(root, { query = '', tags = [], kind = '', tier = '', status = '', limit = 8 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
  const wantTags = normalizeTags(tags).map((t) => t.toLowerCase())
  const hits = []
  for (const e of listEntries(root)) {
    if (kind && e.meta.kind !== kind) continue
    if (tier && e.meta.tier !== tier) continue
    if (status && e.meta.status !== status) continue
    if (wantTags.length) {
      const have = (e.meta.tags || []).map((t) => t.toLowerCase())
      if (!wantTags.every((t) => have.includes(t))) continue
    }
    const score = scoreEntry(e, terms)
    if (!score) continue
    hits.push({ score, e })
  }
  hits.sort((a, b) => b.score - a.score || String(b.e.meta.added || '').localeCompare(String(a.e.meta.added || '')))
  const n = Math.max(1, Math.min(Number(limit) || 8, 50))
  return {
    total: hits.length,
    items: hits.slice(0, n).map(({ score, e }) => ({
      id: e.meta.id, title: e.meta.title, up: e.meta.up, url: e.meta.url,
      date: e.meta.date, kind: e.meta.kind, tier: e.meta.tier, status: e.meta.status,
      tags: e.meta.tags || [], path: e.rel, score,
      snippet: snippet(e, terms),
    })),
  }
}

/* ─────────────── 相关推荐（2026-10-28 加） ───────────────
 * 为什么要它：知识库越收越多，但"收进去"不等于"想得起来"。
 * 每轮刷完归档时，拿这条视频的标题/要点/标签去库里比一比，把同主题的旧笔记翻出来
 * （例：这轮讲 KVCache，就把三个月前那条推理优化再浮上来一次）。
 *
 * 为什么不引向量模型：这个库是纯文件的、可能上千条，不想为了"找相关"引依赖或联网；
 * 中文用「二字组」+ 英文/型号词，标签加权，已经够把同主题的捞出来，还快得没有延迟。
 */

/** 高频虚词二字组，留着只会让所有条目互相"相似" */
const STOP_BIGRAMS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '很', '有', '这', '那',
  '一个', '这个', '那个', '什么', '怎么', '如何', '视频', '教程', '合集', '分享',
  '我们', '你们', '他们', '可以', '没有', '不是', '就是', '还是', '但是', '然后',
  '因为', '所以', '如果', '上面', '下面', '里面', '东西', '时候', '现在', '今天',
])

function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const latin = [...new Set(s.match(/[a-z][a-z0-9+#._-]{1,}/g) || [])]
  const runs = s.replace(/[^\u4e00-\u9fa5]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const bigrams = new Set()
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2)
      if (!STOP_BIGRAMS.has(bg)) bigrams.add(bg)
    }
  }
  return { latin, bigrams }
}

/**
 * 找相关旧条目。
 * @param {object} o
 * @param {string} o.text   这条视频的标题/摘要/要点（自由文本）
 * @param {string|string[]} o.tags 打算给这条的标签 —— 匹配最准的信号
 * @param {string} o.exclude 排除这个 BV 号 / id（通常就是正在归档的这条）
 * @param {number} o.limit
 * @param {number} o.minScore
 */
export function relatedEntries(root, { text = '', tags = [], exclude = '', limit = 3, minScore = 3 } = {}) {
  const qTags = new Set(normalizeTags(tags).map((t) => t.toLowerCase()))
  const q = tokenize([text, [...qTags].join(' ')].join(' '))
  const ex = String(exclude || '').trim().toLowerCase()
  const hits = []

  for (const e of listEntries(root)) {
    if (ex) {
      const key = `${e.meta.bvid || ''} ${e.meta.id || ''}`.toLowerCase()
      if (key.includes(ex)) continue                    // 自己跟自己不算相关
    }
    const eTags = new Set((e.meta.tags || []).map((t) => t.toLowerCase()))
    const sharedTags = [...eTags].filter((t) => qTags.has(t))

    // 旧条目的可比文本：标题 + UP + 标签 + 正文（正文让"讲了同一件事"也能被认出来）
    const et = tokenize([e.meta.title, e.meta.up, (e.meta.tags || []).join(' '), e.body].join(' '))
    const sharedLatin = q.latin.filter((w) => et.latin.includes(w))
    let sharedBigrams = 0
    for (const b of q.bigrams) if (et.bigrams.has(b)) sharedBigrams++
    const ratio = q.bigrams.size ? sharedBigrams / q.bigrams.size : 0

    let score = 0
    const why = []
    if (sharedTags.length) { score += 5 * Math.min(sharedTags.length, 3); why.push(`同标签 ${sharedTags.slice(0, 3).join('/')}`) }
    if (sharedLatin.length) { score += 3 * Math.min(sharedLatin.length, 3); why.push(`同词 ${sharedLatin.slice(0, 3).join('/')}`) }
    if (ratio > 0) {
      score += Math.round(6 * ratio)
      if (ratio >= 0.2) why.push(`文字相近 ${Math.round(ratio * 100)}%`)
    }
    if (score < minScore) continue

    hits.push({
      id: e.meta.id, title: e.meta.title, up: e.meta.up, url: e.meta.url, date: e.meta.date,
      kind: e.meta.kind, tier: e.meta.tier, tags: e.meta.tags || [], path: e.rel,
      score, why: why.join('；') || '关键词相近',
      shared: { tags: sharedTags, words: sharedLatin, ratio: Number(ratio.toFixed(2)) },
    })
  }

  hits.sort((a, b) => b.score - a.score || String(b.date || '').localeCompare(String(a.date || '')))
  const n = Math.max(1, Math.min(Number(limit) || 3, 10))
  return { total: hits.length, items: hits.slice(0, n) }
}

/* ─────────────── 索引 / 统计 ─────────────── */

export function rebuildIndex(root) {
  ensureRoot(root)
  const entries = listEntries(root, { force: true })   // 重建就是要看全量，别用缓存
  const rows = entries.map((e) => ({
    id: e.meta.id, bvid: e.meta.bvid || '', title: e.meta.title || '', up: e.meta.up || '',
    url: e.meta.url || '', date: e.meta.date || '', added: e.meta.added || '',
    kind: e.meta.kind || '', tier: e.meta.tier || '', status: e.meta.status || '',
    tags: e.meta.tags || [], path: e.rel,
  }))

  writeFileSync(join(root, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')

  const byMonth = new Map()
  for (const r of rows) {
    const m = String(r.date || r.added || '').slice(0, 7) || '未知'
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m).push(r)
  }
  const md = ['# 大肥鱼知识库 · 索引', '',
    `> 自动生成，别手改 —— 重建：\`kb_index\` 工具，或 \`node lib/kb-cli.mjs index\`。`,
    `> 共 **${rows.length}** 条 · 最近更新 ${localIso()}`, '']
  for (const month of [...byMonth.keys()].sort().reverse()) {
    md.push(`## ${month}`, '', '| 日期 | 标题 | UP | 标签 | 档位 | 状态 |', '| --- | --- | --- | --- | --- | --- |')
    for (const r of byMonth.get(month)) {
      const title = String(r.title).replace(/\|/g, '\\|')
      const link = r.url ? `[${title}](${r.url})` : title
      md.push(`| ${r.date} | ${link} | ${r.up || '-'} | ${(r.tags || []).join('·') || '-'} | ${r.tier || '-'} | ${r.status || '-'} |`)
    }
    md.push('')
  }
  writeFileSync(join(root, 'INDEX.md'), md.join('\n'), 'utf8')

  const tagCount = new Map()
  for (const r of rows) for (const t of r.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1)
  const meta = {
    root, entries: rows.length,
    byKind: rows.reduce((a, r) => ((a[r.kind || '未知'] = (a[r.kind || '未知'] || 0) + 1), a), {}),
    byTier: rows.reduce((a, r) => ((a[r.tier || '未分档'] = (a[r.tier || '未分档'] || 0) + 1), a), {}),
    topTags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, n]) => ({ tag: t, n })),
    rebuiltAt: localIso(),
  }
  writeFileSync(join(root, '.kb/meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

export function stats(root) {
  ensureRoot(root)
  const entries = listEntries(root)
  const tagCount = new Map()
  for (const e of entries) for (const t of e.meta.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1)
  return {
    root,
    entries: entries.length,
    latest: entries.slice(0, 5).map((e) => ({ id: e.meta.id, title: e.meta.title, date: e.meta.date, kind: e.meta.kind })),
    byKind: entries.reduce((a, e) => ((a[e.meta.kind || '未知'] = (a[e.meta.kind || '未知'] || 0) + 1), a), {}),
    byTier: entries.reduce((a, e) => ((a[e.meta.tier || '未分档'] = (a[e.meta.tier || '未分档'] || 0) + 1), a), {}),
    topTags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, n]) => ({ tag, n })),
    indexPath: join(root, 'INDEX.md'),
  }
}

/** 按 id / bvid / 路径找一篇 */
export function findEntry(root, { id = '', bvid = '', path = '' } = {}) {
  if (path) {
    const abs = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') ? path : join(root, path)
    if (existsSync(abs)) return readEntry(root, abs)
    throw new Error(`没有这个文件：${abs}`)
  }
  const want = String(bvid || '').trim()
  const wantId = String(id || '').trim()
  for (const e of listEntries(root)) {
    if (want && e.meta.bvid === want) return e
    if (wantId && e.meta.id === wantId) return e
  }
  throw new Error(`知识库里没有：${want || wantId}`)
}

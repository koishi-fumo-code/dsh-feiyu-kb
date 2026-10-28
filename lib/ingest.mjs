/**
 * lib/ingest.mjs —— 知识库的**其它进料通道**（2026-10-28 加）
 * ============================================================================
 * 起因：之前知识只有一个来源 —— 刷B站插件每轮归档。插件一停、B站一断，知识库就"饿死"了。
 * 这里补上不依赖任何插件的路子：
 *   · 网页       ingestUrl   → 抓正文、抽标题、猜要点
 *   · 本地文件   ingestFile  → .md / .txt / .json / 代码都能塞
 *   · 整个目录   ingestDir   → 批量导入（一篇一个条目）
 *   · RSS / Atom ingestFeed  → 订阅源批量收进 inbox
 *   · 随手一段   capture     → 聊天里看到的、书上抄的，直接存
 *
 * 设计约束：**零依赖**（不引 cheerio / htmlparser），纯正则 + 手写实体表；
 * 抓取有 SSRF 防护（只 http/https、不许内网）、体积上限、超时。
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { writeEntry, afterWriteIndex, listEntries } from './kb.mjs'

/* ─────────────── 抓网页 ─────────────── */

const MAX_BYTES = 5 * 1024 * 1024
const UA = 'Mozilla/5.0 (compatible; dsh-feiyu-kb/0.2; +https://github.com/koishi-fumo-code/dsh-feiyu-kb)'

const PRIVATE_HOST = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, /^\[?fe80:/i, /\.local$/i,
]

/** 只允许抓公网 http(s) —— 别让模型被一句话骗去读内网/本机 */
export function assertSafeUrl(raw) {
  let u
  try { u = new URL(String(raw).trim()) } catch { throw new Error(`不是合法 URL：${raw}`) }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http / https')
  const h = u.hostname.toLowerCase()
  if (PRIVATE_HOST.some((re) => re.test(h))) throw new Error(`不抓内网 / 本机地址：${h}`)
  return u
}

function decodeByCharset(buf, contentType = '') {
  const m = /charset=([\w-]+)/i.exec(contentType)
  const cs = (m?.[1] || 'utf-8').toLowerCase()
  try { return new TextDecoder(cs).decode(buf) } catch { return new TextDecoder('utf-8').decode(buf) }
}

/** 流式读，超过上限就停（别把 500MB 的页面读进内存） */
async function readCapped(res, max = MAX_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > max) { chunks.push(chunk.subarray(0, chunk.length - (total - max))); break }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 抓一个网页，返回 { url, finalUrl, title, text, contentType } */
export async function fetchPage(url, { timeout = 20000 } = {}) {
  const u = assertSafeUrl(url)
  const res = await fetch(u.href, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
  })
  const ct = res.headers.get('content-type') || ''
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status} ${res.statusText}`)
  if (!/text\/|application\/(xhtml|xml|json)/i.test(ct)) throw new Error(`不支持的内容类型：${ct || '(空)'}`)
  const buf = await readCapped(res)
  const raw = decodeByCharset(buf, ct)
  const isHtml = /html|xhtml/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw)
  if (!isHtml) return { url: u.href, finalUrl: res.url || u.href, title: '', text: raw.trim(), contentType: ct }
  return {
    url: u.href,
    finalUrl: res.url || u.href,
    title: extractTitle(raw),
    text: htmlToText(raw),
    contentType: ct,
  }
}

/* ─────────────── HTML → 纯文本 ─────────────── */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', copy: '©',
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

const safeChar = (n) => {
  try { return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '' } catch { return '' }
}

export function htmlToText(html) {
  let s = String(html ?? '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  s = s.replace(/<\/?(p|div|section|article|header|footer|main|aside|blockquote|pre|tr|table|ul|ol)\b[^>]*>/gi, '\n')
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${htmlToText(inner).trim()}\n\n`)
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

export function extractTitle(html) {
  const s = String(html ?? '')
  const pick = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]
  for (const re of pick) {
    const m = re.exec(s)
    if (m?.[1]) {
      const t = htmlToText(m[1]).replace(/\s+/g, ' ').trim()
      if (t) return t
    }
  }
  return ''
}

/* ─────────────── 从正文里"猜"要点 ─────────────── */

/**
 * 不是摘要模型，只是**如实摘**：优先标题行 / 列表项，其次句子。
 * 宁可少写，也不编 —— 抓不到就返回空数组，让调用方只留一句话。
 */
/**
 * 把正文切成"像段落"的块 —— 用来跳掉导航 / 分隔线 / 目录这些噪音。
 * 实测（2026-10-28，抓 Lilian Weng 的博客）：不过滤的话「一句话」会变成
 * 「页面标题 | 站点 - - - - Lil'Log - | Posts - Archive - Search」这种串。
 */
export function paragraphs(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => {
      if (p.length < 60) return false                       // 短行多半是导航 / 链接
      // ⚠️ 别用「连续 20 个字母」判段 —— 英文段落是带空格的，那样永远匹配不上
      const letters = (p.match(/[\u4e00-\u9fa5a-zA-Z]/g) || []).length
      if (letters < 40) return false
      if (/^[\s\-–—|·•*_=+#\d.]+$/.test(p)) return false       // 分隔线
      if ((p.match(/\|/g) || []).length > 4) return false      // 菜单栏
      if (isMetaLine(p)) return false                          // 日期 / 作者 / 阅读时长这类元信息
      return true
    })
}

/** "Date: … | Estimated Reading Time: 31 min | Author: …" 这种不是正文 */
function isMetaLine(p) {
  return /^(date|published|posted|author|updated|created)\s*[:：]/i.test(p)
    || /(estimated reading time|reading time|min read|作者\s*[:：]|发布时间|更新于|字数\s*[:：])/i.test(p)
}

/** 去掉标题里的锚点尾巴（"Agent System Overview #" → "Agent System Overview"） */
function cleanHeading(s) {
  return String(s ?? '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/[\s\u00b6#¶]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 不像正文的"小标题"（导航 / 目录 / 只有符号） */
function isNoiseHeading(h) {
  if (h.length < 3 || h.length > 60) return true   // 中文三个字的小标题是常见的（"要点一"）
  if (!/[\u4e00-\u9fa5a-zA-Z]{2,}/.test(h)) return true
  return /^(posts?|archive|search|tags?|faq|home|menu|导航|目录|归档|搜索|标签|首页|订阅|评论)$/i.test(h)
}

/**
 * 不是摘要模型，只是**如实摘**：优先小标题 / 列表项，其次句子。
 * 宁可少写，也不编 —— 抓不到就返回空数组，让调用方只留一句话。
 */
export function guessPoints(text, max = 6) {
  const raw = String(text ?? '')
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const out = []
  const push = (s, minLen = 12) => {
    const v = String(s ?? '')
      .replace(/^[-*·•]\s*/, '')
      .replace(/[\s\u00b6#¶]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (v.length < minLen || v.length > 160) return
    if (out.some((x) => x === v || x.includes(v) || v.includes(x))) return
    out.push(v)
  }

  // ① 小标题（跳过导航、锚点尾巴；小标题允许短，3 个字就行）
  for (const l of lines) {
    if (!/^#{1,4}\s+\S/.test(l)) continue
    const h = cleanHeading(l)
    if (!isNoiseHeading(h)) push(h, 3)
    if (out.length >= max) return out.slice(0, max)
  }
  // ② 列表项
  for (const l of lines) {
    if (!/^[-*·•]\s+\S/.test(l)) continue
    push(l)
    if (out.length >= max) return out.slice(0, max)
  }
  // ③ 正文句子（只在真段落里找，别再吃导航）
  const prose = paragraphs(raw).join(' ')
  for (const s of prose.split(/(?<=[。！？.!?])\s*/)) {
    push(s)
    if (out.length >= max) break
  }
  return out.slice(0, max)
}

/** 取正文第一段的第一句当"一句话"（跳过导航块） */
export function firstSentence(text, max = 120) {
  const paras = paragraphs(text)
  const base = (paras[0] || String(text ?? '').replace(/\s+/g, ' ')).trim()
  const m = /^.{10,}?[。！？.!?]/.exec(base)
  const s = (m?.[0] || base).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/* ─────────────── RSS / Atom ─────────────── */

function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  if (!m) return ''
  return decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim()
}

function attr(block, name, attrName) {
  const m = new RegExp(`<${name}[^>]*\\b${attrName}=["']([^"']+)["'][^>]*/?>`, 'i').exec(block)
  return m?.[1] ? decodeEntities(m[1]) : ''
}

/** 解析 RSS 2.0 / Atom，返回 [{title, link, date, summary}] */
export function parseFeed(xml, limit = 10) {
  const s = String(xml ?? '')
  const blocks = [...s.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0])
  const entries = blocks.length ? blocks : [...s.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
  return entries.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50))).map((b) => {
    const title = htmlToText(tag(b, 'title')).replace(/\s+/g, ' ').trim()
    const link = tag(b, 'link') || attr(b, 'link', 'href')
    const date = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date')
    const summary = htmlToText(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'))
    return { title, link, date, summary }
  }).filter((x) => x.title || x.link)
}

/* ─────────────── 本地文件 / 目录 ─────────────── */

export const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.csv',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.ps1',
  '.html', '.htm', '.xml', '.sql', '.r', '.lua',
])

export function readTextFile(path, maxBytes = 512 * 1024) {
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`不是文件：${path}`)
  if (st.size > maxBytes) throw new Error(`文件太大（${Math.round(st.size / 1024)}KB > ${maxBytes / 1024}KB）：${path}`)
  const ext = extname(path).toLowerCase()
  let text = readFileSync(path, 'utf8')
  if (ext === '.html' || ext === '.htm') text = htmlToText(text)
  return { text, ext, size: st.size, name: basename(path) }
}

/** 从文件内容里挑标题：第一个 `# 标题` / front-matter title / 文件名 */
export function titleOfFile({ text, name }) {
  const h1 = /^#\s+(.+)$/m.exec(text)
  if (h1?.[1]) return h1[1].trim()
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fmTitle = fm && /^title:\s*"?(.+?)"?\s*$/m.exec(fm[1])
  if (fmTitle?.[1]) return fmTitle[1].trim()
  return basename(name).replace(/\.[^.]+$/, '')
}

export function listDir(dir, { ext, limit = 50 } = {}) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= limit) return
    for (const n of readdirSync(d)) {
      if (n.startsWith('.') || n === 'node_modules') continue
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (st.isFile()) {
        const e = extname(n).toLowerCase()
        if (ext ? e === ext : TEXT_EXTS.has(e)) out.push(p)
        if (out.length >= limit) return
      }
    }
  }
  walk(dir, 0)
  return out
}

/* ═══════════════ 高层：把外部东西变成条目 ═══════════════ */

const clip = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 网页 → 条目 */
export async function ingestUrl(root, { url, tags, kind = '知识', tier = '可以看', notes = '', summary = '', maxPoints = 6 }) {
  const page = await fetchPage(url)
  const text = page.text || ''
  const title = page.title || page.finalUrl || page.url
  // 页面标题本身常被当小标题抓进来（"LLM Powered Autonomous Agents"）—— 去掉它，别当要点
  const points = guessPoints(text, maxPoints).filter((p) => p.toLowerCase() !== String(title).toLowerCase())
  const r = writeEntry(root, {
    title,
    url: page.finalUrl || page.url,
    via: 'web',
    kind, tier, tags,
    summary: summary || firstSentence(text) || '（只抓到标题，正文没抽出来）',
    points: points.join('\n'),
    excerpt: clip(paragraphs(text).slice(0, 2).join('\n\n'), 600),
    notes: notes || `抓自 ${page.finalUrl || page.url}`,
  })
  return { ...r, chars: text.length, points: points.length }
}

/** 本地文件 → 条目 */
export function ingestFile(root, { path, tags, kind = '知识', tier = '可以看', notes = '', summary = '', maxPoints = 8 }) {
  const f = readTextFile(path)
  const title = titleOfFile(f)
  const points = guessPoints(f.text, maxPoints).filter((p) => p.toLowerCase() !== String(title).toLowerCase())
  const r = writeEntry(root, {
    title,
    url: '',
    via: 'file',
    kind, tier, tags,
    summary: summary || firstSentence(f.text) || `（${f.size} 字节）`,
    points: points.join('\n'),
    excerpt: clip(paragraphs(f.text).slice(0, 2).join('\n\n'), 600),
    notes: notes || `来自本地文件 ${f.name}`,
  })
  return { ...r, chars: f.text.length, points: points.length, file: f.name }
}

/** 目录 → 多条（一篇一个） */
export function ingestDir(root, { dir, ext = '', tags = '', kind = '知识', tier = '可以看', limit = 20 }) {
  const files = listDir(dir, { ext: ext || undefined, limit: Math.max(1, Math.min(Number(limit) || 20, 100)) })
  const ok = []
  const failed = []
  for (const p of files) {
    try { ok.push(ingestFile(root, { path: p, tags, kind, tier })) }
    catch (e) { failed.push({ file: basename(p), error: String(e?.message ?? e) }) }
  }
  if (ok.length) afterWriteIndex(root)
  const total = listEntries(root).length
  return { scanned: files.length, imported: ok.length, failed, entries: ok.map((r) => ({ id: r.id, title: r.title, action: r.action })), total }
}

/** RSS / Atom 订阅 → 每条一个（默认进"待看"） */
export async function ingestFeed(root, { url, limit = 10, tags = '', kind = '知识', tier = '可以看' }) {
  const page = await fetchPage(url)
  const raw = page.text && /<item\b|<entry\b/i.test(page.text) ? page.text : ''
  if (!raw) throw new Error('这个地址不像是 RSS / Atom（没找到 <item> 或 <entry>）')
  const items = parseFeed(raw, limit)
  const ok = []
  for (const it of items) {
    if (!it.title) continue
    try {
      const r = writeEntry(root, {
        title: it.title,
        url: it.link || '',
        via: 'rss',
        kind, tier, status: '待看',
        tags,
        summary: clip(it.summary, 200) || `订阅项：${it.title}`,
        notes: it.date ? `发布于 ${it.date}` : '',
      })
      ok.push({ id: r.id, title: r.title, action: r.action, url: it.link || '' })
    } catch { /* 单条失败不拖垮整批 */ }
  }
  if (ok.length) afterWriteIndex(root)
  const total = listEntries(root).length
  return { items: items.length, imported: ok.length, entries: ok, total }
}

/** 随手一段（聊天里看到的、书上抄的）→ 条目 */
export function capture(root, { title, text, tags = '', kind = '知识', tier = '可以看', notes = '', source = 'chat' }) {
  const body = String(text || '').trim()
  if (!body) throw new Error('capture 需要 text')
  const autoTitle = title || clip(firstSentence(body, 40).replace(/[。！？.!?]$/, ''), 40) || '随手记'
  const r = writeEntry(root, {
    title: autoTitle,
    url: '',
    via: 'note',
    source,
    kind, tier, tags,
    summary: firstSentence(body),
    points: guessPoints(body, 6).join('\n'),
    excerpt: clip(body, 600),
    notes,
  })
  return r
}

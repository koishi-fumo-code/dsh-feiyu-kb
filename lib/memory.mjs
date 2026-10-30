/**
 * lib/memory.mjs —— 鲸鲸的记忆库（和知识库是两本账）
 * ============================================================================
 * 为什么分开：
 *   · 知识库（lib/kb.mjs）= 「那期视频讲了什么」——查档案，按主题组织，别人看到也无所谓
 *   · 记忆库         = 「你上次跟我说过什么」——记人和事，按时间组织，偏私有
 * 两者不写对方目录，也不共用索引。
 *
 * 目录结构（默认 D:/dsh工作区/大肥鱼记忆）：
 *   memories/YYYY/MM/YYYY-MM-DD-HHmm-<标题>.md   提炼过的记忆（她主动写 / mem_add）
 *   chats/YYYY-MM-DD.md                          原始对话流水（通道自动写，不用她动手）
 *   INDEX.md                                     给人看的索引
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_MEMORY_ROOT = 'D:/dsh工作区/大肥鱼记忆'
export const MEMORY_KINDS = ['对话', '偏好', '约定', '事件', '人物']

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export function resolveMemoryRoot(v) {
  const s = String(v || '').trim()
  return s || DEFAULT_MEMORY_ROOT
}

export function ensureMemoryRoot(root) {
  mkdirSync(join(root, 'memories'), { recursive: true })
  mkdirSync(join(root, 'chats'), { recursive: true })
  return root
}

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
const yamlValue = (k, v) => {
  if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${esc(x)}"`).join(', ')}]`
  if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`
  return `${k}: "${esc(v)}"`
}

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!mm) continue
    const [, key, raw] = mm
    const val = raw.trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',')
        .map((s) => s.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"'))
        .filter(Boolean)
    } else {
      meta[key] = val.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  return { meta, body: text.slice(m[0].length) }
}

/** 文件名里不能有的字符去掉；中文保留（Windows 支持） */
const safeName = (s) => String(s || '')
  .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 24) || '记忆'

const normalizeTags = (v) => {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/)
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].slice(0, 8)
}

const memFile = (root, date, id) => join(root, 'memories', date.slice(0, 4), date.slice(5, 7), `${id}.md`)

/** 新增一条记忆。同一天同一分钟同一标题会加序号，不覆盖。 */
export function writeMemory(root, input = {}) {
  ensureMemoryRoot(root)
  const now = new Date()
  const text = String(input.text || '').trim()
  if (!text) throw new Error('mem_add 至少要给 text')
  const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '记忆'
  const title = String(input.title || '').trim() || firstLine.slice(0, 40)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : dayKey(now)
  const time = /^\d{2}:\d{2}$/.test(String(input.time || '')) ? input.time : clock(now)
  const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : '对话'
  const who = String(input.who || '').trim()
  const source = String(input.source || '').trim()
  const importance = Math.min(3, Math.max(1, Math.round(Number(input.importance) || 2)))
  const tags = normalizeTags(input.tags)

  const baseId = `${date}-${time.replace(':', '')}-${safeName(title)}`
  let id = baseId
  for (let n = 2; existsSync(memFile(root, date, id)); n++) id = `${baseId}-${n}`

  const meta = { id, date, time, kind, who, source, importance, tags }
  const body = `# ${title}\n\n${text}\n`
  const textOut = '---\n' + Object.entries(meta).map(([k, v]) => yamlValue(k, v)).join('\n') + '\n---\n\n' + body
  const abs = memFile(root, date, id)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, textOut, 'utf8')
  return { ok: true, id, path: abs, title, date, time }
}

function loadMemoryFile(abs) {
  const text = readFileSync(abs, 'utf8')
  const { meta, body } = parseFrontMatter(text)
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1] || ''
  return { meta: { ...meta, title: String(meta.title || h1 || meta.id || ''), path: abs }, body, text }
}

export function listMemories(root) {
  const out = []
  const walk = (d) => {
    let es = []
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) {
        try { out.push(loadMemoryFile(p)) } catch { /* 坏文件跳过 */ }
      }
    }
  }
  walk(join(root, 'memories'))
  return out.sort((a, b) => `${b.meta.date}${b.meta.time}`.localeCompare(`${a.meta.date}${a.meta.time}`))
}

/** 最近 n 条记忆的「一句话」——给对话注入用 */
export function recentMemories(root, n = 5) {
  return listMemories(root).slice(0, Math.max(0, n)).map((e) => ({
    id: e.meta.id, date: e.meta.date, time: e.meta.time, kind: e.meta.kind, who: e.meta.who,
    title: e.meta.title,
    line: e.body.replace(/^#.*$/m, '').trim().split(/\r?\n/).find((s) => s.trim()) || '',
  }))
}

/** AND 语义：所有词都要命中；标签全中加分；按匹配次数 + 时间排序 */
export function searchMemories(root, { query = '', tags = [], limit = 5 } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const tagList = normalizeTags(tags)
  const hits = []
  for (const e of listMemories(root)) {
    const etags = Array.isArray(e.meta.tags) ? e.meta.tags : []
    if (tagList.length && !tagList.every((t) => etags.includes(t))) continue
    const hay = `${e.meta.title} ${etags.join(' ')} ${e.meta.who || ''} ${e.body}`.toLowerCase()
    let score = 0
    let allHit = true
    for (const t of terms) {
      const n = hay.split(t).length - 1
      if (n === 0) { allHit = false; break }
      score += n
    }
    if (!allHit) continue
    score += tagList.filter((t) => etags.includes(t)).length * 6
    score += Number(e.meta.importance) || 0
    hits.push({ ...e, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit))
}

const chatFile = (root, date) => join(root, 'chats', `${date}.md`)

/** 追加一段对话流水（通道自动写，不经过模型） */
export function appendChat(root, { user, reply, who = '', source = '', at = Date.now(), date, time } = {}) {
  ensureMemoryRoot(root)
  const d = new Date(at)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : dayKey(d)
  const hm = /^\d{2}:\d{2}$/.test(String(time || '')) ? time : clock(d)
  const block = [
    `## ${hm}${who ? ' ' + who : ''}${source ? ' · ' + source : ''}`,
    String(user || '').trim(),
    '',
    reply ? `**鲸鲸**：${String(reply).trim()}` : '',
    '',
  ].join('\n')
  appendFileSync(chatFile(root, day), block, 'utf8')
  return { ok: true, file: chatFile(root, day) }
}

/** 搜原始对话流水（只看最近 N 天，避免翻全量） */
export function searchChats(root, { query = '', limit = 5, days = 14 } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const dir = join(root, 'chats')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, days)
  } catch { return [] }
  const hits = []
  for (const f of files) {
    let text = ''
    try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
    for (const block of text.split(/^## /m).slice(1)) {
      const lower = block.toLowerCase()
      if (terms.some((t) => !lower.includes(t))) continue
      const score = terms.reduce((n, t) => n + (lower.split(t).length - 1), 0)
      hits.push({ date: f.slice(0, 10), block: `## ${block}`.trim(), score })
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, Math.max(1, limit))
}

export function readMemory(root, id) {
  const target = String(id || '').trim()
  if (!target) return null
  const hit = listMemories(root).find((e) => e.meta.id === target)
  return hit || null
}

export function memoryStatus(root) {
  const mems = listMemories(root)
  let chatFiles = 0
  let chatBytes = 0
  try {
    for (const f of readdirSync(join(root, 'chats'))) {
      if (!f.endsWith('.md')) continue
      chatFiles++
      try { chatBytes += statSync(join(root, 'chats', f)).size } catch { /* ignore */ }
    }
  } catch { /* 还没有 chats 目录 */ }
  const byKind = {}
  for (const m of mems) byKind[m.meta.kind || '未知'] = (byKind[m.meta.kind || '未知'] || 0) + 1
  return {
    root,
    memories: mems.length,
    byKind,
    latest: mems[0] ? { id: mems[0].meta.id, date: mems[0].meta.date, title: mems[0].meta.title } : null,
    chatDays: chatFiles,
    chatBytes,
    exists: existsSync(root),
  }
}

/** 给人看的索引 */
export function rebuildMemoryIndex(root) {  ensureMemoryRoot(root)
  const mems = listMemories(root)
  const lines = ['# 鲸鲸的记忆库 · 索引', '', `> 共 ${mems.length} 条。按时间倒序；「对话流水」在 chats/ 下。`, '']
  let lastDate = ''
  for (const m of mems) {
    if (m.meta.date !== lastDate) { lines.push('', `## ${m.meta.date}`, ''); lastDate = m.meta.date }
    const tags = (m.meta.tags || []).map((t) => `\`${t}\``).join(' ')
    lines.push(`- **${m.meta.time || ''}** ${m.meta.title}${m.meta.kind ? ` · ${m.meta.kind}` : ''}${tags ? ' · ' + tags : ''}`)
  }
  const file = join(root, 'INDEX.md')
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return { ok: true, count: mems.length, file }
}

/**
 * 生成「最近的记忆」摘要（recent.md），给不经本插件生成提示的通道用。
 * 目前是 B站 唤醒提示：那个插件不在本包内，读不了存储层，所以走这个文件。
 */
export function writeDigest(root, n = 10) {
  ensureMemoryRoot(root)
  const items = recentMemories(root, n)
  const lines = ['# 最近的记忆（自动生成，别手改）', '']
  if (!items.length) lines.push('（还没有）')
  for (const m of items) {
    lines.push(`- ${m.date} ${m.title}${m.line ? '：' + String(m.line).slice(0, 80) : ''}`)
  }
  const file = join(root, 'recent.md')
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return { ok: true, file, count: items.length }
}

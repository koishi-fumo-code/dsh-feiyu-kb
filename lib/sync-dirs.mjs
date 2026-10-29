/**
 * lib/sync-dirs.mjs —— 从目录里"捞"知识（不依赖任何刷视频插件是否跑通）
 * ============================================================================
 * 为什么要有它：2026-10-29 复盘发现，「刷完自动归档」这条链一次都没跑通
 * （headless 轮次在模型路由那一步就失败了）。那知识就白刷了。
 *
 * 这一层是**兜底**：直接盯着插件写出来的目录（日记 / 单条笔记 / 报告），
 * 发现新的 .md 就收进知识库。它不管上游是哪个插件、跑没跑成功 ——
 * 只要文件落了盘，知识就留得下来。
 *
 * 去重：`$DSH_HOME/feiyu-kb.synced.json` 记「路径 → mtime:size」，
 * 变过才算新内容；已同步的文件再扫也不会重复入库。
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { writeEntry, rebuildIndex } from './kb.mjs'
import { readTextFile, titleOfFile, guessPoints, firstSentence } from './ingest.mjs'

export const DEFAULT_SYNC_DIRS = [join(homedir(), '.dsh', 'whale-work')]

const statePath = () => {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'feiyu-kb.synced.json')
}

function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return { files: {} } }
}
function writeState(s) {
  try { mkdirSync(dirname(statePath()), { recursive: true }); writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n', 'utf8') } catch { /* 记不住下次重复扫 */ }
}

const stampOf = (p) => { const st = statSync(p); return `${Math.round(st.mtimeMs)}:${st.size}` }

/** 扫一个目录里的 .md（跳过隐藏目录、node_modules、说明文件、我们自己知识库里的文件） */
const SKIP_NAMES = new Set(['agents.md', 'readme.md', 'changelog.md', 'contributing.md', 'license.md', 'index.md'])

function listMarkdown(dir, root, limit) {
  const out = []
  const kbRoot = String(root || '').replace(/\\/g, '/').toLowerCase()
  const walk = (d, dep) => {
    if (dep > 3 || out.length >= limit) return
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (e.isDirectory()) { walk(p, dep + 1); continue }
      if (!e.name.endsWith('.md')) continue
      // 说明类文件不是"知识产出"，别当笔记收（AGENTS.md 会被 DSH 注入，尤其不能收）
      if (SKIP_NAMES.has(e.name.toLowerCase())) continue
      // 别把自己知识库里的文件再捞回来（会无限套娃）
      if (kbRoot && String(p).replace(/\\/g, '/').toLowerCase().startsWith(kbRoot)) continue
      out.push(p)
      if (out.length >= limit) return
    }
  }
  walk(dir, 0)
  return out
}

/**
 * 同步一轮。
 * @param {object} o
 * @param {string} o.root 知识库根
 * @param {string[]} o.dirs 要扫的目录（支持 ~）
 * @param {string} [o.tags] 统一追加的标签
 * @param {number} [o.limit] 单次最多收几篇（默认 20）
 * @param {(m:string)=>void} [o.log]
 */
export function syncDirs({ root, dirs = [], tags = '', limit = 20, log = () => {} }) {
  const state = readState()
  const files = { ...(state.files || {}) }
  const imported = []
  const skipped = []
  let scanned = 0

  for (const raw of dirs) {
    const dir = String(raw || '').replace(/^~(?=$|[\\/])/, homedir())
    if (!dir || !existsSync(dir)) { skipped.push({ dir, why: '目录不存在' }); continue }
    for (const p of listMarkdown(dir, root, limit)) {
      scanned++
      if (imported.length + skipped.length > limit * 3) break
      let sig = ''
      try { sig = stampOf(p) } catch { continue }
      if (files[p] === sig) continue                     // 没变过
      try {
        const f = readTextFile(p, 1024 * 1024)
        const text = f.text
        // 太短的（空文件 / 只有标题）不值得收
        if (String(text).replace(/\s/g, '').length < 40) { files[p] = sig; continue }
        const title = titleOfFile(f)
        const points = guessPoints(text, 6).filter((x) => x.toLowerCase() !== String(title).toLowerCase())
        const r = writeEntry(root, {
          title,
          via: 'file',
          source: 'dir-sync',
          kind: '知识',
          tier: '可以看',
          tags,
          summary: firstSentence(text),
          points: points.join('\n'),
          excerpt: text.slice(0, 500),
          notes: `自动收录自 ${relative(dirname(dir), p) || p}`,
        })
        files[p] = sig
        imported.push({ id: r.id, title: r.title, action: r.action, from: p })
      } catch (e) {
        skipped.push({ file: p, why: String(e?.message ?? e) })
      }
    }
  }

  writeState({ files, updatedAt: new Date().toISOString() })
  if (imported.length) { try { rebuildIndex(root) } catch { /* 索引晚点再说 */ } }
  if (imported.length) log(`目录同步：收了 ${imported.length} 篇（扫了 ${scanned} 个文件）`)
  return { ok: true, scanned, imported, skipped, dirs }
}

/** 给设置页看的状态 */
export function syncStatus(dirs = []) {
  const s = readState()
  const files = s.files || {}
  return {
    files: Object.keys(files).length,
    updatedAt: s.updatedAt || '',
    dirs: dirs.map((d) => ({ dir: String(d), exists: existsSync(String(d).replace(/^~(?=$|[\\/])/, homedir())) })),
  }
}

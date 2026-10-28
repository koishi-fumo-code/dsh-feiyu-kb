#!/usr/bin/env node
/**
 * lib/kb-cli.mjs —— 知识库的命令行入口
 * ============================================================================
 * 给谁用：
 *   · **没有插件工具的运行时**（比如 headless 值班轮只挂了 B站 MCP）—— 一条 bash 就能归档；
 *   · 人自己（想批量补几条、想确认库长什么样）。
 *
 * 用法：
 *   node lib/kb-cli.mjs where
 *   node lib/kb-cli.mjs status
 *   node lib/kb-cli.mjs list [--limit 10]
 *   node lib/kb-cli.mjs search "DeepSeek 推理" [--tags 推理,KVCache] [--limit 5]
 *   node lib/kb-cli.mjs related --text "标题/要点" --tags 推理,KVCache [--exclude BV…] [--limit 3]
 *   node lib/kb-cli.mjs read --bvid BV1Mxn26eEh5 | --id <id> | --path entries/...
 *   node lib/kb-cli.mjs add --json '{"title":"…","bvid":"BV…","summary":"…","points":"a\\nb","tags":"x,y"}'
 *   node lib/kb-cli.mjs add --title "…" --bvid BV… --summary "…" --tags "a,b"
 *   node lib/kb-cli.mjs index
 *
 * 环境变量：FEIYU_KB_ROOT 覆盖库位置（默认 D:/dsh工作区/大肥鱼知识库）
 * ============================================================================
 */
import { DEFAULT_ROOT, resolveRoot, ensureRoot, writeEntry, afterWriteIndex, searchEntries, relatedEntries, findEntry, rebuildIndex, stats, listEntries } from './kb.mjs'
import { ingestUrl, ingestFile, ingestDir, ingestFeed, capture } from './ingest.mjs'

const argv = process.argv.slice(2)
const cmd = (argv.shift() || 'status').toLowerCase()

const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else { flags[key] = next; i++ }
  }
}

const root = resolveRoot(flags.root)

const out = (v) => { process.stdout.write(JSON.stringify(v, null, 2) + '\n') }
const fail = (msg) => { process.stderr.write(String(msg) + '\n'); process.exit(1) }

try {
  ensureRoot(root)
  if (cmd === 'where') out({ root })
  else if (cmd === 'status') out({ ok: true, ...stats(root) })
  else if (cmd === 'list') {
    out({ ok: true, root, items: searchEntries(root, { limit: Number(flags.limit) || 10 }).items })
  } else if (cmd === 'search') {
    const q = [flags.query, ...argv.filter((a) => !a.startsWith('--'))].filter(Boolean).join(' ')
    out({ ok: true, root, ...searchEntries(root, { query: q, tags: flags.tags || '', kind: flags.kind || '', limit: flags.limit }) })
  } else if (cmd === 'related') {
    const text = [flags.text, ...argv.filter((a) => !a.startsWith('--'))].filter(Boolean).join(' ')
    out({ ok: true, root, ...relatedEntries(root, { text, tags: flags.tags || '', exclude: flags.exclude || '', limit: flags.limit }) })
  } else if (cmd === 'read') {
    const e = findEntry(root, { id: flags.id, bvid: flags.bvid, path: flags.path })
    out({ ok: true, meta: e.meta, text: e.text })
  } else if (cmd === 'add') {
    let input = {}
    if (typeof flags.json === 'string') {
      try { input = JSON.parse(flags.json) } catch (e) { fail(`--json 不是合法 JSON：${e.message}`) }
    } else {
      input = {
        title: flags.title, bvid: flags.bvid, url: flags.url, up: flags.up, date: flags.date,
        kind: flags.kind, tier: flags.tier, status: flags.status, tags: flags.tags,
        summary: flags.summary, points: flags.points, excerpt: flags.excerpt, notes: flags.notes, source: flags.source,
      }
    }
    if (!input.title) fail('add 至少要 --title（或用 --json 给完整对象）')
    const r = writeEntry(root, input)
    afterWriteIndex(root)
    out({ ok: true, action: r.action, id: r.id, path: r.path, total: listEntries(root).length })
  } else if (cmd === 'index') {
    out({ ok: true, ...rebuildIndex(root), indexPath: `${root}/INDEX.md` })
  } else if (cmd === 'ingest') {
    const from = String(flags.from || '').toLowerCase()
    const common = {
      tags: flags.tags || '', kind: flags.kind || '知识', tier: flags.tier || '可以看',
      notes: flags.notes || '', summary: flags.summary || '',
    }
    if (from === 'url') out({ ok: true, ...(await ingestUrl(root, { url: flags.url, ...common })) })
    else if (from === 'file') out({ ok: true, ...ingestFile(root, { path: flags.path || flags.file, ...common }) })
    else if (from === 'dir') out({ ok: true, ...ingestDir(root, { dir: flags.dir, ext: flags.ext || '', limit: flags.limit, ...common }) })
    else if (from === 'feed') out({ ok: true, ...(await ingestFeed(root, { url: flags.url, limit: flags.limit, ...common })) })
    else fail('ingest 需要 --from url|file|dir|feed')
  } else if (cmd === 'capture') {
    const text = typeof flags.text === 'string' ? flags.text : argv.filter((a) => !a.startsWith('--')).join(' ')
    if (!text) fail('capture 需要 --text "..."')
    const r = capture(root, {
      text, title: flags.title, tags: flags.tags || '', kind: flags.kind || '知识',
      tier: flags.tier || '可以看', notes: flags.notes || '', source: flags.source || 'cli',
    })
    afterWriteIndex(root)
    out({ ok: true, action: r.action, id: r.id, path: r.path, total: listEntries(root).length })
  } else if (cmd === 'count') {
    out({ ok: true, root, entries: listEntries(root).length })
  } else {
    fail(`不认识的命令：${cmd}\n可用：where / status / list / search / read / add / ingest / capture / index / count`)
  }
} catch (e) {
  fail(String(e?.stack || e?.message || e))
}

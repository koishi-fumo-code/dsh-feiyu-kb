#!/usr/bin/env node
/**
 * scripts/bench.mjs —— 规模基准：知识库变大后各操作多慢
 * ============================================================================
 * 造 N 条假数据（直写文件，不计入计时），然后测单次操作的耗时。
 * 用法：node scripts/bench.mjs
 * ============================================================================
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { writeEntry, listEntries, searchEntries, relatedEntries, rebuildIndex, findEntry } from '../lib/kb.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TAGS = ['DeepSeek', '推理', 'KVCache', 'Harness', 'Agent', '前端', 'Rust', 'RAG', '向量', '量化']
const WORDS = ['推理框架', '缓存复用', '上下文工程', '工具调用', '提示词', '评测', '部署', '显存', '延迟', '吞吐']

function seed(root, n) {
  const dir = join(root, 'entries', '2026', '10')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    const t1 = TAGS[i % TAGS.length], t2 = TAGS[(i * 3 + 1) % TAGS.length], w = WORDS[i % WORDS.length]
    const bvid = `BVbench${String(i).padStart(6, '0')}`
    const id = `2026-10-28-${bvid}`
    writeFileSync(join(dir, `${id}.md`), `---
id: "${id}"
bvid: "${bvid}"
title: "第 ${i} 条：${w}的一点实践 ${t1}"
up: "UP${i % 50}"
url: ""
date: "2026-10-28"
added: "2026-10-28T12:00:00+08:00"
updated: "2026-10-28T12:00:00+08:00"
source: "bench"
via: "video"
kind: "知识"
tier: "可以看"
status: "待看"
tags: ["${t1}", "${t2}", "benchmarks"]
---

# 第 ${i} 条

## 一句话

这条讲的是 ${w}，涉及 ${t1} 和 ${t2} 的取舍，以及一次实测的结论。

## 要点

- ${w}的核心是把 ${t1} 拆成可测的小块
- 实测里 ${t2} 带来的收益约 ${i % 40}%
- 注意事项：${w} 在低显存下会退化
`, 'utf8')
  }
}

const time = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r] }

console.log(['条数', '首次扫描(ms)', '搜索(ms)', '相关(ms)', '按BV读(ms)', '写1条(ms)', '重建索引(ms)'].join('\t'))
for (const n of (process.argv.includes('--big') ? [1000, 3000, 10000] : [100, 500, 1000, 3000])) {
  const root = mkdtempSync(join(tmpdir(), `kbb-${n}-`))
  seed(root, n)

  const [scan] = time(() => listEntries(root, { force: true }))
  time(() => listEntries(root))                       // 预热缓存
  const [search] = time(() => searchEntries(root, { query: '推理 KVCache', limit: 8 }))
  const [related] = time(() => relatedEntries(root, { text: 'KVCache 量化 显存', tags: '推理,KVCache', limit: 3 }))
  const [read] = time(() => findEntry(root, { bvid: 'BVbench' + String(n - 1).padStart(6, '0') }))
  const [add] = time(() => writeEntry(root, {
    title: '新来的一条', bvid: 'BVnew' + n, tags: '推理,新', summary: '一句话', points: '要点一\n要点二',
  }))
  const [idx] = time(() => rebuildIndex(root))

  console.log([n, scan.toFixed(0), search.toFixed(1), related.toFixed(1), read.toFixed(1), add.toFixed(1), idx.toFixed(0)].join('\t'))
  rmSync(root, { recursive: true, force: true })
}

#!/usr/bin/env node
/**
 * scripts/selftest.mjs —— 不启动 DSH 也能把插件跑一遍
 * ============================================================================
 * 用一个假的 ctx（只提供 tools.register）调用 apply()，把 5 只工具挨个执行一遍，
 * 断言：注册齐全 / 写进去能搜到 / 同一个 BV 再写是「更新」而不是多一条 / 索引文件落盘。
 *
 * 用临时目录当 root，不碰真库。用法：node scripts/selftest.mjs
 * ============================================================================
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'feiyu-kb-test-'))
const mod = await import(pathToFileURL(resolve(here, '..', 'index.js')).href)

const tools = new Map()
const ctx = { tools: { register: (spec) => { tools.set(spec.name, spec); return spec } } }
mod.apply(ctx, { root })

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' → ' + JSON.stringify(extra).slice(0, 300) : ''}`) }
}

console.log(`root = ${root}\n`)

// ① 注册
const want = ['kb_status', 'kb_search', 'kb_read', 'kb_add', 'kb_index']
ok(want.every((n) => tools.has(n)), `5 只工具都注册了（${[...tools.keys()].join(', ')}）`)
ok(tools.get('kb_add').parameters.type === 'object'
  && tools.get('kb_add').parameters.additionalProperties === false, 'kb_add 的 parameters 是合法 JSONSchema')

// ② 新增
const add1 = await tools.get('kb_add').execute({
  title: '测试：DeepInfer 的 P/D 分离',
  bvid: 'BV1test000001',
  up: '测试UP',
  tags: '推理,KVCache,测试',
  summary: '把 Prefill/Decode 拆开部署，KV Cache 单独存 72 小时。',
  points: 'Prefill 和 Decode 分开跑\nKV Cache 有界重放\n消费级显卡跑不动',
  excerpt: '平均提示词 77K',
  tier: '值得看',
})
ok(add1.ok && add1.action === '新增', 'kb_add 新增一篇', add1)
ok(existsSync(add1.path), `${add1.rel || '条目'} 落盘了`)

// ③ 同 BV 再写 = 更新（判重）
const add2 = await tools.get('kb_add').execute({ title: '测试：DeepInfer（改名）', bvid: 'BV1test000001', summary: '改成了新的说明' })
ok(add2.ok && add2.action === '更新' && add2.id === add1.id, '同一个 BV 再写是「更新」不是新增', add2)
ok(add2.total === 1, '库里仍然只有 1 条', add2.total)

// ④ 搜索（多词 AND）
const s1 = await tools.get('kb_search').execute({ query: 'KV Cache' })
ok(s1.ok && s1.total === 1 && s1.items[0].tags.includes('KVCache'), 'kb_search 命中了（多词 AND + 标签）', s1)
const s2 = await tools.get('kb_search').execute({ query: '完全不存在的词' })
ok(s2.ok && s2.total === 0, '搜不到时不瞎凑', s2)
const s3 = await tools.get('kb_search').execute({})
ok(s3.ok && s3.items.length === 1, '不给 query = 列最近', s3)

// ⑤ 读全文
const r1 = await tools.get('kb_read').execute({ bvid: 'BV1test000001' })
ok(r1.ok && r1.text.includes('Prefill 和 Decode 分开跑'), 'kb_read 能按 BV 读到要点', { ok: r1.ok })
const r2 = await tools.get('kb_read').execute({ path: 'C:/windows/win.ini' })
ok(!r2.ok, 'kb_read 拒绝库外路径', r2)

// ⑥ 重建索引
const i1 = await tools.get('kb_index').execute({})
ok(i1.ok && i1.entries === 1, 'kb_index 重建成功', i1)
ok(existsSync(join(root, 'INDEX.md')) && readFileSync(join(root, 'INDEX.md'), 'utf8').includes('测试'), 'INDEX.md 写了')
ok(existsSync(join(root, 'index.jsonl')), 'index.jsonl 写了')

// ⑦ status
const st = await tools.get('kb_status').execute({})
ok(st.ok && st.entries === 1 && st.byKind['知识'] === 1, 'kb_status 统计对', st)

// ⑧ 相关推荐（同主题的旧条目该被翻出来；自己不该匹配自己）
const add3 = await tools.get('kb_add').execute({
  title: '测试：推理加速的另一条路（KV Cache 量化）',
  bvid: 'BV1test000002',
  tags: '推理,KVCache,量化',
  summary: '把 KV Cache 压成低精度，显存省一半。',
  points: 'KV Cache 量化\n显存省一半',
  tier: '可以看',
})
ok(add3.ok && add3.action === '新增', '第二篇（同主题）入库', add3)

const rel1 = await tools.get('kb_related').execute({ text: 'KV Cache 量化 推理加速', tags: '推理,KVCache', limit: 5 })
ok(rel1.ok && rel1.total >= 2, 'kb_related 能找到同主题旧条目', rel1)
ok(rel1.items.some((x) => x.id === add1.id), '相关里包含第一篇', rel1.items.map((x) => x.id))
ok(rel1.items.every((x) => x.why), '每条相关都给了理由（同标签/同词/文字相近）', rel1.items.map((x) => x.why))

const rel2 = await tools.get('kb_related').execute({ text: 'KV Cache 量化 推理加速', tags: '推理,KVCache', exclude: 'BV1test000001', limit: 5 })
ok(rel2.ok && !rel2.items.some((x) => x.id === add1.id), 'exclude 能把"自己"排除掉', rel2.items.map((x) => x.id))

const rel3 = await tools.get('kb_related').execute({ text: '完全无关的一句话 猫 吃饭', tags: '猫', limit: 5 })
ok(rel3.ok && rel3.total === 0, '不相关时不硬凑', rel3)

console.log(`\n${pass} 通过 / ${fail} 失败`)
rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)

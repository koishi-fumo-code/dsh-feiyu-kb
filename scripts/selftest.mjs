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
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'feiyu-kb-test-'))
// ⚠️ 必须在 apply 之前隔离 DSH_HOME：设置页的 config.root 优先级高于 apply 传入的 root，
//    不隔离的话自测会连上使用者真实的 feiyu-kb.config.json ⇒ 把测试条目写进真库（2026-10-28 踩过）
const oldDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, '.dsh-home')
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
const want = ['kb_status', 'kb_search', 'kb_read', 'kb_add', 'kb_related', 'kb_ingest', 'kb_capture', 'kb_index']
ok(want.every((n) => tools.has(n)), `8 只工具都注册了（${[...tools.keys()].join(', ')}）`)
ok(tools.get('kb_add').parameters.type === 'object'
  && tools.get('kb_add').parameters.additionalProperties === false, 'kb_add 的 parameters 是合法 JSONSchema')

// ①b 包清单自检：声明了 dsh.client 就必须导出 ./client
// ⚠️ 2026-10-28 事故：漏了这一行 ⇒ client-modules（必需插件）报
//    "declares dsh.client but exports no ./client bundle" ⇒ **整个 DSH 起不来**，
//    连崩三次后 profile 被重置成最小配置，使用者所有插件全没了。
const selfPkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
ok(!selfPkg?.dsh?.client || Boolean(selfPkg?.exports?.['./client']),
  '声明 dsh.client 就导出了 ./client（否则整机启动失败）', selfPkg?.exports)
ok(!selfPkg?.dsh?.client || existsSync(resolve(here, '..', 'client.js')), 'client.js 文件真实存在')

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

// ⑨ 其它进料通道（不依赖刷B站插件）
const ing = await import(pathToFileURL(resolve(here, '..', 'lib', 'ingest.mjs')).href)
ok(!ing.htmlToText('<script>坏代码()</script><p>正文在这里</p>').includes('坏代码'), 'htmlToText 会丢掉 script')
ok(ing.htmlToText('<h2>小标题</h2><p>一段正文</p>').includes('## 小标题'), 'htmlToText 保留标题层级')
ok(ing.extractTitle('<html><head><title>页面标题</title></head></html>') === '页面标题', 'extractTitle 取到 <title>')
ok(ing.guessPoints('## 要点一\n- 这是一条足够长的要点内容\n普通句子。', 3).length >= 2, 'guessPoints 会抽标题行和列表项')
const feed = ing.parseFeed('<rss><channel><item><title>文章A</title><link>https://example.com/a</link><description>摘要</description></item></channel></rss>')
ok(feed.length === 1 && feed[0].title === '文章A' && feed[0].link === 'https://example.com/a', 'parseFeed 解析 RSS', feed)
let ssrf = false
try { ing.assertSafeUrl('http://127.0.0.1/x') } catch { ssrf = true }
ok(ssrf, 'SSRF 防护：拒绝内网地址')

const tmplFile = join(root, '导入测试.md')
writeFileSync(tmplFile, '# 本地笔记标题\n\n## 要点\n- 这是文件里的一条要点，够长\n- 第二条要点也够长一点\n', 'utf8')
const f1 = await tools.get('kb_ingest').execute({ from: 'file', path: tmplFile, tags: '导入,测试', tier: '可以看' })
ok(f1.ok && f1.action === '新增' && f1.title === '本地笔记标题', 'kb_ingest from=file 导入了 md', f1)
ok(f1.via === 'file', '条目记了 via: file', f1.via)

const f2 = await tools.get('kb_ingest').execute({ from: 'file', path: tmplFile })
ok(f2.ok && f2.action === '更新', '同一个文件再导是「更新」', f2)

const cp = await tools.get('kb_capture').execute({ text: '随手记一条：KV Cache 量化能省一半显存，但精度会掉。', tags: '测试,随手记' })
ok(cp.ok && cp.action === '新增', 'kb_capture 随手记入库', cp)

const st2 = await tools.get('kb_status').execute({})
ok(st2.ok && st2.entries === 4, '库里现在 4 条（2 视频 + 1 文件 + 1 随手记）', st2.entries)

// ⑩ 设置项（config.mjs）：合并式保存 + 工具开关的默认值
// （DSH_HOME 已经在上面隔离到临时目录，不会碰真实配置）
const cfgMod = await import(pathToFileURL(resolve(here, '..', 'lib', 'config.mjs')).href)
const defaultCfg = cfgMod.loadConfig()
ok(typeof defaultCfg.tools.ingest === 'boolean' && typeof defaultCfg.tools.capture === 'boolean', '默认配置里两个工具开关都是布尔值', defaultCfg.tools)
const saved = cfgMod.saveConfig({ tools: { capture: false } })
ok(saved.tools.capture === false && saved.tools.ingest === defaultCfg.tools.ingest, '只改 capture，不动 ingest（合并式）', saved)
const back = cfgMod.loadConfig()
ok(back.tools.capture === false, '配置能读回来', back)
cfgMod.saveConfig({ root: root.replace(/\\/g, '/') })
ok(cfgMod.loadConfig().root.length > 0, 'root 也能存', cfgMod.loadConfig().root)

// ⑪ 目录同步：新的收、旧的不重复收、说明文件跳过
const syncMod = await import(pathToFileURL(resolve(here, '..', 'lib', 'sync-dirs.mjs')).href)
const srcDir = mkdtempSync(join(tmpdir(), 'feiyu-src-'))  // 必须在知识库根之外（根内的文件会被当成自己的文件跳过）
mkdirSync(srcDir, { recursive: true })
writeFileSync(join(srcDir, 'AGENTS.md'), '# 约定\n\n这份是说明文件，不该被当成笔记收进来。\n'.repeat(6), 'utf8')
writeFileSync(join(srcDir, 'note-1.md'), '# 上游笔记\n\n这条讲的是 KV Cache 量化：显存省一半、精度略降。\n\n- 优点：省显存\n- 代价：精度\n', 'utf8')
const sy1 = syncMod.syncDirs({ root, dirs: [srcDir] })
ok(sy1.imported.length === 1, '目录同步收进 1 篇', sy1.imported.length)
ok(!JSON.stringify(sy1.imported).includes('AGENTS'), 'AGENTS.md 被跳过', sy1.imported.map((x) => x.title))
const sy2 = syncMod.syncDirs({ root, dirs: [srcDir] })
ok(sy2.imported.length === 0, '再同步不重复收', sy2.imported.length)

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (oldDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = oldDshHome
rmSync(srcDir, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)

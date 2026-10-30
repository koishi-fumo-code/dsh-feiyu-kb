#!/usr/bin/env node
/**
 * verify-p3.mjs —— 验收「QQ → 鲸鲸大脑」这条通道。
 *
 * DSH 的 Web 端口每次重启都变（实测 60636 → 61416），所以这里自动发现：
 *   扫本机 LISTENING 端口 → 逐个探 /api/feiyu-kb/status → 认到就用。
 *
 * 用法：
 *   node verify-p3.mjs                                  # 自动发现端口，测 dsh-feiyu
 *   node verify-p3.mjs dsh-feiyu                        # 指定会话
 *   DSH_WEB=http://127.0.0.1:61416 node verify-p3.mjs   # 手动指定
 *
 * 退出码：0 = 通了；1 = 没通。
 */
import { execSync } from 'node:child_process'

const SESSION = process.argv[2] || 'dsh-feiyu'
const QUESTION = '你是谁呀'
const log = (...a) => console.log(...a)
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) log(`  [OK]   ${label}${extra ? ' — ' + extra : ''}`)
  else { failed++; log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`) }
}

const listeningPorts = () => {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 8000 })
    const ports = new Set()
    for (const line of out.split('\n')) {
      if (!/LISTENING/i.test(line)) continue
      const addr = line.trim().split(/\s+/)[1] || ''
      const m = /:(\d+)$/.exec(addr)
      if (!m) continue
      const host = addr.slice(0, addr.lastIndexOf(':'))
      if (!['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(host)) continue
      const p = Number(m[1])
      if (p > 0 && p < 65536) ports.add(p)
    }
    return [...ports]
  } catch { return [] }
}

const isDsh = async (base) => {
  try {
    const r = await fetch(base + '/api/feiyu-kb/status', { signal: AbortSignal.timeout(800) })
    if (r.status !== 200) return false
    const j = await r.json()
    return j?.ok === true
  } catch { return false }
}

const discover = async () => {
  const forced = (process.env.DSH_WEB || '').replace(/\/+$/, '')
  if (forced) return { base: forced, how: '来自 DSH_WEB' }
  const ports = listeningPorts()
  const results = await Promise.all(ports.map(async (p) => {
    const base = `http://127.0.0.1:${p}`
    return (await isDsh(base)) ? base : null
  }))
  const hit = results.find(Boolean)
  return hit ? { base: hit, how: `扫 ${ports.length} 个监听端口` } : { base: null, how: '没找到' }
}

log(`\n会话：${SESSION}`)
const { base, how } = await discover()
ok(Boolean(base), '找到 DSH 宿主', base ? `${base}（${how}）` : '扫了本机监听端口都没认出来')
if (!base) { log('\n→ 先确认 DSH 开着。'); process.exit(1) }

// ① 插件本体在线
try {
  const r = await fetch(base + '/api/feiyu-kb/status', { signal: AbortSignal.timeout(10_000) })
  const j = await r.json()
  ok(r.status === 200 && j?.ok === true, '插件本体在线', `entries=${j?.entries}`)
} catch (e) {
  ok(false, '插件本体在线', String(e?.message ?? e))
}

// ② 端点已加载（401 = 路由没挂上）
let res
try {
  res = await fetch(base + '/api/feiyu-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: QUESTION, sessionId: SESSION }),
    signal: AbortSignal.timeout(180_000),
  })
} catch (e) {
  ok(false, '/api/feiyu-chat 可调用', String(e?.message ?? e))
  process.exit(1)
}
if (res.status === 401) {
  ok(false, '/api/feiyu-chat 已加载', 'still 401 — 路由没挂上')
  process.exit(1)
}
ok(res.status === 200, '/api/feiyu-chat 返回 200', `HTTP ${res.status}`)
const data = await res.json().catch(() => null)

// ③ 有回复
const reply = String(data?.text ?? '').trim()
ok(Boolean(reply) && !/她这次没说话/.test(reply), `问「${QUESTION}」拿到回复`, reply ? `${reply.length} 字` : JSON.stringify(data).slice(0, 160))

// ④ 像鲸鲸（启发式）
const TONE = ['鲸鲸', '本小姐', '人家', '哼', '喵', '笨蛋', '狗修鲸']
const hits = TONE.filter((w) => reply.includes(w))
ok(hits.length > 0, '回复带鲸鲸腔（启发式）', hits.length ? `命中：${hits.join('/')}` : '一个词都没命中，人眼看一眼')

// ⑤ 并发两条不能串台（依赖新版端点的 turn 锁定；旧代码两条会拿到同一句）
const askTwo = async (t) => {
  try {
    const r = await fetch(base + '/api/feiyu-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: t, sessionId: SESSION }),
      signal: AbortSignal.timeout(180_000),
    })
    const j = await r.json()
    return String(j?.text ?? '').trim()
  } catch { return '' }
}
const [c1, c2] = await Promise.all([
  askTwo('只回一个词：苹果是什么颜色的？'),
  askTwo('只回一个词：天空是什么颜色的？'),
])
log(`\n  并发 A：${c1.slice(0, 60)}`)
log(`  并发 B：${c2.slice(0, 60)}`)
ok(Boolean(c1) && Boolean(c2) && c1 !== c2, '并发两条不串台',
  c1 === c2 ? '两条回复完全相同 —— 跑的还是旧代码，需要重启 DSH' : '')

if (reply) { log('\n—— 她的回答 ——'); log(reply.slice(0, 600)); log('') }
log(failed === 0 ? '通了 ✓' : `${failed} 项没过 ✗`)
process.exit(failed === 0 ? 0 : 1)

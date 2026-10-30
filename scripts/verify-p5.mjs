#!/usr/bin/env node
/**
 * verify-p5.mjs —— P5 灰度观察报告。
 *
 * 读 dsh-feiyu 的会话转录，统计最近 N 小时：
 *   · 轮次总数 / 按来源分（QQ 通道 vs B站 生物钟 vs 其它）
 *   · 每轮耗时（turn/start → turn/end），找最慢的
 *   · 空回复、报错、忙降级的痕迹
 *   · 知识库调用次数
 *
 * 用法：
 *   node verify-p5.mjs              # 最近 24 小时
 *   node verify-p5.mjs --hours 6
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const hi = process.argv.indexOf('--hours')
const HOURS = hi >= 0 ? Number(process.argv[hi + 1]) || 24 : 24
const since = Date.now() - HOURS * 3600_000

const root = path.join(os.homedir(), '.dsh', 'sessions')
const findFile = () => {
  const hits = []
  const walk = (d) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.v4.jsonl.zstd' && p.includes('dsh-feiyu')) hits.push(p)
    }
  }
  walk(root)
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}

const decode = (file) => {
  const buf = fs.readFileSync(file)
  const offs = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
  }
  let out = ''
  for (const o of offs) { try { out += zlib.zstdDecompressSync(buf.subarray(o)).toString('utf8') } catch {} }
  return out
}

const file = findFile()
if (!file) { console.log('没找到 dsh-feiyu 会话'); process.exit(1) }
const evs = decode(file).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const textOfUser = (e) => {
  const c = e.data?.content
  if (!Array.isArray(c)) return ''
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
}
const kindOf = (t) => {
  if (/【生物钟】|今夜不看|请求保护暂停/.test(t)) return 'B站轮次'
  if (/［用户消息］/.test(t)) return 'QQ 通道'
  if (/Time sampled|system-reminder/.test(t)) return '其它'
  return '其它'
}

const win = evs.filter((e) => (e.time ?? 0) >= since)
const starts = win.filter((e) => e.type === 'turn/start')
const ends = win.filter((e) => e.type === 'turn/end')

// 每轮：找出该 turn 下第一条 user/message（user/message 不带 turn，按顺序归属到最近一次 turn/start）
const userAfterStart = new Map()
let cur = null
for (const e of win) {
  if (e.type === 'turn/start') { cur = e.data?.turn; userAfterStart.set(cur, '') }
  else if (e.type === 'user/message' && cur !== null && !userAfterStart.get(cur)) {
    userAfterStart.set(cur, textOfUser(e))
  }
}

const buckets = { 'QQ 通道': 0, 'B站轮次': 0, '其它': 0 }
for (const [turn, text] of userAfterStart) {
  const k = kindOf(text || '')
  buckets[k] = (buckets[k] || 0) + 1
  void turn
}

const dur = new Map()
for (const e of win) {
  if (e.type === 'turn/start') dur.set(e.data?.turn, { start: e.time })
  else if (e.type === 'turn/end' && dur.has(e.data?.turn)) {
    const d = dur.get(e.data.turn)
    d.end = e.time
    d.ms = e.time - d.start
    d.reason = e.data?.reason?.kind
  }
}
const durs = [...dur.values()].filter((d) => d.ms > 0).map((d) => d.ms).sort((a, b) => a - b)
const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0
const max = durs.length ? durs[durs.length - 1] : 0
const p95 = durs.length ? durs[Math.floor(durs.length * 0.95)] : 0

const kbCalls = win.filter((e) => e.type === 'tool/call' && /^kb_/.test(String(e.data?.name || '')))
// 每轮最后一条 assistant/message 若没有 text 块，才算"真的没说话"（中间步骤只有 reasoning/tool-call 是正常的）
const lastAssistantOfTurn = new Map()
let curTurn = null
for (const e of win) {
  if (e.type === 'turn/start') curTurn = e.data?.turn
  else if (e.type === 'assistant/message' && curTurn !== null) lastAssistantOfTurn.set(curTurn, e)
}
const emptyReply = [...lastAssistantOfTurn.values()].filter((e) => {
  const blocks = e.data?.message?.content || []
  return !blocks.some((b) => b.type === 'text' && b.text?.trim())
})
const turned = new Set(ends.map((e) => e.data?.turn))
const unfinished = starts.filter((e) => !turned.has(e.data?.turn)).length

const fmt = (ms) => ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`
const t = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })

console.log(`\nP5 观察报告 · 最近 ${HOURS} 小时`)
console.log(`文件：${file}`)
console.log(`窗口：${t(since)} → ${t(Date.now())}\n`)
console.log(`轮次：${starts.length} 起 / ${ends.length} 完${unfinished ? `（${unfinished} 起未收尾）` : ''}`)
console.log(`来源：` + Object.entries(buckets).map(([k, v]) => `${k} ${v}`).join(' · '))
console.log(`耗时：平均 ${fmt(avg)} · p95 ${fmt(p95)} · 最长 ${fmt(max)}`)
console.log(`知识库调用：${kbCalls.length} 次${kbCalls.length ? '（' + [...new Set(kbCalls.map((e) => e.data.name))].join(', ') + '）' : ''}`)
console.log(`空回复 assistant/message：${emptyReply.length} 条`)

const slow = [...dur.values()].filter((d) => d.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 3)
if (slow.length) {
  console.log('\n最慢的几轮：')
  for (const s of slow) console.log(`  · ${t(s.start)} · ${fmt(s.ms)} · ${s.reason || '?'}`)
}

console.log('\n提示：QQ 通道的轮次应当明显短于 B站轮次；若 QQ 轮次频繁超过 120s，说明大脑常被 B站轮次占着。')

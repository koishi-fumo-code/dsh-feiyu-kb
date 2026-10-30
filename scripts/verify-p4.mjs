#!/usr/bin/env node
/**
 * verify-p4.mjs —— P4（大脑合并）验收：B站轮次到底有没有落进 `dsh-feiyu` 这个大脑？
 *
 * 直接读会话转录（多帧 zstd），不依赖任何接口：
 *   ~/.dsh/sessions/*<cwd>/<sessionId>/session.v4.jsonl.zstd
 *
 * 用法：
 *   node verify-p4.mjs                     # 默认 dsh-feiyu，看最近 60 分钟
 *   node verify-p4.mjs --since 180         # 看最近 180 分钟
 *   node verify-p4.mjs --session dsh-feiyu
 *
 * 退出码：0 = 最近窗口内有活动；1 = 没活动（B站轮次没跑，或跑去了别的会话）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : def
}
const SESSION = arg('session', 'dsh-feiyu')
const SINCE_MIN = Number(arg('since', '60')) || 60

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const findTranscript = () => {
  const hits = []
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.v4.jsonl.zstd' && p.includes(SESSION)) hits.push(p)
    }
  }
  walk(sessionsRoot)
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

/** 多帧 zstd：Node 只解第一帧，这里扫魔数逐帧解 */
const decodeAll = (file) => {
  const buf = fs.readFileSync(file)
  const offs = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
  }
  let out = ''
  for (const o of offs) {
    try { out += zlib.zstdDecompressSync(buf.subarray(o)).toString('utf8') } catch { /* 假魔数 */ }
  }
  return out
}

const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })
const clip = (s, n = 90) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

console.log(`\n会话：${SESSION}   窗口：最近 ${SINCE_MIN} 分钟\n`)

const files = findTranscript()
if (!files.length) {
  console.log(`[FAIL] 没找到 ${SESSION} 的会话转录（${sessionsRoot} 下）`)
  process.exit(1)
}
const file = files[0]
const st = fs.statSync(file)
const text = decodeAll(file)
const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const kinds = {}
for (const e of events) kinds[e.type] = (kinds[e.type] || 0) + 1
const turns = events.filter((e) => e.type === 'turn/start').map((e) => e.data?.turn).filter((n) => typeof n === 'number')
const lastEvent = events[events.length - 1]
const lastTime = lastEvent?.time ?? st.mtimeMs
const ageMin = Math.round((Date.now() - lastTime) / 60000)

console.log(`文件：${file}`)
console.log(`大小：${(st.size / 1024).toFixed(1)} KB   事件：${events.length}   turn/start：${turns.length}`)
console.log(`最后事件：${fmt(lastTime)}（${ageMin} 分钟前）`)
console.log(`类型：${JSON.stringify(kinds)}`)

// 最近几条对话
const recentUser = events.filter((e) => e.type === 'user/message').slice(-3)
const recentAssistant = events.filter((e) => e.type === 'assistant/message').slice(-3)
const textOf = (e) => (Array.isArray(e.data?.message?.content) ? e.data.message.content : e.data?.content ?? [])
  .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
  .map((b) => b.text).join('')

if (recentUser.length) {
  console.log('\n最近 3 条用户消息：')
  for (const e of recentUser) console.log(`  · [${fmt(e.time)}] ${clip(textOf(e) || e.data?.content?.map?.((b) => b.text).join(''))}`)
}
if (recentAssistant.length) {
  console.log('\n最近 3 条她的回复：')
  for (const e of recentAssistant) console.log(`  · [${fmt(e.time)}] ${clip(textOf(e))}`)
}

// 归档痕迹
const kbCalls = events.filter((e) => e.type === 'tool/call' && /kb_add|kb_search/.test(String(e.data?.name || '')))
console.log(`\n知识库调用：${kbCalls.length} 次${kbCalls.length ? '（' + [...new Set(kbCalls.map((e) => e.data.name))].join(', ') + '）' : ''}`)

let failed = 0
const ok = (c, l, x = '') => { if (c) console.log(`  [OK]   ${l}${x ? ' — ' + x : ''}`); else { failed++; console.log(`  [FAIL] ${l}${x ? ' — ' + x : ''}`) } }

console.log('')
ok(true, '找到会话转录', path.basename(path.dirname(file)))
ok(turns.length > 0, '会话里有轮次', `${turns.length} 轮`)
ok(ageMin <= SINCE_MIN, `最近 ${SINCE_MIN} 分钟内有活动`, ageMin <= SINCE_MIN ? `${ageMin} 分钟前` : `最后活动在 ${ageMin} 分钟前 —— 这轮没跑，或跑去别的会话了`)

console.log(failed === 0 ? '\nP4 有活动 ✓' : `\n${failed} 项没过 ✗`)
process.exit(failed === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * rollback-merge.mjs —— 一键回滚「三条鱼合并」的改动。
 *
 *   node rollback-merge.mjs --to p4 --yes     # 只回滚 P4 改过的东西（保留 P1/P2/P3）
 *   node rollback-merge.mjs --to orig --yes   # 全部回到合并前
 *   node rollback-merge.mjs --to p4 --dry     # 只看会动哪些文件，不动手
 *
 * P4 只动过这几处（所以 --to p4 只碰这些）：
 *   lib/index.js 的 sessionId、~/.dsh/whale-session.json、~/.dsh/feiyu-kb.config.json 的 sync.dirs、
 *   feiyu-brain/AGENTS.md（大脑在 D 盘工作区）
 *
 * ⚠️ 回滚后必须重启 DSH 才生效（插件代码不会热加载）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const LIB = path.join(DSH, 'profiles', 'desktop', 'node_modules', 'dsh-bili-whale', 'lib')
const WS = 'D:\\dsh工作区'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const yes = args.includes('--yes')
const ti = args.indexOf('--to')
const target = ti >= 0 ? args[ti + 1] : 'p4'
if (!['p4', 'orig'].includes(target)) {
  console.error('--to 只能是 p4 或 orig')
  process.exit(2)
}
if (!dry && !yes) {
  console.error('这会覆盖文件。确认无误后加 --yes；只看计划加 --dry。')
  process.exit(2)
}

let done = 0, skipped = 0
const act = (label, fn) => {
  try {
    if (dry) { console.log(`  [dry]  ${label}`); return }
    fn()
    done++
    console.log(`  [OK]   ${label}`)
  } catch (e) {
    if (e.code === 'ENOENT') { skipped++; console.log(`  [skip] ${label}（备份不存在）`) }
    else { console.log(`  [FAIL] ${label} — ${e.message}`) }
  }
}
const restore = (src, dst) => () => fs.copyFileSync(src, dst)
const rm = (p) => () => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }) }

const SHORT_BRAIN_AGENTS = `# 鲸鲸的大脑会话

> 这条会话是「一个大脑」：QQ 通道、B站轮次、DSH 对话都指向它。

- **人设唯一源**：\`D:\\dsh工作区\\persona\\whale.md\`。上下文缺失时先读它，别自己编人格。
- **记忆**：\`D:\\dsh工作区\\大肥鱼知识库\`。要查旧事用 \`kb_search\`；新知识用 \`kb_add\`（记得带 \`origin\`）。
- **说话**：短，像 QQ 群里随口聊天，别写小作文、别列点。
- **隐私**：不把账号、路径、私聊内容写进知识库。
`

console.log(`\n回滚目标：${target}${dry ? '（演练，不动文件）' : ''}\n`)

if (target === 'p4') {
  // ── 只回滚 P4 ──
  act('lib/index.js：sessionId 改回 bili-whale ← index.js.bak-p4', restore(path.join(LIB, 'index.js.bak-p4'), path.join(LIB, 'index.js')))
  act('whale-session.json：id 改回 bili-whale ← .bak-p4', restore(path.join(DSH, 'whale-session.json.bak-p4'), path.join(DSH, 'whale-session.json')))
  act('feiyu-brain/AGENTS.md：还原成不含刷视频规则的短版（D 盘大脑目录）', () => {
    const dir = path.join(WS, 'feiyu-brain')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), SHORT_BRAIN_AGENTS, 'utf8')
  })
  console.log('\n（P1 人设单一源、P2 origin、P3 QQ 通道保持不动）')
} else {
  // ── 全部回滚到合并前 ──
  for (const f of ['scheduler.js', 'session-delivery.js', 'index.js', 'client.js']) {
    const merge = path.join(LIB, f + '.bak-merge')
    act(`lib/${f} ← 原始备份`, restore(merge, path.join(LIB, f)))
  }
  act('~/.bili-ai/persona.md ← persona/_legacy/ 归档', restore(path.join(WS, 'persona', '_legacy', 'bili-fish-persona.md'), path.join(HOME, '.bili-ai', 'persona.md')))
  act('bili-whale.config.json ← .bak-merge', restore(path.join(DSH, 'bili-whale.config.json.bak-merge'), path.join(DSH, 'bili-whale.config.json')))
  act('whale-night.json ← .bak-merge', restore(path.join(DSH, 'whale-night.json.bak-merge'), path.join(DSH, 'whale-night.json')))
  act('whale-session.json ← .bak-p4', restore(path.join(DSH, 'whale-session.json.bak-p4'), path.join(DSH, 'whale-session.json')))
  act('feiyu-kb.config.json ← .bak-p4（会同时还原 brainCwd / sync.dirs）', restore(path.join(DSH, 'feiyu-kb.config.json.bak-p4'), path.join(DSH, 'feiyu-kb.config.json')))
  act('删除 D 盘大脑目录 feiyu-brain/', rm(path.join(WS, 'feiyu-brain')))
  act('删除 C 盘旧大脑目录 .dsh/feiyu-brain/', rm(path.join(DSH, 'feiyu-brain')))
  act('删除 AstrBot 转发插件目录', rm('D:\\QQBot\\AstrBot\\data\\plugins\\astrbot_plugin_feiyu_bridge'))
  act('删除 feiyu_bridge.json', rm('D:\\QQBot\\AstrBot\\data\\feiyu_bridge.json'))
  act('删除 persona/whale.md（_legacy 归档保留）', rm(path.join(WS, 'persona', 'whale.md')))
}

console.log(`\n${dry ? '演练结束，未改动任何文件' : `完成 ${done} 项，跳过 ${skipped} 项`}`)
console.log('⚠️ 回滚后必须重启 DSH 才生效（插件代码不会热加载）。\n')

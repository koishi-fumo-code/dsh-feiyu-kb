/**
 * lib/ctx-save.mjs —— 给 DSH 的压缩器调参（设置页那个开关背后的实现）
 * ============================================================================
 * 为什么要有它：DSH 的 token 计量是「4 字符 ≈ 1 token」的估算，**对中文是低估的**
 * （官方 README 自己写着）。所以中文会话显示「已用 60%」时，真实可能已到 70%+。
 * 把 thresholdRatio 从默认 0.8 调到 0.6，等于提前触发压缩，会话就能撑更久。
 *
 * 🔴 安全规矩（2026-10-28 崩过一次，这里一条都不敢省）：
 *   ① 写之前**备份**成 cordis.patch.yml.bak-<时间戳>
 *   ② 只动自己标记的那一块（`# >>> feiyu-kb-compaction` … `# <<<`），别人的行一个字不碰
 *   ③ 写完**先校验**（js-yaml 解析 + 形状检查），校验不过就**还原备份**并报错
 *   ④ 幂等：块已存在且值相同 ⇒ 一个字节都不写
 * ============================================================================
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const BEGIN = '# >>> feiyu-kb-compaction（由 dsh-feiyu-kb 管理，删掉这段就恢复默认）'
const END = '# <<< feiyu-kb-compaction'

export const CTX_DEFAULTS = { thresholdRatio: 0.6, retainRatio: 0.12 }

const pad = (n) => String(n).padStart(2, '0')
function stamp() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 生成要插入的那一块；enabled=false 时返回空串（表示"不该存在"） */
function blockFor({ enabled, thresholdRatio, retainRatio }) {
  if (!enabled) return ''
  const t = Number(thresholdRatio)
  const r = Number(retainRatio)
  const safeT = Number.isFinite(t) && t > 0.05 && t < 1 ? t : CTX_DEFAULTS.thresholdRatio
  const safeR = Number.isFinite(r) && r > 0 && r < 0.9 ? r : CTX_DEFAULTS.retainRatio
  return [
    BEGIN,
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    `    thresholdRatio: ${safeT}`,
    `    retainRatio: ${safeR}`,
    END,
    '',
  ].join('\n')
}

function stripBlock(text) {
  const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g')
  return text.replace(re, '\n')
}

/** 能拿到 js-yaml 就用它做严格校验；拿不到就退回"形状检查" */
function parsePatch(text, profileDir) {
  try {
    const req = createRequire(join(profileDir, 'package.json'))
    const yaml = req('js-yaml')
    const v = yaml.load(text)
    if (!Array.isArray(v)) return { ok: false, why: '解析结果不是数组' }
    return { ok: true, rows: v }
  } catch (e) {
    // 没有 js-yaml：至少确认顶层是数组（第一行有意义的内容以 - 开头，或是 []）
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    if (!lines.length) return { ok: true }
    if (lines[0] === '[]' && lines.length > 1) return { ok: false, why: '`[]` 占位后面又跟条目' }
    if (lines[0] !== '[]' && !lines[0].startsWith('-')) return { ok: false, why: '顶层不是数组' }
    return { ok: true }
  }
}

/**
 * 让 profile 的压缩配置跟设置保持一致。
 * @returns {{ok:boolean, changed:boolean, backup?:string, error?:string, patchFile?:string}}
 */
export function syncCompaction({ profileDir, enabled, thresholdRatio = CTX_DEFAULTS.thresholdRatio, retainRatio = CTX_DEFAULTS.retainRatio, log = () => {} }) {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return { ok: false, changed: false, error: `没有 ${patchFile}` }

  const before = readFileSync(patchFile, 'utf8')
  const desired = blockFor({ enabled, thresholdRatio, retainRatio })
  const hasBlock = before.includes(BEGIN)

  if (!desired && !hasBlock) return { ok: true, changed: false, patchFile }        // 本来就该没有
  if (desired && hasBlock && desiredEqual(before, desired)) return { ok: true, changed: false, patchFile } // 已经是想要的

  // ① 备份
  const backup = `${patchFile}.bak-${stamp()}`
  try { copyFileSync(patchFile, backup) } catch (e) {
    return { ok: false, changed: false, error: `备份失败，不敢改：${e?.message ?? e}` }
  }

  // ② 拼新内容：先摘掉旧块，再按需追加新块
  let base = stripBlock(before).trimEnd()
  if (!base) base = '[]'
  const next = (desired ? `${base}\n\n${desired}` : `${base}\n`).replace(/\n{3,}/g, '\n\n')

  // ③ 校验（校验不过就别写）
  const check = parsePatch(next, profileDir)
  if (!check.ok) {
    return { ok: false, changed: false, backup, error: `改完的 patch 不合法（${check.why}），已放弃` }
  }

  // ④ 写临时文件再原子替换
  const tmp = `${patchFile}.tmp-${stamp()}`
  try {
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, patchFile)
  } catch (e) {
    try { copyFileSync(backup, patchFile) } catch { /* 还原失败也只能报错 */ }
    return { ok: false, changed: false, backup, error: `写入失败，已还原：${e?.message ?? e}` }
  }

  // ⑤ 写完再读一遍确认没坏
  const after = readFileSync(patchFile, 'utf8')
  const recheck = parsePatch(after, profileDir)
  if (!recheck.ok) {
    try { copyFileSync(backup, patchFile) } catch { /* 忽略 */ }
    return { ok: false, changed: false, backup, error: `写完复查不合法（${recheck.why}），已还原` }
  }

  log(`压缩配置已${desired ? '写入' : '移除'}（备份：${backup}）`)
  return { ok: true, changed: true, backup, patchFile }
}

/** 块存在且数值一致（避免每次启动都重写） */
function desiredEqual(text, desired) {
  const m = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  const cur = (text.match(m) || [''])[0]
  return cur.replace(/\s+/g, ' ').trim() === desired.replace(/\s+/g, ' ').trim()
}

/** 设置页要显示的状态：profile 里现在是不是已经调过了 */
export function compactionStatus(profileDir) {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  try {
    const text = readFileSync(patchFile, 'utf8')
    const m = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(text)
    if (!m) return { applied: false, patchFile }
    const t = /thresholdRatio:\s*([\d.]+)/.exec(m[0])
    const r = /retainRatio:\s*([\d.]+)/.exec(m[0])
    return { applied: true, thresholdRatio: t ? Number(t[1]) : null, retainRatio: r ? Number(r[1]) : null, patchFile }
  } catch { return { applied: false, patchFile } }
}

/**
 * lib/materialize.mjs —— 把「补丁」降级成「生成文件」
 * ============================================================================
 * 背景（2026-10-30）：B站 插件 dsh-bili-whale 原本被我们改了 3 个文件、36 行，
 * 用来做三件事：读 whale.md 人设、注入最近记忆、注入 bili.mjs 路径。
 * 问题是**一升级就全没**。
 *
 * 替代方案：这三件事全靠它本来就支持的「公开行为」——
 *   它默认读 `~/.bili-ai/persona.md` 当人设。
 * 所以我们**生成**这个文件：人设正文 + 最近的记忆 + 工具入口路径，写进去。
 * 插件随便升级，生成的文件还在。
 *
 * 源还是 `persona/whale.md`（唯一人设源）；这份生成物带「自动生成」头，
 * 谁改了会在下次生成时被覆盖 —— 所以里面的东西必须是**可再生的**。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 找 bili.mjs 的真实位置（哪个 profile 里有就用哪个） */
export function findBiliMjs(home = dshHome()) {
  const profilesDir = join(home, 'profiles')
  try {
    for (const prof of readdirSafe(profilesDir)) {
      const p = join(profilesDir, prof, 'node_modules', 'dsh-bili-whale', 'tools', 'bili.mjs')
      if (existsSync(p)) return p
    }
  } catch { /* 没有就算了 */ }
  return ''
}

function readdirSafe(p) {
  try { return readdirSync(p) } catch { return [] }
}

/** 生成 persona.md 的正文 */
export function renderPersona({ personaText, digestText, biliMjs }) {
  const body = String(personaText || '').trim()
  const lines = [
    '<!-- 自动生成，别手改：源在 persona/whale.md，由 dsh-feiyu-kb 维护 -->',
    '',
    body,
  ]
  if (digestText && !digestText.includes('（还没有）')) {
    lines.push('', '［最近的记忆］', digestText.replace(/^#.*$/m, '').trim())
  }
  if (biliMjs) {
    lines.push('', '［工具入口］',
      `bili.mjs 的绝对路径：${biliMjs.replace(/\\/g, '/')}`,
      '命令（deps / feed / debrief / comment / dm / fav / diary / quota …）都在它下面，直接用这个路径，别去别处找。')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 写 `~/.bili-ai/persona.md`。
 * @param {object} o
 * @param {string} o.personaText  whale.md 的正文
 * @param {string} [o.digestText] recent.md 的正文（记忆摘要）
 * @param {string} [o.home]       DSH_HOME
 * @param {string} [o.target]     生成到哪（默认 ~/.bili-ai/persona.md）
 * @param {boolean} [o.dry]
 */
export function materializePersona({ personaText, digestText = '', home = dshHome(), target, dry = false }) {
  const file = target || join(homedir(), '.bili-ai', 'persona.md')
  const biliMjs = findBiliMjs(home)
  const text = renderPersona({ personaText, digestText, biliMjs })
  if (!dry) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
  }
  return { ok: true, file, bytes: Buffer.byteLength(text), biliMjs }
}

#!/usr/bin/env node
/**
 * scripts/install-bridge.mjs —— 把 bridge/ 里的 AstrBot 转发插件部署到 AstrBot
 * ============================================================================
 * 这个插件跑在 AstrBot 进程里（Python），不能直接打进 DSH 插件包里，
 * 所以源码放在 bridge/ 下随包发布，用这个脚本部署过去。
 *
 * 用法：
 *   node scripts/install-bridge.mjs                          # 默认 D:/QQBot/AstrBot/data/plugins
 *   node scripts/install-bridge.mjs <目标插件目录>
 *   ASTRBOT_PLUGINS=<目录> node scripts/install-bridge.mjs
 *
 * 部署完要在 AstrBot 里重载插件（或重启），然后 QQ 私聊发 /鲸鲸 on。
 * ============================================================================
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'bridge', 'astrbot_plugin_feiyu_bridge')
const destRoot = process.argv[2] || process.env.ASTRBOT_PLUGINS || 'D:/QQBot/AstrBot/data/plugins'
const dest = join(destRoot, 'astrbot_plugin_feiyu_bridge')

if (!existsSync(src)) {
  console.error(`找不到 bridge 源：${src}`)
  process.exit(1)
}

mkdirSync(destRoot, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`已部署到 ${dest}`)
console.log('下一步：在 AstrBot 里重载插件（或重启），然后 QQ 私聊发「/鲸鲸 on」')

/**
 * dsh-feiyu-kb —— 浏览器半端（设置里的「知识库」一页）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本（DSH 的约定）：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * 进「设置」的写法（抄 dsh-bili-scroll / dsh-meme）：
 *   const slots = ctx.get('slots')
 *   slots.inject('settings.section', () => slots.register({ name:'settings.section', id, order, label }, () => h(Panel)))
 *
 * 这一页只放使用者要的三件事（2026-10-28）：
 *   ① 知识库文件夹（改完立刻生效）
 *   ② kb_ingest / kb_capture 两个工具开关
 *   ③ 条数一览 + 重建索引
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-feiyu-kb',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/feiyu-kb'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 403 ? '（被宿主拦了：只接受本机同源）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-fk-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-fk-sec]{display:flex;flex-direction:column;gap:8px;}
[data-fk-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fk-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-fk-label]{font-size:13px;}
[data-fk-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fk-input]{flex:1;min-width:220px;height:30px;padding:0 10px;font-size:12px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));
  background:var(--dsw-alias-bg-base,transparent);color:inherit;font-family:inherit;}
[data-fk-btn]{height:30px;padding:0 12px;font-size:12px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));
  background:var(--dsw-alias-bg-base,transparent);color:inherit;}
[data-fk-btn]:disabled{opacity:.5;cursor:default;}
[data-fk-btn][data-primary]{background:var(--dsw-alias-accent,#3b82f6);color:#fff;border-color:transparent;}
[data-fk-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-border-default,rgba(127,127,127,.4));transition:background .15s;}
[data-fk-sw][data-on]{background:var(--dsw-alias-accent,#3b82f6);}
[data-fk-sw]:after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:8px;background:#fff;transition:left .15s;}
[data-fk-sw][data-on]:after{left:19px;}
[data-fk-msg]{font-size:12px;padding:6px 10px;border-radius:7px;background:rgba(127,127,127,.12);}
[data-fk-msg][data-good]{background:rgba(34,197,94,.16);color:#16a34a;}
[data-fk-msg][data-warn]{background:rgba(234,179,8,.16);color:#b45309;}
[data-fk-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-fk-switch-row]{display:flex;align-items:center;gap:12px;}
[data-fk-switch-text]{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}
`

    function Panel() {
      const [st, setSt] = useState(null)
      const [root, setRoot] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [tone, setTone] = useState('')
      const [err, setErr] = useState('')

      const load = useCallback(async () => {
        try {
          const s = await jget('/status')
          setSt(s)
          setRoot((prev) => (prev === '' ? (s.root || '') : prev))
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }, [])

      useEffect(() => { load() }, [load])

      const say = (text, t = '') => { setMsg(text); setTone(t); setTimeout(() => setMsg(''), 4000) }

      const saveRoot = async () => {
        setBusy('root')
        try {
          const r = await jpost('/config', { root })
          setSt(r)
          setRoot(r.root || '')
          say('已保存，库位置：' + r.root, 'good')
        } catch (e) { say('保存失败：' + e.message, 'warn') } finally { setBusy('') }
      }

      const toggle = async (key, value) => {
        setBusy(key)
        try {
          const r = await jpost('/config', { tools: { [key]: value } })
          setSt(r)
          say((key === 'ingest' ? 'kb_ingest' : 'kb_capture') + (value ? ' 已打开' : ' 已关闭'), 'good')
        } catch (e) { say('切换失败：' + e.message, 'warn') } finally { setBusy('') }
      }

      const rebuild = async () => {
        setBusy('index')
        try {
          const r = await jpost('/index')
          say(`索引已重建（${r.entries} 条）`, 'good')
          await load()
        } catch (e) { say('重建失败：' + e.message, 'warn') } finally { setBusy('') }
      }

      if (err && !st) {
        return h('div', { 'data-fk-page': '' },
          h('div', { 'data-fk-sec': '' },
            h('div', { 'data-fk-h': '' }, '知识库'),
            h('div', { 'data-fk-msg': '', 'data-warn': '' }, '接口没连上：' + err),
            h('div', { 'data-fk-note': '' }, '插件可能还没加载完，或者宿主没挂 webServer。重开一下设置页试试。')))
      }

      const tools = (st && st.tools) || { ingest: true, capture: true }

      return h('div', { 'data-fk-page': '' },
        // ── 存放位置 ──
        h('div', { 'data-fk-sec': '' },
          h('div', { 'data-fk-h': '' }, '知识库文件夹'),
          h('div', { 'data-fk-row': '' },
            h('input', {
              'data-fk-input': '', value: root, placeholder: '留空 = 用默认（~/dsh-feiyu-kb）',
              onChange: (e) => setRoot(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') saveRoot() },
            }),
            h('button', { 'data-fk-btn': '', 'data-primary': '', disabled: busy === 'root', onClick: saveRoot }, '保存')),
          h('div', { 'data-fk-note': '' }, '笔记就是这一堆 .md；改完立刻生效，不用重启。留空则跟随 profile 配置。'),
          st ? h('div', { 'data-fk-kv': '' },
            `当前：${st.root}`,
            h('br'),
            `已收 ${st.entries} 条 · ${Object.entries(st.byKind || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '空空如也'}`,
            h('br'),
            `索引：${st.indexPath}`) : h('div', { 'data-fk-note': '' }, '读取中…')),

        // ── 工具开关 ──
        h('div', { 'data-fk-sec': '' },
          h('div', { 'data-fk-h': '' }, '工具开关'),
          h('div', { 'data-fk-switch-row': '' },
            h('button', {
              'data-fk-sw': '', 'data-on': tools.ingest ? '' : undefined, 'aria-pressed': tools.ingest ? 'true' : 'false',
              disabled: busy === 'ingest', onClick: () => toggle('ingest', !tools.ingest),
            }),
            h('div', { 'data-fk-switch-text': '' },
              h('div', { 'data-fk-label': '' }, 'kb_ingest —— 收外部东西'),
              h('div', { 'data-fk-note': '' }, '网页 / 本地文件 / 整个目录 / RSS 订阅。关掉后模型就调不动它了。'))),
          h('div', { 'data-fk-switch-row': '' },
            h('button', {
              'data-fk-sw': '', 'data-on': tools.capture ? '' : undefined, 'aria-pressed': tools.capture ? 'true' : 'false',
              disabled: busy === 'capture', onClick: () => toggle('capture', !tools.capture),
            }),
            h('div', { 'data-fk-switch-text': '' },
              h('div', { 'data-fk-label': '' }, 'kb_capture —— 随手记一段'),
              h('div', { 'data-fk-note': '' }, '聊天里看到的一句话、书上抄的一段，直接存成一条笔记。'))),
          h('div', { 'data-fk-note': '' }, '关掉只是不开放那个工具，已有的笔记和别的工具都不受影响。')),

        // ── 维护 ──
        h('div', { 'data-fk-sec': '' },
          h('div', { 'data-fk-h': '' }, '维护'),
          h('div', { 'data-fk-row': '' },
            h('button', { 'data-fk-btn': '', disabled: busy === 'index', onClick: rebuild }, '重建索引'),
            h('button', { 'data-fk-btn': '', onClick: load }, '刷新'),
            h('div', { 'data-fk-note': '' }, '手改过 entries/ 里的文件之后点一下；平时不用管。')),
          st ? h('div', { 'data-fk-kv': '' }, `设置文件：${st.configPath}`) : null),

        msg ? h('div', { 'data-fk-msg': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined }, msg) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-feiyu-kb')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-feiyu-kb: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        try {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'feiyu-kb', order: 32, label: '知识库' },
            () => h(Panel),
          ))
        } catch (e) { /* 没有这个槽位就算了，别把设置页整挂 */ }
      },
    }
  },
})

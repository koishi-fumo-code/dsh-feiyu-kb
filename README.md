# dsh-feiyu-kb

> DSH 插件：把本地一个**纯 Markdown 的知识库**，变成 DSH 里**任何模型运行时**都能调用的工具。
> 0.7.0 起，它还是一个**记忆库** —— 记知识，也记人和事。

▶ **[131 秒介绍片 · 0.7.0](https://github.com/koishi-fumo-code/dsh-feiyu-kb/releases/download/v0.7.0/dsh-feiyu-kb-intro-0.7.0.mp4)** · [旧版 88 秒](https://github.com/koishi-fumo-code/dsh-feiyu-kb/releases/download/v0.3.1/dsh-feiyu-kb-intro.mp4)

---

## 它解决什么问题

刷到的视频、读过的文章、聊出来的结论 —— **第二天就找不着了**。模型有上下文窗口，但没有长期记忆。

这个插件做三件事：

1. **存**：把值得留的东西写成一个个 `.md` 文件（一条一个文件，带 front-matter）；
2. **找**：给模型一组工具，能搜、能读、能写、能找"三个月前那条同主题的"；
3. **留得住**：网页、本地文件、目录、RSS、随手一段话都能进；上游插件跑没跑成都不影响。

没有数据库、没有向量库、不发网络请求（除了你让它抓网页）。

## 快速开始

```bash
git clone https://github.com/koishi-fumo-code/dsh-feiyu-kb.git
node dsh-feiyu-kb/scripts/install.mjs --root "D:/你的/知识库"
```

然后**重启一次 DSH**。验证：

```bash
node dsh-feiyu-kb/scripts/preflight.mjs --profile ~/.dsh/profiles/desktop
node dsh-feiyu-kb/scripts/selftest.mjs        # 41 条功能断言
```

装好后：设置里多一页「知识库」；模型手里多 8 只工具。

## 你会得到什么（12 只工具）

### 知识库（`kb_*`）—— 那期视频讲了什么

| 工具 | 干什么 |
|---|---|
| `kb_search` | 搜：标题 / UP / 标签 / 正文，空格分隔多词（全部命中）；留空 = 列最近 |
| `kb_read` | 读一条全文（默认截 8000 字，要全文传 `full: true`） |
| `kb_add` | 新增/更新：按 BV号 → URL → 日期+标题 判重；**合并式更新**（给了才覆盖、标签取并集） |
| `kb_related` | 找同主题旧笔记（标签加权 + 中文二字组 + 英文/型号词），每条给理由 |
| `kb_ingest` | 收外部内容：`url` 抓网页 / `file` 导文件 / `dir` 批量导目录 / `feed` 收 RSS·Atom |
| `kb_capture` | 随手记一段话，自动起标题、抽要点 |
| `kb_status` | 库概况：条数、类型/档位分布、最近几条 |
| `kb_index` | 重建索引（手改过 `entries/` 之后调一次） |

工具定义有固定 token 开销（每轮请求都要带），所以描述是**给模型看的路标**，不是说明书。

### 记忆库（`mem_*`）—— 你上次跟我说过什么

和知识库刻意分开：知识是**档案**（可公开、按主题），记忆是**往来**（偏私密、按时间）。

| 工具 | 干什么 |
|---|---|
| `mem_add` | 记一件事：谁 + 什么事 + 什么时候，一两句话 |
| `mem_search` | 搜记忆，也能搜原始对话流水（默认搜最近 14 天） |
| `mem_read` | 按 id 读一条完整记忆 |
| `mem_status` | 记忆库概况：条数、最近一条、流水天数 |

**自动记录**：插件订阅 `session/event`，把 `dsh-feiyu` 会话里的问答成对写进 `chats/YYYY-MM-DD.md`，
并按来源打标（`qq` / `bili` / `dsh`）。所以三个通道的对话都会进同一本账，不需要各通道分别对接。

**自动注入**：每次对话会把最近 5 条记忆的一句话塞进提示（`memory.inject` 可调）。
B站 轮次读 `recent.md` 摘要（由本插件维护），所以刷视频时她也知道用户最近说过什么。

## 第一次使用：让它在你机器上跑起来

插件里**没有写死的绝对路径**，默认都跟着 `$DSH_HOME`（Windows 上是 `C:\Users\<你>\.dsh`）：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `kb.root` | `~/dsh-feiyu-kb` | 知识库 |
| `memory.root` | `$DSH_HOME/feiyu-memory` | 记忆库 |
| `brain.session` | `dsh-feiyu` | 大脑会话名 |
| `brain.cwd` | `$DSH_HOME/feiyu-brain` | 大脑会话的工作目录 |
| `brain.persona` | `$DSH_HOME/feiyu-persona.md` | 人设文件（找不到就不注入） |

**记忆怎么收进来**：插件订阅 DSH 的 `session/event`，会话满足**任一**条件就记：

1. 会话名 = `brain.session`（默认 `dsh-feiyu`）
2. 会话的工作目录 = `brain.cwd`

所以接 B站 插件时**不用改它的会话名** —— 把它的会话工作目录指到 `brain.cwd` 就行，记忆照样收进来。

记录时会按来源打标：文本里有 `［用户消息］` → `qq`，有 `【生物钟】` → `bili`，其余 `dsh`。

**QQ 怎么接**：部署 `bridge/` 里的 AstrBot 插件（`npm run bridge:install`），它 POST `/api/feiyu-chat`；
请求里的 `sessionId` 不传就用 `brain.session`。

**换机器**：整个 `$DSH_HOME` 拷走即可。如果你在配置里填了绝对路径，改配置就行，不用改代码。

## 知识从哪来

| 通道 | 怎么用 |
|---|---|
| **刷视频插件自动归档** | 见「接上刷视频插件」，两种方式 |
| **网页** | `kb_ingest from=url url=…`（只 http/https，拒绝内网，单页上限 5MB） |
| **本地文件 / 目录** | `kb_ingest from=file path=…` / `from=dir dir=… ext=.md` |
| **RSS / Atom** | `kb_ingest from=feed url=… limit=10` |
| **随手记** | `kb_capture text="…"` |
| **目录同步（兜底）** | 设置页开关：每 10 分钟扫指定目录里的 `.md`，新的自动收进来 |

要点是**从正文里如实摘的**（标题行 / 列表 / 句子），不是模型总结；抽不出来就只留一句话，绝不编。

## 相关推荐怎么算

不引模型、不联网，毫秒级：

| 信号 | 权重 | 说明 |
|---|---|---|
| 标签重合 | 5 / 个（封顶 3 个） | 最强信号 —— 归档时打好 3~6 个标签最划算 |
| 英文 / 型号词重合 | 3 / 个（封顶 3 个） | `KVCache`、`DeepInfer` 这类 |
| 中文二字组重合率 | 6 × 比例 | 标题 + 正文切二字组，去掉「视频 / 教程 / 合集」这类虚词 |

低于阈值（默认 3 分）不返回 —— **宁可空着，也不硬凑「相关」**。每条结果都带 `why`。

## 为什么是文件

- **任何运行时都能用**：有插件时调工具；只有 bash 时用 `lib/kb-cli.mjs`；什么都没有就直接读写 `.md`。
- **零依赖**：不 require 任何 `@deepseek-ai/*`（桌面 profile 是 `autoInstallPeers: false`，裸 import peer 会让整条插件不激活）。
- **可读可改可 git**：知识不是黑盒向量，出问题能一眼看见；拷走目录就搬家。

```
<root>/
├── entries/<年>/<月>/<日期>-<BV号>.md   一条一个文件
├── INDEX.md / index.jsonl              人看 / 机器看的索引（自动生成，别手改）
└── .kb/meta.json                       统计 + plugin.log
```

一条长这样：

```markdown
---
id: "2026-10-27-BV1Mxn26eEh5"
bvid: "BV1Mxn26eEh5"
title: "…"
up: "eogee"
url: "https://www.bilibili.com/video/BV1Mxn26eEh5"
date: "2026-10-27"
added: "2026-10-28T13:34:45+08:00"
source: "bili-scroll"
via: "video"            # video | web | file | rss | note
kind: "知识"             # 知识 | 有意思
tier: "值得看"            # 值得看 | 可以看 | 不值当
status: "待看"            # 待看 | 已看 | 略过
tags: ["推理", "KVCache"]
---

# 标题

## 一句话
…
## 要点
- …
```

## 设置页（DSH 设置 → 知识库）

| 项 | 作用 |
|---|---|
| **知识库文件夹** | 改库位置，**保存即生效**；留空 = 跟随 profile 配置 |
| **工具开关** | 分别控制 `kb_ingest` / `kb_capture`（关掉只是不开放，已有笔记不受影响） |
| **上下文压缩** | 把 DSH 的压缩阈值从默认 0.8 调到 0.6（中文会话更省），见下节 |
| **目录同步** | 定时扫目录收笔记（兜底），可填多个目录 |
| **健康检查** | 立即体检 + 看上次的崩溃报告 |

设置存在 `$DSH_HOME/feiyu-kb.config.json`，卸载不污染 profile。

## 让一轮会话跑得更久

DSH 的 token 计量按 **「4 字符 ≈ 1 token」**估算，官方文档写明**对中文偏低** —— 界面显示「已用 60%」时，中文会话实际可能已 70%+。所以插件可以把压缩阈值提前：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.6     # 默认 0.8
    retainRatio: 0.12       # 默认 0.16
```

写 profile 是会崩机的那类操作，所以这一路都有闸：**写前备份 → 只动自己标记的那段 → 写完 js-yaml 严格校验 → 不合法自动还原**。关掉开关会把那段移除。

## 接上刷视频插件（两条路，建议都开）

**A. 让那一轮自己归档（推荐）**

把 [`examples/whale-work-AGENTS.md`](examples/whale-work-AGENTS.md) 复制到刷视频插件的会话工作目录 `~/.dsh/whale-work/AGENTS.md`，DSH 每轮会注入给被唤醒的 agent。

它做三件事：

1. 挑中有价值的视频后调 `kb_add` 归档（要点必须读自字幕，读不到就只写一句话）；
2. 归档完调 `kb_related`，把库里的同主题旧笔记翻出来；
3. 每轮结束（不管归档成没成）往 `notes/YYYY-MM-DD.md` 追加三五行 —— 给 B 留的**落盘锚点**。

里面还写了**口味规则**：优先 `preferences.like` 里的内容；纯成果展示（手工/绘画/模型）只有读到可复用的方法才收；纯搬运/标题党/吃瓜一律不收；每轮 0~3 条，宁缺勿滥。

这是**指令注入**，不碰插件代码、不改人设 —— 而且它唤醒的 agent 本来就能调 `kb_add`。

**B. 目录同步（兜底）**

设置页开关打开即可，默认扫 `~/.dsh/whale-work`。

⚠️ **它只收"落在这些目录里的 `.md`"**：
- 默认目录里如果只有 `AGENTS.md`，会被跳过（说明文件不算笔记）⇒ **扫到 0、收 0，空转**；
- 所以要配合 A 的第 2 条（写 `notes/YYYY-MM-DD.md`），或者把目录改成上游**真实落盘**的位置。
- 设置页现在会显示「上次同步：时间 · 扫了 N 个文件 · 收 M 篇」，扫到 0 时会直接告警 —— 空转不再隐形。

> 复盘（2026-10-29）：旧插件靠 `dsh --profile headless` 跑，而 headless 里没有当前模型的 adapter（`NO_ADAPTER: raccoon`），整轮在**模型路由**那步就退出 —— 所以"刷完自动归档"一次都没成功过。这就是为什么要 B 兜底。

## 配置：库放在哪个文件夹

优先级从高到低：

1. **设置页里填的路径**（`$DSH_HOME/feiyu-kb.config.json`）
2. **bundle patch 里的 `config.root`**（`<DSH_HOME>/profiles/<p>/cordis.patch.yml` 或本包自带）
3. **环境变量 `FEIYU_KB_ROOT`**
4. **`$DSH_HOME/feiyu-kb.root`**（插件每次加载写下的"我实际在用哪"——让命令行和插件对齐）
5. **默认 `~/dsh-feiyu-kb`**

```bash
node lib/kb-cli.mjs where      # 命令行视角
# 或调 kb_status，返回的 root 就是插件视角
```

## 稳定性与自检

| 脚本 | 干什么 |
|---|---|
| `scripts/preflight.mjs [--profile <目录>]` | 包清单自洽（`dsh.client` 必须有 `./client` 出口等） |
| `scripts/compose-check.mjs` | **模拟一次启动**：按 bundles 顺序叠加 patch，查重复 id / 解析不到的包 |
| `scripts/selftest.mjs` | 41 条功能断言（隔离 `DSH_HOME`，不碰真库） |
| `scripts/doctor.mjs` | 体检：崩溃日志、profile 是否被回滚、包清单、知识库可读性 |
| `scripts/bench.mjs --big` | 规模基准（1k / 3k / 10k 条） |

插件内置**异常看门狗**：启动后 3 秒查一遍崩溃日志，之后每 10 分钟扫一次；发现新崩溃或 profile 被回滚就写报告到 `$DSH_HOME/diagnostics/`。

## 已知边界

- **启动期致命崩溃**里插件没机会加载，诊断只能等下一次成功启动补报（要覆盖"永远起不来"需要系统级计划任务）。
- 网页正文抽取是启发式：遇到结构奇怪的站点会抽歪，直接用 `kb_add` 手写更省事。
- 目录同步默认关；打开后只扫 `.md`，单次最多 20 篇。**它不会自己去别处找文件** —— 目录里没有 `.md` 就是空转（设置页会显示"扫了 0 个文件"并告警）。
- 相关推荐是**字面相似**，不是语义向量 —— 标签打得准，它才准。

## 卸载

```bash
node scripts/uninstall.mjs --yes              # 保留知识库数据
node scripts/uninstall.mjs --yes --purge-data # 连数据一起删
```

## QQ 通道：`POST /api/feiyu-chat`

把外部消息送进「大脑会话」，等她的回复再返回。和知识库/记忆库同在一个插件里，不额外起服务。

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"text":"你是谁呀","sessionId":"dsh-feiyu"}' \
  http://127.0.0.1:<dsh端口>/api/feiyu-chat
```

- 只接受本机同源请求（`sameOriginOk`）
- 先 `create` 会话 → `follow` 拿 cursor → `prompt(mode:'queue')` → 收 `assistant/message` 到 `turn/end`
- 用 `requestId` 认领自己的用户消息、锁定自己的 turn —— **并发不串台**
- 120 秒超时回「我在忙」；超时后若还没轮到，会把排队的 prompt 撤掉（不留幽灵回答）

## AstrBot 转发桥（`bridge/`）

QQ 那侧要一个最小插件把私聊转发进来。它跑在 AstrBot（Python）里，不能打进本包，所以源码放在
`bridge/astrbot_plugin_feiyu_bridge/` 随包发布：

```bash
node scripts/install-bridge.mjs                    # 部署到默认的 AstrBot 插件目录
ASTRBOT_PLUGINS=<目录> node scripts/install-bridge.mjs
```

部署后在 AstrBot 里重载插件，QQ 私聊发 `/鲸鲸 on`。它会**自动发现 DSH 端口**（每次重启都变），
并把每次转发记进 `data/feiyu_bridge.log`。

## 运维脚本

```bash
npm run verify:chat      # 通道验收：自动发现端口 + 并发不串台
npm run verify:brain     # 大脑验收：B站 轮次有没有落进 dsh-feiyu
npm run verify:observe   # 观察报告：轮次/来源/耗时/归档统计
npm run rollback -- --to p4 --yes     # 一键回滚（--to orig 全撤）
```

## 许可

MIT

# dsh-feiyu-kb

> DSH 插件：把本地一个**纯 Markdown 的知识库**，变成 DSH 里**任何模型运行时**都能调用的工具。

▶ **[88 秒介绍片](https://github.com/koishi-fumo-code/dsh-feiyu-kb/releases/download/v0.3.1/dsh-feiyu-kb-intro.mp4)** · [封面](https://github.com/koishi-fumo-code/dsh-feiyu-kb/releases/download/v0.3.1/poster.png)

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

## 你会得到什么（8 只工具）

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

工具定义有固定 token 开销（每轮请求都要带），所以描述是**给模型看的路标**，不是说明书 —— 目前 8 只合计约 3.4k 字符（≈1k token）。

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

把这份约定放到刷视频插件的会话工作目录 `~/.dsh/whale-work/AGENTS.md`，DSH 每轮会注入给被唤醒的 agent：

```markdown
# 刷视频这一轮的额外约定
每轮挑中有知识含量的视频后，调用 kb_add 归档：title / bvid / up / tags / summary / points；
要点必须是字幕里真读到的，读不到就只写 summary。归档完再调 kb_related 看看库里的旧笔记。
```

这是**指令注入**，不碰插件代码、不改人设 —— 而且它唤醒的 agent 本来就能调 `kb_add`。

**B. 目录同步（兜底）**

设置页开关打开即可。上游跑没跑成都不影响：只要笔记落了盘，10 分钟内就会被收进来。

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
- 目录同步默认关；打开后只扫 `.md`，单次最多 20 篇。
- 相关推荐是**字面相似**，不是语义向量 —— 标签打得准，它才准。

## 卸载

```bash
node scripts/uninstall.mjs --yes              # 保留知识库数据
node scripts/uninstall.mjs --yes --purge-data # 连数据一起删
```

## 许可

MIT

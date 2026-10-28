# dsh-feiyu-kb

把本地一个 **纯 Markdown 的知识库**，变成 DSH 里**所有模型运行时**都能调用的工具：搜索、读全文、写入、找相关旧条目、重建索引。

**知识从哪来**：不依赖任何特定插件 —— 网页、本地文件、整个目录、RSS 订阅、随手一段话，都能收进来（见「进料通道」）。

没有数据库、没有向量库 —— 一份资料一个 `.md` 文件。删了索引能重建，拷走目录就搬家，`grep` 也能搜。

```
kb_ingest   收外部东西：from=url | file | dir | feed
kb_capture  随手记一段文本（聊天 / 书 / 会议）
kb_add      手工新增或更新（判重键 BV 号 / url；合并式更新）
kb_search   搜（标题 / UP / 标签 / 正文，多词 AND；不给词 = 列最近）
kb_related  找同主题的旧条目（标签加权 + 中文二字组 + 英文/型号词），每条给理由
kb_read     读一篇全文（id / BV号 / 相对路径）
kb_index    重建 INDEX.md / index.jsonl / .kb/meta.json
kb_status   多少条、按来源 / 类型 / 档位分布、最近几条、标签排行
```

## 进料通道（2026-10-28 加）

之前知识只有一个来源——「刷B站」插件每轮归档。插件一停、B站一断，库就饿死。现在补齐了**不依赖任何插件**的通道：

| 通道 | 命令 / 参数 | 说明 |
|---|---|---|
| **网页** | `kb_ingest from=url url=…` | 抓正文、抽标题、摘要点；只 http/https，**不抓内网 / 本机**（SSRF 防护），单页上限 5MB |
| **本地文件** | `kb_ingest from=file path=…` | `.md` / `.txt` / `.json` / 代码等文本；标题取第一个 `# 标题` |
| **整个目录** | `kb_ingest from=dir dir=… ext=.md` | 批量导入，一篇一个条目，单条失败不影响整批 |
| **RSS / Atom** | `kb_ingest from=feed url=… limit=10` | 每条收一条，默认 `status: 待看` |
| **随手一段** | `kb_capture text="…"` | 自动起标题（第一句）、抽要点，标 `via: note` |

```bash
# 命令行等价物
node lib/kb-cli.mjs ingest --from url  --url https://example.com/post --tags 阅读
node lib/kb-cli.mjs ingest --from file --path ./notes/raft.md --tags 分布式
node lib/kb-cli.mjs ingest --from dir  --dir ./notes --ext .md
node lib/kb-cli.mjs ingest --from feed --url https://example.com/atom.xml --limit 5
node lib/kb-cli.mjs capture --text "今天学到：KV Cache 量化能把显存压到一半，代价是精度。"
```

⚠️ **要点是"如实摘"，不是模型总结**：优先小标题、列表项、正文句子；抽不出来就只留一句话，绝不编。
⚠️ 抓网页时会自动跳过导航条 / 目录 / 日期作者那类元信息，但**不同站点的页面结构差别很大**，遇到抽歪的，直接用 `kb_add` 手写一条更省事。

## 为什么是文件

- **任何运行时都能用**：有插件时调工具；只有 bash 时用 `lib/kb-cli.mjs`；什么都没有就直接读写 `.md`。
- **零依赖**：不 require 任何 `@deepseek-ai/*` —— 桌面 profile 是 `autoInstallPeers: false`，裸 import peer 会让整条插件不激活。
- **可读可改可 git**：知识不是黑盒向量，出问题能一眼看见。

## 目录结构

```
<root>/
├── entries/<年>/<月>/<日期>-<BV号>.md   一篇一个文件（YAML front-matter + Markdown）
├── INDEX.md                            人看的索引（自动生成，别手改）
├── index.jsonl                         机器看的索引（自动生成）
└── .kb/meta.json                       统计 + plugin.log（自动生成）
```

一条的样子：

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
kind: "知识"        # 知识 | 有意思
tier: "值得看"       # 值得看 | 可以看 | 不值当
status: "待看"       # 待看 | 已看 | 略过
tags: ["推理", "KVCache"]
---

# 标题

## 一句话
…
## 要点
- …
```

## 安装

**方式 A：克隆仓库**

```bash
git clone https://github.com/koishi-fumo-code/dsh-feiyu-kb.git
node dsh-feiyu-kb/scripts/install.mjs --root "/你的/知识库目录"
```

**方式 B：用 Release 里的 tgz**（离线 / 内网 / 不想 git）

```bash
curl -L -o dsh-feiyu-kb.tgz \
  https://github.com/koishi-fumo-code/dsh-feiyu-kb/releases/download/v0.1.0/dsh-feiyu-kb-0.1.0.tgz
tar -xzf dsh-feiyu-kb.tgz && mv package dsh-feiyu-kb
node dsh-feiyu-kb/scripts/install.mjs --root "/你的/知识库目录"
```

`install.mjs` 做三件事（幂等，可重复跑）：

1. 建知识库目录骨架；
2. 把本包链接进 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-feiyu-kb`；
3. 往 profile 的 `package.json` 写 `dependencies["dsh-feiyu-kb"] = "link:<本目录>"`，并加进 `dsh.profile.bundles`。

然后**重启一次 DSH**（bundles 是启动时组合的）。默认 `--profiles desktop,headless`，只装一个就写 `--profiles desktop`。

### 为什么入口写在插件包内

本包自带的 `cordis.patch.yml` 里既有 `insert`（挂载）也有 `config.root`（库位置）。**不要**把这段抄进 profile 自己的 `cordis.patch.yml`：

- 插件管理器的卸载只清理「它自己写的行」和「包自带 patch 里的行」；
- 只要用户 patch 里还有一条 `insert` 引用本包，卸载会被直接拒绝（「市场不会自动改写用户补丁」）。

入口留在包内，卸载才是零残留。

## 卸载

插件库里点「卸载」即可（依赖、bundle 名、包内入口一起消失）。没有界面或界面不认时：

```bash
node scripts/uninstall.mjs --yes                # 保留知识库数据
node scripts/uninstall.mjs --yes --purge-data   # 连数据一起删
```

## 命令行

没有工具的运行时可走 CLI，也可以在终端自己用：

```bash
node lib/kb-cli.mjs status
node lib/kb-cli.mjs search "KVCache 推理" --limit 5
node lib/kb-cli.mjs related --text "KV Cache 量化" --tags 推理,KVCache
node lib/kb-cli.mjs read --bvid BV1Mxn26eEh5
node lib/kb-cli.mjs add --json '{"title":"…","bvid":"BV…","tier":"可以看","tags":"a,b","summary":"…","points":"要点1\n要点2"}'
node lib/kb-cli.mjs index
```

## 相关推荐怎么算

不引模型、不联网，毫秒级：

| 信号 | 权重 | 说明 |
|---|---|---|
| 标签重合 | 5 / 个（封顶 3 个） | 最强信号 —— 归档时打好 3~6 个标签最划算 |
| 英文 / 型号词重合 | 3 / 个（封顶 3 个） | `KVCache`、`DeepInfer` 这类 |
| 中文二字组重合率 | 6 × 比例 | 标题 + 正文切二字组，去掉「视频 / 教程 / 合集」这类虚词 |

低于阈值（默认 3 分）不返回 —— **宁可空着，也不硬凑「相关」**。每条结果都带 `why`，方便判断真伪。

## 配置：库放在哪个文件夹

优先级从高到低：

1. **bundle patch 里的 `config.root`** —— profile 层可改（`<DSH_HOME>/profiles/<p>/cordis.patch.yml` 里 `- id: feiyu-kb` 那段，或改本包自带的 `cordis.patch.yml`）；
2. **环境变量 `FEIYU_KB_ROOT`**；
3. **插件记下的生效路径** `$DSH_HOME/feiyu-kb.root`（插件每次加载会把自己实际用的路径写进去）；
4. **默认 `~/dsh-feiyu-kb`**（Windows 上就是 `C:\Users\<你>\dsh-feiyu-kb`）。

第 3 条是为了让**命令行和插件用同一个库**：`kb-cli.mjs` 看不到 profile 配置，只能靠这个备忘文件对齐。不然配置里换过库位置的人，一用 CLI 兜底就会写进第二个库，知识被劈成两半。

怎么确认当前用的是哪个库：

```bash
node lib/kb-cli.mjs where     # 命令行视角
# 或在 DSH 里调 kb_status，返回的 root 就是插件视角
```

## 和「刷B站」联动（可选）

配合 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)：在它的值班章程里加一步 ——「每轮把挑中的有用视频用 `kb_add` 归档，再调 `kb_related` 把同主题的旧笔记写进报告」。这样新视频进来时，三个月前那条同主题的笔记会重新浮上来。

## 开发

```bash
node scripts/selftest.mjs   # 32 条断言：注册 / 落盘 / 判重 / 搜索 / 越权路径 / 索引 / 相关推荐 / 进料通道
```

| 文件 | 作用 |
|---|---|
| `index.js` | DSH 插件入口：注册 8 只工具，`apply` 绝不抛异常 |
| `lib/kb.mjs` | 知识库本体：写入、合并更新、搜索、相关推荐、索引 |
| `lib/ingest.mjs` | 进料：抓网页、HTML→文本、抽要点、RSS 解析、文件 / 目录读取 |
| `lib/kb-cli.mjs` | 命令行入口 |
| `scripts/install.mjs` | 装：链接 + 依赖 + bundle 登记（幂等） |
| `scripts/uninstall.mjs` | 卸：清依赖 / bundle 名 / 链接 / 历史 patch 行，默认保留数据 |
| `scripts/selftest.mjs` | 不启动 DSH 也能跑的自测 |

## 许可

MIT

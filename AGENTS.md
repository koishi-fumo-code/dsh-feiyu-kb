# dsh-feiyu-kb · 开发约定

> 给以后改这个插件的人（或 AI）。**发版前必须读完第 3 节。**
> 上层还有一份工作区级的 `../../AGENTS.md`（在 DSH 工作区里），讲的是"别乱动生产 profile"。

## 1. 这个插件是怎么接进 DSH 的

```
package.json
├── exports["."]        → index.js        宿主半端：注册 8 只工具
├── exports["./client"] → client.js       浏览器半端：设置页（⚠️ 见第 2 节第 1 条）
└── dsh.bundle.patch    → cordis.patch.yml 挂载声明（insert 一条 id: feiyu-kb）
```

profile 那边 `dsh.profile.bundles` 登记包名即可；**不要**再把 insert 抄进 profile 的
`cordis.patch.yml`（重复挂载，而且会让卸载卸不干净）。

## 2. 会崩机的清单问题（每条都真实发生过）

| # | 规则 | 违反的后果 |
|---|---|---|
| 1 | 声明 `dsh.client` ⇒ **必须**有 `exports["./client"]` 且文件存在 | **整个 DSH 启动失败**：client-modules（必需插件）抛 `declares dsh.client but exports no "./client bundle"`，连崩三次后应用把 profile 回滚成最小配置，使用者所有插件消失 |
| 2 | `dsh.bundle.patch` 必须是合法 YAML 数组 | profile 起不来 |
| 3 | 往 profile 的 `cordis.patch.yml` 追加入口前，先删掉 `[]` 占位行 | `[]` 后跟 `- insert:` = YAML 非法 |
| 4 | `inject` 只放"缺了也能用"的服务；可选服务用 `ctx.inject([...], cb)` 运行时注入 | 写进 `inject` 而环境没有该服务（headless 没有 `webServer`）⇒ 整条插件不激活、工具全没 |
| 5 | 同一条目 id 不能既由 bundle patch insert、又由 profile patch insert | 重复挂载 / 冲突 |

第 1 条对应的就是 `v0.3.0`：那个版本发出去后，安装即崩。现在由 `scripts/preflight.mjs` 兜住。

## 3. 发版前检查单（顺序别换）

```bash
node scripts/preflight.mjs                                  # 包清单自洽（秒级）
node scripts/preflight.mjs --profile ~/.dsh/profiles/desktop # profile 一致性
node scripts/selftest.mjs                                   # 38 条功能断言
node scripts/bench.mjs                                      # 可选：性能没退化
pnpm pack                                                   # 出 tgz
gh release create vX.Y.Z ... dsh-feiyu-kb-X.Y.Z.tgz
```

- 三项检查有任何 FAIL：**不要** pack，不要重启 DSH。
- 已经发出去的版本如果有启动级 bug：**删 release + 删 tag**（`gh release delete vX.Y.Z --yes --cleanup-tag`），别只写"请勿使用"。
- `package.json` 的 `files` 里漏了文件 = npm 包里没有它，装上就报错。`preflight` 会查 `client.js`。

## 4. 数据安全

- **自测必须隔离 `DSH_HOME`**：`scripts/selftest.mjs` 已在 `apply()` 之前把 `DSH_HOME` 指到临时目录。改这段之前想清楚——不隔离会把测试条目写进使用者的真库（真发生过，误写 4 条）。
- 库位置（`config.root`）优先级：**设置页 > bundle patch > `FEIYU_KB_ROOT` > 备忘文件 `$DSH_HOME/feiyu-kb.root` > `~/dsh-feiyu-kb`**。
- 改含中文的路径值，**用 Node 的 `fetch` 调接口**，不要用 shell 传参：Windows bash 走 GBK，中文会变乱码，插件会真的把库切到 `D:/dsh??????/???`（真发生过）。

## 5. 崩溃后怎么查

```powershell
ls "$env:APPDATA\@deepseek-ai\dsh-desktop\logs\crash-*.log" | sort LastWriteTime -desc | select -first 3
```

**先看有没有自动体检报告**（看门狗会在下次启动时写，比手动翻日志快）：

```bash
ls ~/.dsh/diagnostics/          # 最新一份就是
node scripts/doctor.mjs         # 或者立刻再体检一次
```

读 `phase: startup` + 第一条 `--- error ---`。启动期错误基本都在第 2 节那张表里。
恢复顺序：**修插件 → 恢复 profile 的 `bundles` → 恢复 `cordis.patch.yml`**（回滚常会把 `ui-settings` 关成 `enabled: false`，设置页会打不开）。

## 6. 架构速查

| 文件 | 责任 |
|---|---|
| `index.js` | 注册工具；`apply()` 绝不抛异常；路由用 `ctx.inject(['webServer'])` 挂 |
| `client.js` | 设置页（`__ModuleLoader__.load` 自注册 + `slots.inject('settings.section')`） |
| `lib/kb.mjs` | 存储：写入 / 合并更新 / 搜索 / 相关推荐 / 索引 / 列表缓存 |
| `lib/ingest.mjs` | 进料：抓网页、HTML→文本、抽要点、RSS、文件 / 目录 |
| `lib/config.mjs` | 设置页那三项（root + 两个工具开关），存 `$DSH_HOME/feiyu-kb.config.json` |
| `scripts/preflight.mjs` | 包清单 / profile 一致性检查 |
| `scripts/selftest.mjs` | 38 条功能断言（隔离 DSH_HOME） |
| `scripts/bench.mjs` | 规模基准（`--big` 跑 1k/3k/10k） |

性能约束：列表有 30s TTL 缓存、写入走增量索引；`kb_index` 才是全量重建。改 `listEntries` / `rebuildIndex` 之后跑 `bench.mjs` 对比。

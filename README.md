# dsh-rimlist

在 DeepSeek Harness 里管理 RimWorld mod。它是一个"RimSort 式"的双栏加载顺序管理器，带规则库排序、诊断、游戏日志分析、Mod 更新日志 / 备份回滚 / Git 安装，以及 22 个 AI 工具。mod 列表可以和其他玩家互相分享。

入口在 DSH **右侧栏的 RimWorld Mods 标签**。

## 界面

| 位置 | 内容 |
| --- | --- |
| 顶栏 | ⇅ 排序 · ↻ 刷新 · ▶ 启动游戏 · 📄 日志 · ⚙ 设置 · 保存到游戏 |
| 左栏 | 未启用的 mod（搜索，按 全部 / 工坊 / 本地 / 官方 筛选） |
| 中栏 | 已启用的 mod，也就是当前加载顺序 |
| 右栏 | 详情 · 诊断 · 列表 · 规则 · 版本（带数量角标），以及日志、设置。只有当前标签显示文字，其他只显示图标 |

侧栏较窄时会自动切换成单栏，用顶部的「未启用 / 已启用 / 面板」按钮切换视图。

## 功能

### 加载顺序
- **扫描**：覆盖 Core / DLC、本地 `Mods/` 和 Steam 创意工坊（含多个 Steam 库）。
- **拖拽排序**：
  - 可以在两栏之间互相拖动，也可以多选（Ctrl / Shift）。
  - 支持置顶 / 置底。快捷键：`↑`/`↓` 选择（`Shift` 多选，`Home`/`End`/`PageUp`/`PageDown` 跳转），`Alt+↑`/`Alt+↓` 上下移动已启用的 Mod，`Delete` 停用，`Enter` 启用，`Ctrl+S` 保存。
- **详情**：大预览图（点击放大）、作者、版本、依赖、规则、工坊链接。

### 排序
点一次「⇅ 排序」即可。约束来源的优先级从高到低是：

**强制（forceLoad + 官方 DLC 顺序）> 自定义规则 > About.xml > 社区规则 > modDependencies > 最低优先级**

最低优先级决定"没有任何规则约束的 mod 之间怎么排"。在 ⚙ 设置 → 排序 里选择：

| 模式 | 说明 |
| --- | --- |
| 按名称（默认） | 按优先级排序，同等情况下按字母排（数字按自然顺序，Mod 9 在 Mod 10 前） |
| 保持当前顺序 | 只移动必须移动的 mod |
| RimSort 兼容 | 完整复刻 RimSort 的 Topological 算法：分层（Core/Harmony → 13 个内置框架 → 普通 → loadBottom），每层逐级拓扑，同级按名称排 |

遇到规则冲突（环）时，RimSort 会直接拒绝排序；这里会丢掉优先级最低的那条规则，然后在诊断里报告。

### 规则库（和 RimSort 用同样的五个，来源可配置）
每个库可以选：不使用 / GitHub / 任意 URL（raw、.gz 或仓库 .zip）/ 本地文件。本地文件可以直接指向已安装 RimSort 的 `~/.local/share/RimSort/dbs/…`。

- [RimSort/Community-Rules-Database](https://github.com/RimSort/Community-Rules-Database)：loadAfter / loadBefore / loadTop / loadBottom / incompatibleWith
- [RimSort/Steam-Workshop-Database](https://github.com/RimSort/Steam-Workshop-Database)：工坊页上声明的依赖、名称、版本
- [emipa606/NoVersionWarning](https://github.com/emipa606/NoVersionWarning)：没标注当前版本、但确认可用的 mod
- [emipa606/UseThisInstead](https://github.com/emipa606/UseThisInstead)：停更 mod 的接替版本，诊断里可以一键跳转
- [bukforks/rimworld-versions](https://github.com/bukforks/rimworld-versions)：RimWorld 版本历史

下载后缓存在 `~/.dsh/rimlist/db/`，默认 7 天刷新一次，离线时继续用缓存。

### 自定义规则（优先级高于社区库）
社区库对新 mod、小众 mod 的规则经常缺失或出错，可以在这里补上：
- **固定当前顺序**：在已启用栏多选几个 mod，把它们当前的相对顺序一键保存成规则，以后排序都会保持这个顺序。
- **忽略不兼容**：诊断里遇到误报的"不兼容"，可以一键忽略（存为 `ignoreIncompatible` 规则）。
- 手动添加 loadAfter / loadBefore / incompatibleWith / loadTop / loadBottom。
- 导入 / 导出 RimSort 格式的 `userRules.json`。
- 每条规则都标明来源（自定义 / 社区 / About.xml），覆盖社区规则时会提示。

### 诊断
- 依赖缺失或未启用：可以一键启用，或跳转到 Steam 订阅。
- 版本不匹配（会参考 NoVersionWarning）、不兼容、顺序违规、重复安装。
- 有接替版本可用时会提示（UseThisInstead）。

### 列表（和其他玩家分享）
- 保存为命名列表。
- 导入：支持粘贴、URL（GitHub raw / Gist / rentry / pastebin）、文件。格式包括 rimlist JSON、`ModsConfig.xml`、纯 packageId、Markdown 表格、工坊链接和 RimSort 导出的文本。
- 导出：rimlist JSON、`ModsConfig.xml`（兼容 RimSort / RimPy）、packageId、Markdown。
- 可以和当前顺序对比，以替换或合并的方式应用。

### 启动游戏
- 点 ▶ 按钮启动，默认启动前自动保存。
- 在 ⚙ 设置 → 启动游戏 里选择启动方式：
  - **Steam**：`steam://rungameid/294100`，或填 Steam 路径，用 `-applaunch` 传参。
  - **直接运行**：自动找 `RimWorldLinux` / `RimWorldWin64.exe` / `RimWorldMac.app`。
  - **自定义程序**：任意命令，例如 flatpak、Proton、脚本。
- 可以附加游戏参数，也能预览实际执行的命令。

### 游戏日志
- 点 📄 日志 打开 `Player.log` 查看器。游戏写入新日志时自动刷新（每 3 秒检查一次）。
- 过滤掉 Unity 噪音；相同报错合并显示为 `×次数`，例如 95 条 KyberCrystal 只显示一条。
- 每条报错旁标出相关 mod，点击跳转到该 mod。可以展开堆栈，按关键字筛选，也能查看上一次运行的日志。
- **发给 AI 分析**：把去重后的摘要放进对话输入框。如果插入失败就复制到剪贴板，之后粘贴即可。

### Mod 更新日志、备份与回滚
Steam 创意工坊**不能回退版本**：作者一更新，旧版本就被覆盖了。右栏「版本」标签和每个 mod 详情里的「更新日志 & Mod 备份」解决这个问题：
- **最近更新**：按 1 / 7 / 30 / 90 天列出更新过的 mod（数据来自 Steam 的 `appworkshop_294100.acf`，安装 RimList 之前的更新也查得到），展开即可看更新说明。Steam 还没下载完的更新会标成「待更新」。
- **更新日志**：工坊 mod 从 Steam 更新日志页抓取并缓存，标出「当前已安装」和「比你新」的版本；git mod 显示提交记录。
- **备份**：把整个 mod 文件夹复制到 `~/.dsh/rimlist/modbackups/`，同一版本只存一份，每个 mod 默认保留 3 份。可以手动备份，也可以一键备份所有已启用的工坊 mod，或者开启**自动备份**（每次扫描都把当前版本存一份）。
- **回滚**：把备份装进本地 `Mods/`，文件夹名为 `<原名>_rimlist_<版本>`。RimWorld 对同一个 packageId 会优先加载本地副本，所以之后 Steam 再更新也不会影响它。想回到工坊版本时，点「移除本地副本」（删除前会再自动备份一次）。

### 从 Git 安装 / 更新 Mod
- 「版本 → Git」：输入 `https://github.com/owner/repo`、ssh 地址，或者只写 `owner/repo`，可选分支，会 clone 到本地 `Mods/`，可选装完立即启用。
- **检查更新**：`git fetch` 后显示落后几个提交以及每个提交的说明。点 **git pull**（`--ff-only`）更新，更新前自动备份，更新出问题可以回滚。
- 只接受 http(s) / ssh / git 地址，拒绝本地路径和以 `-` 开头的参数（防止参数注入）。需要本机已安装 `git`。

### Mod 类型检查（AI 标签）
- 在 mod 详情里点击「检查类型」。程序会读取 `About.xml` 描述、Defs、Patches、Languages、贴图、LoadFolders 以及 DLL/Harmony 补丁目标，然后给出分类。
- 输出不止一个标签：`primary_type`（只能有一个）+ `secondary_types` + `feature_tags`，另外还有 `display_tags_zh`、`is_content_mod / is_library / is_patch / is_translation`、`confidence`、`evidence`。
- 类型有：`content` 内容、`library` 前置/框架、`patch` 补丁/兼容、`translation` 翻译、`performance` 性能、`ui` 界面、`qol` 生活改善、`utility` 工具。
- 依据优先引用原文短句；文件结构也会作为证据，例如「Patches: 22 个 PatchOperation」「Harmony 补丁原版界面: FloatMenu…」。
- 自动结果按 mod 版本缓存在 `~/.dsh/rimlist/modTags.json`。AI 复核后可以用 `rimlist_classify_save_ai` 保存校正，界面会显示「AI 已校正」。
- 两栏搜索框旁有「按标签筛选」下拉；详情页「✎ 编辑标签」可增删标签（显示「手动标签」，「↺ 恢复自动」可撤销）。

### 安全写入
- 每次保存前，先把 `ModsConfig.xml` 备份到 `~/.dsh/rimlist/backups/`。可以在设置里一键恢复。
- packageId 一律写成**小写**。RimWorld 在这里区分大小写，混用大小写会导致游戏里同一个 mod 同时出现在两栏、显示为灰色，并且实际不生效。

## AI 工具

在对话里直接说，例如"帮我排序并修复缺失依赖"、"看看游戏日志为什么报红"、"昨天更新了哪些 mod，把 XX 回滚到上个版本"，AI 会自动调用下面的工具：

| 工具 | 作用 |
| --- | --- |
| `rimlist_status` | 总览：游戏版本、路径、mod 数、规则库状态、诊断摘要 |
| `rimlist_active` | 当前加载顺序 |
| `rimlist_search` | 按名称 / packageId / 作者 / 工坊 ID 搜索已安装的 mod；也能按类型（`type`、`primaryOnly`）、标签（`tags`，英文 feature tag 或中文标签都行，必须全部命中）和最低可信度（`minConfidence`）筛选 |
| `rimlist_mod` | 单个 mod 的完整信息（依赖、规则、Steam 数据） |
| `rimlist_diagnose` | 检查加载顺序的问题 |
| `rimlist_sort` | 计算排序结果（`tieBreak`: name / current / rimsort），`save=true` 时写入游戏 |
| `rimlist_explain` | 解释某个 mod 为什么在这个位置（每条约束及其来源） |
| `rimlist_set_active` | 启用 / 停用 / 移动 / 整体替换 |
| `rimlist_rule` | 添加 / 删除自定义规则（含 ignoreIncompatible） |
| `rimlist_pin_order` | 把几个 mod 的当前顺序固定为规则 |
| `rimlist_databases` | 查看 / 配置 / 刷新五个规则库 |
| `rimlist_lists` | 管理已保存的列表（保存 / 应用 / 对比 / 导出 / 删除） |
| `rimlist_import` | 从文本或 URL 导入别人的 mod 列表 |
| `rimlist_rescan` | 订阅或退订后重新扫描，可选强制刷新规则库 |
| `rimlist_launch` | 启动游戏，或预览启动命令 |
| `rimlist_game_log` | 读取 Player.log 摘要（去重、计数、关联 mod），用于排查红字 |
| `rimlist_mod_updates` | 最近更新了哪些 mod，以及单个 mod 的工坊更新日志 / git 提交记录 |
| `rimlist_mod_backup` | 备份 / 列出备份 / 回滚到旧版 / 移除本地副本 / 删除备份 |
| `rimlist_git` | 从 git 安装 mod、检查更新、git pull |
| `rimlist_classify` | 检查单个 mod 的类型：主类型、副类型、功能标签、可信度、原文依据 |
| `rimlist_classify_all` | 批量分类全部 / 已启用的 mod（按版本缓存） |
| `rimlist_classify_save_ai` | 保存 AI 复核后的分类，覆盖自动结果 |
| `rimlist_set_tags` | 手动设置 Mod 的显示标签（`reset=true` 恢复自动） |
| `rimlist_tag_review` | 让 AI 分批检查标签：当前标签 + 描述 + 文件信号（filter=auto/low/reviewed/all） |
| `rimlist_reset_tags` | 把全部（或指定）手动 / AI 标签恢复成自动结果 |
| `rimlist_game` | 查看游戏是否在运行 / 关闭游戏（force=true 强制结束） |

## 平台支持

支持 Linux、Windows 和 macOS，会自动探测：
- Steam 库：包括 `libraryfolders.vdf` 里的额外库，以及 Linux 的 Flatpak / Snap 版 Steam。
- 创意工坊目录。
- `ModsConfig.xml` 和 `Player.log` 的位置：
  - Linux：`~/.config/unity3d/Ludeon Studios/…`
  - Windows：`%USERPROFILE%\AppData\LocalLow\Ludeon Studios\…`
  - macOS：`~/Library/Application Support/RimWorld/Config`，日志在 `~/Library/Logs/…`

探测不到时，可以在设置里手动指定路径。

## 安装

在 DSH profile（如 `~/.dsh/profiles/desktop/package.json`）里加入依赖和 bundle：

```json
{
  "dependencies": { "dsh-rimlist": "file:/path/to/rimlist" },
  "dsh": { "profile": { "bundles": ["dsh-rimlist"] } }
}
```

然后在 profile 目录执行 `pnpm install`，再重启 DSH。

> 注意：`file:` 依赖是**复制**过去的，不是软链接。修改源码后需要重新同步到 profile 的 `node_modules/dsh-rimlist`，或者重新执行 `pnpm install`。
> 只改了前端（`src/client`）时，构建后刷新页面就能生效；改了宿主端（`index.js`、`src/host`）则必须重启 DSH。

## 开发

```bash
npm_config_cache=$PWD/.npm-cache npm install
npm run build                 # 打包 src/client → lib/client.js（--no-minify 便于调试）
npm test                      # node --test，28 个测试
node scripts/dev-server.mjs   # http://127.0.0.1:4777/dev 独立调试（数据目录 .tmp-home/rimlist）
```

调试页支持点击探针：`/dev?clicks=tab:<按钮 title>,text:<按钮文字前缀>,row:<mod 名>,click:<CSS 选择器>,measure:<CSS 选择器>`。执行结果写在页面的 `<pre id="probe">` 里，方便配合无头浏览器做自动检查。

## 目录结构

```text
index.js              宿主插件入口：HTTP 接口 POST /api/rimlist + 19 个 AI 工具
src/host/
  service.js          所有业务方法（扫描、排序、写入、列表、规则、启动、日志）
  sorter.js           排序与诊断（优先级排序 + RimSort Topological 复刻）
  rules.js            五个规则库 + 自定义规则
  scan.js / xml.js    扫描 mod、解析 About.xml / ModsConfig.xml
  paths.js            三平台路径探测
  launch.js           启动游戏
  gamelog.js          Player.log 解析、去重、mod 归因、摘要
  modversions.js      工坊 acf / 更新日志抓取、mod 备份与回滚、git 安装与更新
  classify.js         mod 类型分类：结构扫描、规则打分、证据、AI 校正存储
  lists.js            列表存储、导入导出
  archive.js          无依赖的 gzip / zip 读取
src/client/           React 前端（右侧栏标签）
```

## 数据目录

位于 `$DSH_HOME/rimlist/`（默认 `~/.dsh/rimlist/`）：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 路径、规则库来源、排序模式、启动方式、自动备份 |
| `userRules.json` | 自定义规则（RimSort 格式） |
| `lists/*.json` | 已保存的列表 |
| `db/` | 规则库缓存 |
| `backups/` | `ModsConfig.xml` 的历史备份 |
| `modbackups/` | mod 文件夹快照（用于回滚） |
| `modHistory.json` | 每个 mod 的版本记录（用于本地 / git mod 的更新历史） |
| `changelogs/` | 工坊更新日志缓存 |

## 许可证

本项目以 [GNU GPL v3.0 或更高版本](LICENSE)（`GPL-3.0-or-later`）发布。

`src/host/sorter.js` 中的 `sortRimSort`（`tieBreak: 'rimsort'` 模式）移植自 [RimSort](https://github.com/RimSort/RimSort) 的 Topological 排序算法，RimSort 以 GPL-3.0 许可发布。规则库数据由各自的仓库在运行时下载，版权归原作者所有。

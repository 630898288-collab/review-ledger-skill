# review-ledger

市场部个人复盘台账 Skill：一个飞书多维表 + 一份可被任意 Agent 加载的操作契约。

把散落在飞书云文档、腾讯文档、在线 HTML 报告、本地文件、甚至一段聊天文字里的复盘，读完并结构化登记到同一张台账；之后可以用自然语言按项目/月份召回链接，或直接问「某项目某月复盘里提到的策略是什么」。

## 特点

- **不迁移原始资料**：只建索引与内容快照，原文件留在原地（很多复盘并不归属于你，没法搬）
- **安装位置无关**：不假设 `~/.workbuddy`，可装进 Claude Code / Cursor / Codex / WorkBuddy 等任意 Agent 的 skills 目录
- **多 Agent 共用**：同一张表、同一套字典、按「来源指纹」幂等登记，两个 Agent 登记同一份资料只出一条记录
- **双层自更新**：台账 select 枚举实时读取、新值自动沉淀；GitHub 包版本自动检查、用户确认后才升级
- **本地私有数据不进仓库**：base_token / table_id 只放 `ledger-config.local.json`，自更新永不覆盖它和 `state/*`

## 安装

```bash
# 查看探测到的候选 skills 目录
node scripts/install.mjs --list

# 装到指定 Agent（目标指 skills 根目录，会在其下创建 review-ledger/）
node scripts/install.mjs --dir ~/.claude/skills
node scripts/install.mjs --dir ~/.cursor/skills
node scripts/install.mjs --dir ~/.workbuddy/skills

# 或直接从 GitHub 拉包安装
node scripts/install.mjs --dir <目标skills目录> --from-github
```

安装后在 `references/ledger-config.local.json` 填自己的台账坐标：

```json
{
  "base_token": "...",
  "table_id": "...",
  "view_id": "...",
  "base_url": "https://xxx.feishu.cn/base/..."
}
```

也可以用环境变量 `REVIEW_LEDGER_BASE_TOKEN` / `REVIEW_LEDGER_TABLE_ID` / `REVIEW_LEDGER_VIEW_ID`。`lark-cli` 不在 PATH 时设置 `LARK_CLI_BIN=/path/to/lark-cli`。

## 用法（说人话即可）

- 「把这几份资料登记到复盘台账」+ 甩链接 / 文件 / 一段文字
- 「我要 I2 PRO 8 月的复盘」→ 返回链接
- 「I2 PRO 9 月复盘里提到的策略是什么」→ 查台账沉淀，必要时回源读原文

Agent 侧统一走 `scripts/ledger.mjs`，不要各自拼 `lark-cli` 命令：

```bash
node <skill_dir>/scripts/ledger.mjs health
node <skill_dir>/scripts/ledger.mjs find "I2 PRO 8月复盘"
node <skill_dir>/scripts/ledger.mjs get --record-id <id> --full
node <skill_dir>/scripts/ledger.mjs register --input cards.json
node <skill_dir>/scripts/ledger.mjs sync-dict            # 只报告枚举差异
node <skill_dir>/scripts/ledger.mjs sync-dict --apply    # 经用户确认后追加 select 选项
```

## 自更新

每次运行都会在输出的 `update` 字段里附带版本检查结果（12 小时缓存，网络失败静默降级）：

- `update.available === true`：Agent 必须先问用户，**不能自行更新**
- 用户同意 → `node <skill_dir>/scripts/ledger.mjs --self-update`
- 用户拒绝 → `--dismiss-update`，同版本不再打扰
- 用户主动要求升级时可直接 `--self-update`

更新只覆盖包内文件；`ledger-config.local.json`、`state/*`（候选值、登记日志）、`.env*` 与用户自建文件不会被删除或覆盖。项目别名会做本地/远端合并。

## 文件结构

```
SKILL.md                          Agent 操作契约（登记/召回/维护/安装）
references/
  ledger-config.json              公共模板（空坐标，进仓库）
  ledger-config.local.json        本机私有坐标（gitignore）
  table-schema.json               36 字段 schema，可据此重建表
  field-dictionary.md             字段口径 + 当前枚举（sync-dict 刷新）
  extraction-rules.md             原文 → 登记卡抽取规则
  source-readers.md               多载体只读读取 SOP
  project-aliases.json            项目别名归一化表（共享字典）
scripts/
  ledger.mjs                      统一 CLI：health/find/get/register/sync-dict
  update.mjs                      GitHub 版本检查与确认后自更新
  install.mjs                     安装到任意 Agent 的 skills 目录
state/                            本地状态（gitignore）
VERSION / CHANGELOG.md            包版本与变更记录
```

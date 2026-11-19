# 台账坐标与运行配置

> **唯一真源原则**：所有坐标只在本文件同目录的 `ledger-config.local.json` 里维护（该文件不进版本库、不被自更新覆盖）。SKILL.md、脚本、其他 references 一律不复制 `base_token` / `table_id`。换表时只改这一处，所有 Agent 下次运行即生效。
>
> 仓库里的 `ledger-config.json` 只是安装模板（空坐标），不含任何私有信息。安装到其他 Agent 时由 `scripts/install.mjs` 生成 local 文件并引导填写。

## 资源坐标（本机值见 ledger-config.local.json）

| 项 | 说明 |
|---|---|
| 多维表 | 市场部复盘台账 |
| 打开链接 / base_token / table_id | 见同目录 `ledger-config.local.json`，本公开包不收录 |
| 主视图 | `view_name = 检索视图`（按项目标准名分组、按周期起倒序） |
| 主字段 | 复盘标题 |
| 去重键 | 来源指纹 |
| 宽检索字段 | 检索键 |
| 时区 | Asia/Shanghai |
| 身份 | `--as user`（Martin 身份） |

配置优先级：`REVIEW_LEDGER_*` 环境变量 > `ledger-config.local.json` > `ledger-config.json` 模板。
`lark-cli` 查找顺序：`LARK_CLI_BIN` > 配置 `lark_cli_bin` > PATH > 常见用户级落点。

## 表结构

36 个字段，完整 schema 见 `table-schema.json`。该文件是**可重建依据**：`health` 命令会拿它跟线上字段逐项比对；误删字段时可据此恢复。

字段分 5 组：A 检索主键 / B 分类标签 / C 原文定位 / D 内容沉淀 / E 运维去重。口径见 `field-dictionary.md`。

## 权限现状（创建时读取，之后未改动）

- 以 Martin 身份创建，本人为 owner，天然可编辑
- 未添加任何协作者，因此**没有发出任何通知**
- 租户默认分享设置：`share_entity=anyone`、`security_entity=anyone_can_view`、`link_share_entity=closed`（链接不公开，需具备访问权限的人才能打开）
- 台账会登记他人/外部服务商的复盘资料，故**未主动开放链接分享**。若需要「组织内全员可阅读」，用 `lark-cli drive permission.public patch` 单独调整，别改数据

## 统一 CLI

所有读写走 `scripts/ledger.mjs`，脚本内部调用 `lark-cli`，不要各 Agent 自己拼命令。`<skill_dir>` 指本 Skill 的安装目录：

```bash
node <skill_dir>/scripts/ledger.mjs health
node <skill_dir>/scripts/ledger.mjs find "I2 PRO 8月复盘"
node <skill_dir>/scripts/ledger.mjs register --input /path/to/cards.json
node <skill_dir>/scripts/ledger.mjs sync-dict
node <skill_dir>/scripts/ledger.mjs sync-dict --apply
node <skill_dir>/scripts/ledger.mjs --check-update         # 只看版本检查结果
node <skill_dir>/scripts/ledger.mjs --self-update          # 用户同意后升级包
node <skill_dir>/scripts/ledger.mjs --dismiss-update       # 拒绝某版本后不再提示
```

安装到其他 Agent：`node <skill_dir>/scripts/install.mjs --list`，再 `--dir <目标skills目录>`。

## 自更新策略（重要）

| 层 | 是否自动 | 说明 |
|---|---|---|
| 台账数据 | **自动** | 所有 Agent 都按「来源指纹」upsert 到同一张表，天然共享、不会重复 |
| select 枚举读取 | **自动** | 每次登记前从线上字段实时读取选项，永远拿最新口径 |
| 本地共享字典 | **自动** | 新值写入 `state/candidates.json` 与 `project-aliases.json`，并刷新 `field-dictionary.md` |
| 包版本（GitHub） | **自动检查 / 确认后更新** | 每次运行输出 `update` 字段；12 小时缓存；用户同意后才 `--self-update`；本地配置与 `state/*` 永不覆盖 |
| 飞书 select 选项追加 | **需确认** | `+field-update` 属高风险写，只有 `sync-dict --apply` 且用户同意时才执行；默认把未知值落到「待确认」并勾「待人工确认」 |

这样分工的原因：枚举读取与字典沉淀零风险、可自动；改表结构与改包都不可逆性更高，留一道人工闸。

## 换表 / 重建

1. 新建多维表：用 `table-schema.json` 作为 `--fields` 传给 `lark-cli base +base-create`
2. 改 `ledger-config.local.json` 里的 `base_token` / `table_id` / `view_id`
3. 跑 `health` 确认字段齐全
4. 不需要改 SKILL.md，也不需要通知其他 Agent

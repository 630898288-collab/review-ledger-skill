# review-ledger 变更记录

维护规则：改动 `SKILL.md`、`scripts/ledger.mjs` 或任何 `references/` 下的规则文件后，把 `VERSION` 递增，并在此记一行。多个 Agent 共用同一份包，版本是排查「为什么两个 Agent 行为不一致」的第一线索。

## 1.1.1 — 2026-11-19

- 修复自更新时项目别名被覆盖的问题：本地别名必须在包文件覆盖**之前**读出并合并。

## 1.1.0 — 2026-11-19

- 新增 GitHub 包版本自更新：每次运行输出 `update` 字段，12 小时缓存、网络失败静默降级；用户确认后 `--self-update`，拒绝用 `--dismiss-update`。
- 自更新安全边界：跳过 `ledger-config.local.json`、`state/*`、`.env*`，项目别名做本地/远端合并，更新前自动备份。
- 安装位置无关：移除写死的 `~/.workbuddy` 路径与 lark-cli 绝对路径回退；新增 `scripts/install.mjs`，自动探测各 Agent skills 目录并支持 `--dir` / `--from-github`。
- 私有配置拆分：`ledger-config.json` 变为不含坐标的安装模板，真实坐标移至 gitignore 的 `ledger-config.local.json`；支持 `REVIEW_LEDGER_*` 与 `LARK_CLI_BIN` 环境变量。
- 新增 README.md 与 .gitignore，公开发布包不含台账 token。

## 1.0.0 — 2026-11-19

- 首版。创建飞书多维表「市场部复盘台账」（36 字段 / 检索视图）。
- 落地三大工作流：登记、链接召回、内容召回。
- 落地自更新：台账为唯一真源、select 枚举实时读取、本地字典自动沉淀候选值、`sync-dict --apply` 经确认后固化到表结构。
- 幂等登记：按「来源指纹」查重，重复资料不会产生第二条记录。
- 约束：不迁移、不改动原始复盘资料；飞书全程 `lark-cli --as user`。

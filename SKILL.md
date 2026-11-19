---
name: review-ledger
description: 市场部个人复盘台账（飞书多维表）。把飞书云文档、腾讯文档、在线 HTML 报告、本地文件或一段纯文字里的复盘，读完并结构化登记到台账；也支持反向召回——按项目/月份找复盘链接，或回源读原文回答「某项目某月复盘里提到的策略/结论/数据是什么」。触发词：登记复盘、把这个复盘记下来、收录复盘、补进台账、找 XX 项目 X 月的复盘、XX 复盘链接发我、XX 复盘里提到的策略、复盘台账、复盘库、查一下之前的复盘。多个 Agent 共用同一张台账与同一份字典，支持字典自更新。安装后每次运行自动检查 GitHub 上的新版本，有更新时先问用户、绝不自行覆盖。不用于创建/修改原始复盘资料，也不用于与复盘无关的知识检索。
agent_created: true
---

# 市场部复盘台账（登记 + 召回）

## 它是干什么的

用户手上有大量散落的复盘，载体五花八门、且很多**不归属于用户本人**，所以不能靠「建一个飞书文件夹把文件搬进去」来归集。本 Skill 的做法是：只建一张**索引台账**，登记每份复盘的结构化描述 + 原文位置 + 内容快照，原始资料留在原地不动。

对用户来说只有两句话的事：
- 「把这份资料登记一下」→ 自己看完、抽好、入库
- 「XX 项目 8 月复盘呢 / 里面提了什么策略」→ 查出来给链接，或读完给结论

## 核心原则

1. **台账是唯一真源**。所有 Agent 读写同一张飞书多维表，坐标只在 `references/ledger-config.json` 一处维护。禁止各自建表、禁止把 token 抄进别的文件。
2. **不迁移、不复制、不修改原始资料**。尤其「资料归属 = 他人/外部」的记录，只做只读引用。
3. **登记即沉淀**。一次读完原文，把结论/策略/数据/摘要留在台账里，内容召回就不依赖外部链接永远可打开。
4. **不确定就标待确认**。自动抽取不是最终判断，留人工闸。
5. **飞书全程 `lark-cli --as user`**。不用浏览器、不用其他飞书插件。

> **路径约定**：下文 `<skill_dir>` 指本 `SKILL.md` 所在的目录。这个 Skill 可以装在任意 Agent 的 skills 目录（WorkBuddy / Claude Code / Cursor / Codex / OpenCode 等），命令里的 `<skill_dir>` 一律用实际安装目录替换；脚本自身通过文件位置推导路径，不依赖固定安装点。

## 第零步：每次使用先做（别跳过）

```bash
node <skill_dir>/scripts/ledger.mjs health
```

`health` 会校验坐标、连通性、线上字段与 `table-schema.json` 是否一致，并**实时拉取所有 select 字段的当前选项**。这一步就是自更新的入口：任何 Agent 在任何时刻拿到的都是最新字典，不需要有人去同步配置。

**同一个输出里还有 `update` 字段**：脚本默认每 12 小时静默查一次 GitHub 上的新版本（网络失败自动略过，不打扰用户）。`update.available === true` 表示有新版本：

1. 先问用户：「检测到复盘台账 Skill 有新版本 `update.latestVersion`（当前 `update.currentVersion`），要现在更新吗？」
2. 用户明确同意 → 执行 `update.updateCommand`（已是本机可直接执行的绝对路径），成功后**重新执行原本的任务**
3. 用户拒绝 → 执行 `update.dismissCommand`，同一版本不再反复问，继续原任务
4. 用户主动说「更新一下复盘台账 Skill」时不用再问，直接执行 `--self-update`

**硬规则**：绝不擅自下载覆盖。自更新只覆盖包文件；`references/ledger-config.local.json`、`state/*`（候选值/登记日志）、`.env*` 等本地私有数据永不被覆盖。检查网络失败（`update.checked: false`）时什么也不用说，照常干活。

再按需读：
- 登记 → `references/field-dictionary.md` + `references/extraction-rules.md` + `references/source-readers.md`
- 召回 → `references/field-dictionary.md`（重点看「覆盖周期」与 D 组）

`health` 报错（连不上、字段缺失）时**先报告，不要带病写入**。

---

## 工作流 A：登记复盘

**触发**：「登记复盘」「把这个记进台账」「这几份资料收录一下」「补一下复盘台账」等。用户不说明资料格式是正常的，自己判断。

1. **收齐资料**。可能是一次给多个链接 / 多个本地文件 / 一段粘贴的文字 / 混合。逐个登记载体类型。
2. **读全文**。按 `references/source-readers.md` 选择读取方式。读不通就如实标 `可读状态`，**不要假装读过**；能读多少就登记多少，并在 `备注` 写清。
3. **抽成登记卡 JSON**。严格按 `references/extraction-rules.md` 的规则与格式。一份资料含多个复盘要拆条。
   - **提交人不用手工查**：留空即可，脚本会对飞书云文档自动解析作者（owner）填入，并注明来源；规则见 `references/source-readers.md` 第六节。用户明确指定「记为我」时按用户说的填。
4. **入库**：
   ```bash
   node <skill_dir>/scripts/ledger.mjs register --input /abs/path/cards.json
   ```
   脚本会自动：项目名归一化 → 生成「检索键」「来源指纹」→ 按指纹查重（重复则更新而非新增）→ 校验 select 选项（未知值降级为「待确认」并沉淀候选）→ 写入。
5. **回报**，用四句话：登记了几条 / 哪几条是重复更新 / 有哪些「待人工确认」项 / 台账链接。不要输出命令和技术细节。

**用户没给链接、只给了一段文字**：照常登记，`载体类型=纯文本段落`、`资料归属=未知`、`可读状态=仅本地`、`来源指纹` 用内容 hash。文字本身就是资料，不要反问「有没有链接」。

---

## 工作流 B：链接召回

**触发**：「我要 XX 项目 8 月的复盘」「XX 复盘链接发我」「之前那份投放复盘在哪」。

1. 从用户的话里抽出**项目 + 周期 + 可选的类型/平台/区域**。用户说「8 月」指的是 `覆盖周期`，不是 `复盘提交日期`。
2. 检索：
   ```bash
   node <skill_dir>/scripts/ledger.mjs find "XX 项目 8月" --limit 10
   ```
   脚本拉全表在本地加权打分（项目名/别名/覆盖周期/关键词/标题/检索键），比飞书的整串关键词搜索更适合「某某项目 8 月复盘」这类口语提问；也支持 `--project`、`--period` 精确收窄。
3. **返回规则**：
   - 命中 1 条 → 直接给「标题 + 链接 + 覆盖周期」，一句话
   - 命中多条 → 按相关度列 2–5 条，最贴合的放最前，不凑数
   - 没命中 → 换同义词/更宽的词再查一次（先查 `project-aliases.json`），仍无则如实说没找到，**绝不编造链接**
   - 链接可能是飞书文档、腾讯文档、在线 HTML 或本地路径；照实说明类型，本地路径就说「这是本地文件，路径是……」

---

## 工作流 C：内容召回

**触发**：「XX 项目 9 月复盘里提到的策略是什么」「那份复盘的结论/数据」「对比一下两次复盘」。

1. 先按工作流 B 命中记录，**拿到完整字段**（`get --record-id <id>` 或 `find --full`）。
2. **优先用台账 D 组沉淀内容**：`核心策略`、`一句话结论`、`关键数据`、`内容摘要`、`原文摘录`。这些是当时读全文留下的成果，比再次抓链接可靠。
3. **以下情况必须回源读原文**：台账内容不足以回答（问得很细、要原文语境）、`解析状态` 不是「已读全文」、用户明确要「看原文 / 逐条列」、`置信度 < 0.7`。回源按 `source-readers.md` 执行。
4. **回答要求**：
   - 结论在前，逐条列策略，标明来自哪条记录（项目 + 覆盖周期 + 链接）
   - 引用 `原文摘录` 时说明是原文
   - 依据不足时明确说「台账只留了摘要，未读到全文」，并给出链接让用户自己核，**不要用常识补**
   - 涉及「待人工确认」的记录，提示该条自动抽取结果待复核

---

## 工作流 D：字典自更新与维护

这是「多个 Agent 共用同一个 Skill」能成立的关键。

**自动发生（每次运行，无需人工）**
- `health` 实时拉取线上 select 选项 → 所有 Agent 用同一套最新口径
- 登记时遇到新项目别名 → 自动追加到 `references/project-aliases.json`（新项目会把卡片里的 `项目别名` 一并登记；命中已有项目时追加新别名，去重）；批量登记共用同一份字典、末尾统一写回，不会互相覆盖
- 登记时遇到字典里没有的枚举值 → 该条降级为「待确认」、原值写入 `备注`、勾「待人工确认」，同时把新值沉淀到 `state/candidates.json`
- 因此**新 BU、新平台、新项目会自己浮出来**，不需要改 SKILL.md

**需要人工确认（改表结构）**
```bash
node <skill_dir>/scripts/ledger.mjs sync-dict            # 只看差异报告
node <skill_dir>/scripts/ledger.mjs sync-dict --apply    # 固化新选项
```
执行 `--apply` **之前必须先向用户复述将新增的选项清单**，得到明确同意才运行。原因：`+field-update` 是高风险写、PUT 全量覆盖；脚本会先读完整字段定义再追加，但仍应留一道人工闸。用户说「嗯 / 看着办」不算同意。

`sync-dict` 还会用线上最新枚举刷新 `field-dictionary.md` 的「当前枚举」章节，并追加 `CHANGELOG.md`、递增 `VERSION`。

**字段漂移**：`health` 报缺字段时，用 `references/table-schema.json` 作为重建依据补字段，不要手工乱补。

---

## 安装到其他 Agent / 换机器

所有路径在运行时推导，包里没有写死的 `~/.workbuddy`。安装器会列出常见 Agent 的 skills 目录并复制到目标：

```bash
node <skill_dir>/scripts/install.mjs --list                    # 看候选目录
node <skill_dir>/scripts/install.mjs --dir ~/.claude/skills    # 装到 Claude Code
node <skill_dir>/scripts/install.mjs --dir ~/.cursor/skills    # 装到 Cursor
node <skill_dir>/scripts/install.mjs --dir <目标skills目录> --from-github   # 从 GitHub 拉取安装
```

安装后在目标的 `references/ledger-config.local.json` 填 `base_token` / `table_id` / `view_id`（或设 `REVIEW_LEDGER_BASE_TOKEN`、`REVIEW_LEDGER_TABLE_ID`、`REVIEW_LEDGER_VIEW_ID` 环境变量）；`lark-cli` 不在 PATH 时用 `LARK_CLI_BIN` 指定路径。本地私有配置不进版本库，也不被自更新覆盖。

## 多 Agent 共用约定

| 约束 | 原因 |
|---|---|
| 只改 `ledger-config.json` 换坐标，不改 SKILL.md | 单点修改即刻全员生效 |
| 所有写操作走 `ledger.mjs`，不各自拼 lark-cli | 保证归一化、去重、降级规则一致 |
| 按「来源指纹」upsert，禁止无条件 batch-create | 两个 Agent 登记同一份资料不会产生两条 |
| 已勾「待人工确认」或人工改过的分类字段，自动更新不覆盖 | 人的判断优先于机器重抽 |
| `登记来源` 必填 Agent/会话标识 | 口径出问题时能溯源 |
| 改了规则文件要递增 `VERSION` + 写 `CHANGELOG.md` | 排查「两个 Agent 行为不一致」的第一线索 |

## 红线

- 不迁移、不复制、不编辑任何原始复盘文件或飞书文档
- 不编造链接、结论、数据、策略；读不到就说读不到
- 不自动改表结构（`sync-dict --apply` 必须经用户明确同意）
- 不在本 Skill 之外复制 `base_token` / `table_id`
- 飞书操作只用 `lark-cli --as user`；外部链接打不开时如实反馈，不反复重试
- 本 Skill 只管复盘台账；业务知识检索走 `deerma-knowledge-base`

## 版本

见根目录 `VERSION` 与 `CHANGELOG.md`。当前 1.2.1。版本源：https://github.com/630898288-collab/review-ledger-skill 。

#!/usr/bin/env node
/**
 * review-ledger unified CLI
 *
 * 所有 Agent 共用的台账读写入口。不要把坐标或 lark-cli 命令拼到别处。
 *
 *   health                              校验坐标/字段/枚举（每次使用前先跑）
 *   find "I2 PRO 8月复盘" [--limit 10]  自然语言召回（本地打分）
 *   get  --record-id recXXX [--full]    取单条详情
 *   author <飞书链接>                   读取飞书文档 owner/最后编辑者姓名
 *   register --input cards.json         结构化登记（按指纹幂等，自动补作者）
 *   sync-dict [--apply]                 字典差异报告 / 固化新枚举
 *
 * 所有输出为 JSON，便于 Agent 解析。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkForUpdate, formatUpdate, applyUpdate, dismissUpdate } from './update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = path.join(ROOT, 'references');
const STATE = path.join(ROOT, 'state');
if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });

/** 安装位置无关：公共模板 + 本机私有配置 + 环境变量。私有配置不进 GitHub。 */
function loadConfig() {
  const base = JSON.parse(readFileSync(path.join(REF, 'ledger-config.json'), 'utf8'));
  const localPath = path.join(REF, 'ledger-config.local.json');
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
  const envMap = {
    REVIEW_LEDGER_BASE_TOKEN: 'base_token', REVIEW_LEDGER_TABLE_ID: 'table_id',
    REVIEW_LEDGER_VIEW_ID: 'view_id', REVIEW_LEDGER_BASE_URL: 'base_url',
    REVIEW_LEDGER_IDENTITY: 'identity', REVIEW_LEDGER_LARK_CLI_BIN: 'lark_cli_bin'
  };
  const env = {};
  for (const [k, name] of Object.entries(envMap)) if (process.env[k]) env[name] = process.env[k];
  return { ...base, ...local, ...env };
}
const CFG = loadConfig();

function requireLedger() {
  if (!CFG.base_token || !CFG.table_id) {
    throw new Error('台账未配置：请在 Skill 目录创建 references/ledger-config.local.json 填写 base_token / table_id，或设置 REVIEW_LEDGER_BASE_TOKEN / REVIEW_LEDGER_TABLE_ID 环境变量。');
  }
}

/** lark-cli 安装位置因 Agent/环境而异：先环境变量，再 PATH，最后常见用户级落点。 */
function resolveLarkBin() {
  const candidates = [process.env.LARK_CLI_BIN, CFG.lark_cli_bin, CFG.lark_cli_fallback,
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'cli-connector-packages', 'bin', 'lark-cli')
  ].filter((x) => typeof x === 'string' && x.length > 0);
  for (const c of candidates) {
    try {
      if (c.includes('/')) { if (existsSync(c)) return c; }
      else { execFileSync('which', [c], { stdio: 'pipe' }); return c; }
    } catch { /* 试下一个 */ }
  }
  return candidates[0] || 'lark-cli';
}
const LARK_BIN = resolveLarkBin();
const SCHEMA = JSON.parse(readFileSync(path.join(REF, 'table-schema.json'), 'utf8'));
const ALIASES_FILE = path.join(REF, 'project-aliases.json');
const CANDIDATES_FILE = path.join(STATE, 'candidates.json');
const LOG_FILE = path.join(STATE, 'register-log.ndjson');
const DICT_FILE = path.join(REF, 'field-dictionary.md');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');
const B = ['--base-token', CFG.base_token, '--table-id', CFG.table_id];

const STOP = new Set([
  '复盘', '的', '了', '吗', '吧', '想', '要', '帮我', '查一下', '找一下', '给我', '发我',
  '里面', '提到', '什么', '哪些', '链接', '资料', '项目', '月份', '这个', '那份', '一下',
  '策略', '结论', '数据', '内容', '有没有', '之前', '看看', '请问', 'and', 'the', 'a'
]);

/* ---------------------------------------------------------------- lark-cli */

function parseLoose(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  const a = text.indexOf('[');
  const start = s < 0 ? a : a < 0 ? s : Math.min(s, a);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

function lark(args) {
  const final = [...args];
  if (!final.includes('--as')) final.push('--as', CFG.identity || 'user');
  if (!final.includes('--format') && !final.includes('--jq')) final.push('--format', 'json');
  const env = { ...process.env, LARK_CLI_NO_PROXY_WARN: '1' };
  const run = (bin) => execFileSync(bin, final, {
    encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out;
  try {
    out = run(LARK_BIN);
  } catch (e) {
    const parsed = parseLoose(e.stdout?.toString?.() || '');
    if (parsed) return parsed;
    throw new Error(`lark-cli 调用失败（${LARK_BIN}）: ${e.message}\n${String(e.stdout || '').slice(0, 600)}\n${String(e.stderr || '').slice(0, 600)}`);
  }
  const parsed = parseLoose(out);
  if (!parsed) throw new Error(`无法解析 lark-cli 输出: ${String(out).slice(0, 600)}`);
  return parsed;
}

function must(r, what) {
  if (!r || r.ok === false) throw new Error(`${what} 失败: ${JSON.stringify(r?.error || r || {}).slice(0, 600)}`);
  return r.data;
}

function getFields() {
  return must(lark(['base', '+field-list', ...B]), '读取字段').fields || [];
}

function rowsToObjects(d) {
  const names = d?.fields || [];
  const ids = d?.record_id_list || [];
  const rows = d?.data || [];
  return rows.map((r, i) => {
    const o = { record_id: ids[i] || null };
    names.forEach((n, j) => {
      o[n] = Array.isArray(r) ? r[j] : r && typeof r === 'object' ? r[n] : null;
    });
    return o;
  });
}

function loadAll() {
  // json 模式下 +record-list 单页上限 200，必须分页；ndjson 才支持 2000。
  const all = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const d = must(lark(['base', '+record-list', ...B, '--limit', '200', '--offset', String(offset)]), '读取台账');
    const rows = rowsToObjects(d);
    all.push(...rows);
    if (!d.has_more || rows.length === 0) break;
    offset += rows.length;
  }
  return all;
}

/* ---------------------------------------------------------------- helpers */

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const str = (v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v));
// text(style=url) 在飞书里读回是 Markdown link，召回给用户前要还原成裸 URL。
function cleanUrl(v) {
  const s = str(v).trim();
  const md = s.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (md) return md[1];
  const bracket = s.match(/^\[(https?:\/\/[^\]]+)\]$/);
  if (bracket) return bracket[1];
  return s || null;
}
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const uniq = (a) => [...new Set(a.filter(Boolean))];
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');

function normalizeLoc(card) {
  const url = cleanUrl(card['原文链接']) || '';
  if (url) {
    try {
      const u = new URL(url);
      u.hash = '';
      const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_\w+|from|share_token)$/i.test(k));
      u.search = '';
      keep.forEach(([k, v]) => u.searchParams.set(k, v));
      return 'url:' + sha(u.toString().replace(/\/$/, '').toLowerCase());
    } catch {
      return 'url:' + sha(url.toLowerCase());
    }
  }
  const p = str(card['本地路径']).trim();
  if (p) return 'file:' + sha(p);
  const seed = [card['复盘标题'], card['内容摘要'], card['一句话结论'], card['关键词']]
    .filter(Boolean).map(str).join('|');
  return 'text:' + sha(seed || JSON.stringify(card));
}

function normKey(s) {
  return str(s).toLowerCase().replace(/[\s_\-]/g, '');
}

function normalizeProject(raw, aliasesObj, extraAliases = []) {
  const name = str(raw).trim();
  if (!name) return { standard: '', aliases: '', isNew: false };
  const k = normKey(name);
  const extras = extraAliases.map((x) => str(x).trim()).filter((x) => x && normKey(x) !== k);
  for (const [std, list] of Object.entries(aliasesObj.aliases || {})) {
    if ([std, ...arr(list)].some((x) => normKey(x) === k)) {
      // 命中已有项目：把卡片带来的新别名并入字典，让别名越用越全
      const cur = arr(list).slice();
      let changed = false;
      for (const ex of extras) {
        if (![std, ...cur].some((x) => normKey(x) === normKey(ex))) { cur.push(ex); changed = true; }
      }
      if (changed) aliasesObj.aliases[std] = cur;
      return { standard: std, aliases: cur.join(', '), isNew: changed };
    }
  }
  aliasesObj.aliases[name] = [name, ...extras];
  return { standard: name, aliases: [name, ...extras].join(', '), isNew: true };
}

function buildSearchKey(card, std, aliases) {
  return uniq([
    std, aliases, card['覆盖周期'], arr(card['归属BU']), arr(card['涉及平台']),
    arr(card['复盘类型']), arr(card['市场区域']), card['关键词'], card['复盘事项']
  ].flat().map(str).map((x) => x.trim())).join(' | ');
}

/* ---------------------------------------------------------------- author */

const DOC_TYPE_MAP = {
  wiki: 'wiki', docx: 'docx', doc: 'doc', sheets: 'sheet', sheet: 'sheet',
  base: 'bitable', bitable: 'bitable', mindnote: 'mindnote', slides: 'slides', file: 'file'
};

function parseFeishuRef(raw) {
  const url = cleanUrl(raw) || '';
  const m = String(url).match(/\/(wiki|docx|doc|sheets|sheet|base|bitable|mindnote|slides|file)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return { url, token: m[2], doc_type: DOC_TYPE_MAP[m[1]] || m[1] };
}

/**
 * 取飞书文档作者：file metas 拿 owner_id / latest_modify_user → 通讯录转姓名。
 * 提交人取 owner（创建者）。任何一步失败都静默返回，不阻断登记。
 */
function resolveFeishuAuthor(raw) {
  const ref = parseFeishuRef(raw);
  if (!ref) return { ok: false, reason: 'not_feishu_url' };
  let meta;
  try {
    meta = must(lark(['drive', 'metas', 'batch_query', '--data', JSON.stringify({
      request_docs: [{ doc_token: ref.token, doc_type: ref.doc_type }]
    })]), '读取文档元数据');
  } catch (e) {
    return { ok: false, reason: 'meta_failed', error: e.message };
  }
  const m = (meta?.metas || [])[0];
  if (!m) return { ok: false, reason: 'no_meta', failed: meta?.failed_list };
  const ids = uniq([m.owner_id, m.latest_modify_user].filter(Boolean));
  let users = [];
  if (ids.length) {
    try {
      const u = must(lark(['contact', '+search-user', '--user-ids', ids.join(',')]), '解析作者姓名');
      users = u?.users || [];
    } catch { /* 通讯录查不到只影响姓名，不影响 owner_id */ }
  }
  const byId = Object.fromEntries(users.map((u) => [u.open_id, u.localized_name || u.name || u.open_id]));
  return {
    ok: true,
    doc_type: m.doc_type, doc_token: m.doc_token, title: m.title,
    create_time: m.create_time,
    owner_id: m.owner_id || null,
    owner_name: byId[m.owner_id] || null,
    last_modify_id: m.latest_modify_user || null,
    last_modify_name: byId[m.latest_modify_user] || null,
    author: byId[m.owner_id] || null
  };
}

/** 提交人空值自动补填：显式填写优先；非飞书链接不查；失败留空不报错。 */
function ensureSubmitter(card, opts) {
  if (str(card['提交人']).trim()) return { changed: false, reason: 'explicit' };
  if (opts.no_author) return { changed: false, reason: 'disabled' };
  const url = cleanUrl(card['原文链接']);
  if (!url || !parseFeishuRef(url)) return { changed: false, reason: 'not_feishu_url' };
  const r = resolveFeishuAuthor(url);
  if (!r.ok || !r.author) return { changed: false, ...r };
  card['提交人'] = r.author;
  card['备注'] = [str(card['备注']),
    `提交人自动取自飞书文档 owner：${r.author}；最后编辑者：${r.last_modify_name || r.last_modify_id || '未知'}`
  ].filter(Boolean).join(' / ');
  return { changed: true, ...r };
}

/* ---------------------------------------------------------------- health */

function health() {
  const fields = getFields();
  const online = new Set(fields.map((f) => f.name));
  const expected = SCHEMA.map((f) => f.name);
  const selects = fields.filter((f) => f.type === 'select').map((f) => ({
    name: f.name,
    multiple: !!f.multiple,
    options: (f.options || []).map((o) => o.name)
  }));
  return {
    ok: true,
    command: 'health',
    ledger: CFG.ledger_name,
    url: CFG.base_url,
    version: readFileSync(VERSION_FILE, 'utf8').trim(),
    field_count: fields.length,
    expected_field_count: expected.length,
    missing_fields: expected.filter((n) => !online.has(n)),
    extra_fields: [...online].filter((n) => !expected.includes(n)),
    record_count: loadAll().length,
    select_options: selects,
    policy: CFG.policy
  };
}

/* ---------------------------------------------------------------- find */

function tokenize(q) {
  const s = str(q);
  const months = [];
  const re = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[2]);
    if (n >= 1 && n <= 12) {
      months.push(`${n}月`, `${String(n).padStart(2, '0')}月`, `${m[1] ? m[1] + '年' : ''}${n}月`, `-${String(n).padStart(2, '0')}-`);
    }
  }
  const tokens = [];
  (s.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) || []).forEach((t) => tokens.push(t.toLowerCase()));
  s.split(/[\s,，、。的了吗？?！!「」《》|｜/\\（）()：:；;]+/).forEach((part) => {
    const cn = part.replace(/[^\u4e00-\u9fa5]/g, '');
    if (cn.length >= 2) {
      tokens.push(cn);
      if (cn.length > 4) for (let i = 0; i + 2 <= cn.length; i += 2) tokens.push(cn.slice(i, i + 2));
    }
  });
  return { months: uniq(months), tokens: uniq(tokens).filter((t) => !STOP.has(t) && t.length > 0) };
}

function scoreRow(row, parsed) {
  const hay = {
    project: str(row['项目标准名']).toLowerCase(),
    alias: str(row['项目别名']).toLowerCase(),
    period: str(row['覆盖周期']).toLowerCase(),
    kw: str(row['关键词']).toLowerCase(),
    key: str(row['检索键']).toLowerCase(),
    title: str(row['复盘标题']).toLowerCase(),
    summary: str(row['内容摘要']).toLowerCase()
  };
  let s = 0;
  for (const t of parsed.tokens) {
    const tl = t.toLowerCase();
    if (hay.project && hay.project.includes(tl)) s += 10;
    if (hay.alias && hay.alias.includes(tl)) s += 7;
    if (hay.period && hay.period.includes(tl)) s += 6;
    if (hay.kw && hay.kw.includes(tl)) s += 4;
    if (hay.key && hay.key.includes(tl)) s += 4;
    if (hay.title && hay.title.includes(tl)) s += 2;
    if (hay.summary && hay.summary.includes(tl)) s += 1;
  }
  for (const mo of parsed.months) {
    const ml = mo.toLowerCase();
    if (hay.period.includes(ml) || hay.key.includes(ml)) s += 12;
  }
  return s;
}

const BRIEF = [
  '复盘标题', '项目标准名', '项目别名', '覆盖周期', '复盘提交日期', '归属BU', '市场区域',
  '涉及平台', '复盘类型', '提交人', '复盘范围', '产出方类型', '产出方名称', '载体类型',
  '资料归属', '原文链接', '本地路径', '可读状态', '一句话结论', '核心策略', '关键数据',
  '关键词', '原文摘录', '内容摘要', '解析状态', '置信度', '待人工确认', '备注', '检索键', '来源指纹'
];

function brief(row, full) {
  if (full) return { ...row, 原文链接: cleanUrl(row['原文链接']) };
  const o = { record_id: row.record_id };
  BRIEF.forEach((k) => { o[k] = k === '原文链接' ? cleanUrl(row[k]) : (row[k] ?? null); });
  return o;
}

function find(query, opts) {
  const parsed = tokenize(query);
  const noQuery = !parsed.tokens.length && !parsed.months.length;
  let rows = loadAll();
  if (opts.project) {
    const p = normKey(opts.project);
    rows = rows.filter((r) => normKey(r['项目标准名']) === p || str(r['项目别名']).toLowerCase().includes(String(opts.project).toLowerCase()));
  }
  if (opts.period) {
    const p = String(opts.period).toLowerCase();
    rows = rows.filter((r) => str(r['覆盖周期']).toLowerCase().includes(p) || str(r['检索键']).toLowerCase().includes(p));
  }
  const scored = rows.map((r) => ({ row: r, score: scoreRow(r, parsed) }))
    .filter((x) => !opts.project && !opts.period && !noQuery ? x.score > 0 : true)
    .sort((a, b) => (noQuery && !opts.project && !opts.period
      ? str(b.row['周期起']).localeCompare(str(a.row['周期起'])) || str(b.row['复盘提交日期']).localeCompare(str(a.row['复盘提交日期']))
      : b.score - a.score))
    .slice(0, Number(opts.limit) || 10);
  return {
    ok: true, command: 'find', query,
    parsed, total_records: rows.length, count: scored.length,
    results: scored.map((x) => ({ score: x.score, ...brief(x.row, !!opts.full) }))
  };
}

function get(recordId, full) {
  const row = loadAll().find((r) => r.record_id === recordId);
  if (!row) return { ok: false, command: 'get', error: `未找到记录 ${recordId}` };
  return { ok: true, command: 'get', result: brief(row, !!full) };
}

/* ---------------------------------------------------------------- register */

const SELECT_FALLBACKS = ['待确认', '其他', '未知', '待核验', '未读取'];
const PROTECTED = new Set([
  '归属BU', '市场区域', '涉及平台', '复盘类型', '提交人', '复盘范围',
  '产出方类型', '产出方名称', '资料归属', '载体类型'
]);

function normalizeCard(raw, fields, aliasesObjIn) {
  const fieldMap = Object.fromEntries(fields.map((f) => [f.name, f]));
  const aliasesObj = aliasesObjIn || readJson(ALIASES_FILE, { aliases: {} });
  if (!aliasesObj.aliases) aliasesObj.aliases = {};
  const card = { ...raw };

  const extraAliases = str(card['项目别名']).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  const p = normalizeProject(card['项目标准名'], aliasesObj, extraAliases);
  if (p.standard) card['项目标准名'] = p.standard;
  if (p.aliases) card['项目别名'] = uniq([str(card['项目别名']).split(/[,，]/), p.aliases.split(/[,，]/)].flat().map((x) => x.trim())).join(', ');
  card['检索键'] = buildSearchKey(card, p.standard, p.aliases);
  card['来源指纹'] = normalizeLoc(card);

  const candidates = [];
  const unknown = [];
  let needConfirm = false;
  const out = {};

  for (const f of SCHEMA) {
    if (['created_at', 'updated_at'].includes(f.type)) continue;
    let v = card[f.name];
    if (v === undefined || v === null || v === '') continue;

    if (f.type === 'text') {
      out[f.name] = str(v);
    } else if (f.type === 'select') {
      const opts = (fieldMap[f.name]?.options || []).map((o) => o.name);
      const accepted = [];
      for (const item of (Array.isArray(v) ? v : str(v).split(/[,，、]/)).map((x) => str(x).trim()).filter(Boolean)) {
        if (opts.includes(item)) {
          accepted.push(item);
        } else {
          candidates.push({ field: f.name, value: item });
          unknown.push(`${f.name}=${item}`);
          needConfirm = true;
          const fb = SELECT_FALLBACKS.find((x) => opts.includes(x));
          if (fb) accepted.push(fb);
        }
      }
      let values = uniq(accepted);
      if (!f.multiple) values = values.slice(0, 1);
      if (values.length) out[f.name] = values;
    } else if (f.type === 'datetime') {
      let s = str(v).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 00:00';
      out[f.name] = s;
    } else if (f.type === 'number') {
      out[f.name] = Number(v) || 0;
    } else if (f.type === 'checkbox') {
      out[f.name] = v === true || v === 'true' || v === 1 || v === '1';
    } else {
      out[f.name] = v;
    }
  }

  const conf = Number(card['置信度'] ?? 0.8);
  out['置信度'] = conf;
  if (conf < (CFG.policy.low_confidence_threshold ?? 0.7) || needConfirm || card['待人工确认']) {
    out['待人工确认'] = true;
  }
  if (unknown.length) {
    out['备注'] = [str(card['备注']), `未识别枚举：${unknown.join('；')}`].filter(Boolean).join(' / ');
  }
  // 检索键必须反映最终入库值，不能带上被降级的原始脏值。
  out['检索键'] = buildSearchKey(out, out['项目标准名'], out['项目别名']);
  return { card: out, candidates, aliasesObj, aliasesChanged: p.isNew };
}

function mergeForUpdate(existing, incoming) {
  const merged = { ...incoming };
  const humanConfirmed = existing['待人工确认'] === false;
  if (humanConfirmed) {
    for (const k of PROTECTED) {
      if (existing[k] !== null && existing[k] !== undefined && !str(existing[k]).includes('待确认')) {
        delete merged[k];
      }
    }
    delete merged['待人工确认'];
  }
  return merged;
}

function register(inputPath, opts) {
  const dryRun = !!(opts.dry_run || opts.dryRun);
  const text = inputPath === '-' ? readFileSync(0, 'utf8') : readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(text);
  const cards = Array.isArray(parsed) ? parsed : [parsed];
  const fields = getFields();
  const existing = loadAll();
  const byFp = new Map(existing.map((r) => [str(r['来源指纹']), r]));
  const candidatesAll = readJson(CANDIDATES_FILE, { items: [] });
  if (!candidatesAll.items) candidatesAll.items = [];
  let aliasesObj = readJson(ALIASES_FILE, { aliases: {} });
  if (!aliasesObj.aliases) aliasesObj.aliases = {};
  let aliasesDirty = false;
  const results = [];
  const authors = [];

  for (let i = 0; i < cards.length; i++) {
    const a = ensureSubmitter(cards[i], opts);
    if (a.changed) authors.push({ index: i, author: a.author, owner_id: a.owner_id, last_modify_name: a.last_modify_name });
    const n = normalizeCard(cards[i], fields, aliasesObj);
    if (n.aliasesChanged) aliasesDirty = true;
    candidatesAll.items.push(...n.candidates);

    const fp = n.card['来源指纹'];
    const hit = CFG.policy.dedup_on_register ? byFp.get(fp) : null;
    if (dryRun) {
      results.push({ index: i, action: hit ? 'would_update' : 'would_create', fingerprint: fp, fields: n.card });
      continue;
    }
    const payload = hit ? mergeForUpdate(hit, n.card) : n.card;
    const args = ['base', '+record-upsert', ...B, '--json', JSON.stringify(payload)];
    if (hit) args.push('--record-id', hit.record_id);
    const d = must(lark(args), '写入台账');
    const rid = hit?.record_id || d?.record?.record_id_list?.[0] || null;
    if (rid && !hit) byFp.set(fp, { record_id: rid, 来源指纹: fp });
    results.push({
      index: i,
      action: hit ? 'updated' : 'created',
      record_id: rid,
      fingerprint: fp,
      复盘标题: n.card['复盘标题'] || null,
      提交人: n.card['提交人'] || null,
      待人工确认: !!n.card['待人工确认']
    });
    appendFileSync(LOG_FILE, JSON.stringify({
      at: new Date().toISOString(), action: hit ? 'updated' : 'created',
      record_id: rid, fingerprint: fp, source: n.card['登记来源'] || null
    }) + '\n', 'utf8');
  }

  if (!dryRun) {
    if (aliasesDirty && aliasesObj) writeJson(ALIASES_FILE, aliasesObj);
    const seen = new Set();
    candidatesAll.items = candidatesAll.items.filter((c) => {
      const k = `${c.field}::${c.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    candidatesAll.updated_at = new Date().toISOString();
    writeJson(CANDIDATES_FILE, candidatesAll);
  }

  return {
    ok: true, command: 'register', input: inputPath, dry_run: dryRun,
    total: cards.length,
    created: results.filter((r) => r.action === 'created').length,
    updated: results.filter((r) => r.action === 'updated').length,
    authors_enriched: authors,
    new_candidate_values: candidatesAll.items.length,
    new_projects: aliasesDirty,
    results
  };
}

/* ---------------------------------------------------------------- sync-dict */

function bumpVersion() {
  const cur = readFileSync(VERSION_FILE, 'utf8').trim().split('.').map(Number);
  cur[2] = (cur[2] || 0) + 1;
  const v = cur.join('.');
  writeFileSync(VERSION_FILE, v + '\n', 'utf8');
  appendFileSync(CHANGELOG_FILE, `\n## ${v} — ${new Date().toISOString().slice(0, 10)}\n\n- \`sync-dict --apply\` 固化新枚举选项；字段字典已刷新。\n`, 'utf8');
  return v;
}

function refreshDictionary(selects) {
  const lines = selects.map((s) => `- ${s.name}：${s.options.join('、')}`).join('\n');
  const marker = '## 八、当前枚举';
  let doc = readFileSync(DICT_FILE, 'utf8');
  const at = doc.indexOf(marker);
  if (at < 0) return false;
  doc = doc.slice(0, at) + marker + '\n\n> 由 `sync-dict` 从线上字段实时生成。若此处与线上不一致，以线上为准并跑一次 `sync-dict` 刷新。\n\n' + lines + '\n';
  writeFileSync(DICT_FILE, doc, 'utf8');
  return true;
}

function syncDict(opts) {
  const fields = getFields();
  const selectMap = Object.fromEntries(fields.filter((f) => f.type === 'select').map((f) => [
    f.name, (f.options || []).map((o) => o.name)
  ]));
  const cand = readJson(CANDIDATES_FILE, { items: [] });
  const pending = {};
  for (const c of cand.items || []) {
    if (!selectMap[c.field]) continue;
    if (selectMap[c.field].includes(c.value)) continue;
    (pending[c.field] ||= []).push(c.value);
  }
  Object.keys(pending).forEach((k) => { pending[k] = uniq(pending[k]); });

  const report = {
    ok: true, command: 'sync-dict', applied: false,
    pending,
    pending_count: Object.values(pending).reduce((n, a) => n + a.length, 0),
    note: '默认只报告差异。加 --apply 才会修改飞书表结构；执行前必须向用户复述将新增的选项并得到明确同意。'
  };
  if (!opts.apply || report.pending_count === 0) {
    report.select_options = fields.filter((f) => f.type === 'select').map((f) => ({ name: f.name, options: selectMap[f.name] }));
    if (!opts.apply) refreshDictionary(report.select_options);
    return report;
  }

  const applied = {};
  for (const [name, values] of Object.entries(pending)) {
    const cur = must(lark(['base', '+field-get', ...B, '--field-id', name]), `读取字段 ${name}`);
    const def = {
      name: cur.name || name,
      type: cur.type || 'select',
      multiple: !!cur.multiple,
      options: [...(cur.options || []).map((o) => ({ name: o.name, hue: o.hue, lightness: o.lightness })), ...values.map((v) => ({ name: v }))]
    };
    if (cur.description) def.description = cur.description;
    if (cur.style) def.style = cur.style;
    const r = lark(['base', '+field-update', ...B, '--field-id', name, '--json', JSON.stringify(def), '--yes']);
    if (r.ok === false) throw new Error(`追加选项失败 ${name}: ${JSON.stringify(r.error)}`);
    applied[name] = values;
  }

  const refreshed = refreshDictionary(Object.entries(selectMap).map(([name, options]) => ({ name, options })));
  const version = bumpVersion();
  writeJson(CANDIDATES_FILE, { items: [], updated_at: new Date().toISOString() });
  return { ...report, applied: true, applied_options: applied, dictionary_refreshed: refreshed, version };
}

/* ---------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
    } else if (cmd === null) {
      cmd = a;
    } else positional.push(a);
  }
  return { cmd, positional, opts };
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const { positional, opts } = parsedArgs;
  let cmd = parsedArgs.cmd;
  if (opts.self_update || cmd === 'update-apply') {
    console.log(JSON.stringify(await applyUpdate(), null, 2));
    return;
  }
  if (opts.dismiss_update || cmd === 'update-dismiss') {
    console.log(JSON.stringify(await dismissUpdate(), null, 2));
    return;
  }
  if (!cmd && opts.check_update) cmd = 'update-status';
  if (cmd !== 'update-status') requireLedger();
  let out;
  switch (cmd) {
    case 'health': out = health(); break;
    case 'find': out = find(positional[0] || '', opts); break;
    case 'get': out = get(opts.record_id, opts.full); break;
    case 'author':
      out = { ok: true, command: 'author', result: resolveFeishuAuthor(positional[0] || '') };
      break;
    case 'register':
      if (!opts.input) throw new Error('register 需要 --input <cards.json|->');
      out = register(opts.input, opts);
      break;
    case 'sync-dict': out = syncDict(opts); break;
    case 'update-status': out = { ok: true, command: 'update-status' }; break;
    default:
      out = {
        ok: false,
        error: '未知命令',
        usage: [
          'health',
          'find "I2 PRO 8月复盘" [--limit 10] [--project X] [--period X] [--full]',
          'get --record-id recXXX [--full]',
          'author <飞书文档链接> [--json]',
          'register --input /abs/cards.json [--dry-run] [--no-author]',
          'sync-dict [--apply]',
          'update-status [--check-update]',
          '--self-update | --dismiss-update | --skip-update-check'
        ]
      };
  }
  let update = null;
  if (!opts.skip_update_check) {
    try {
      update = formatUpdate(await checkForUpdate({ force: !!(opts.check_update || cmd === 'update-status') }));
    } catch { /* 更新检查失败静默降级，不影响主任务 */ }
  }
  console.log(JSON.stringify({ ...out, update }, null, 2));
  if (update?.available) console.error(`\n[Skill 更新] ${update.message}\n`);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exitCode = 1;
});

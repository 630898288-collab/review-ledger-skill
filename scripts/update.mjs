#!/usr/bin/env node
/**
 * review-ledger Skill 的 GitHub 包版本自更新。
 *
 * 设计约束（沿用 BrandDesk Skill 已验证的范式）：
 *  1. 检查不打扰：网络失败 / GitHub 不可达时静默降级，不阻断台账读写。
 *  2. 绝不擅自安装：只判断有无新版本；用户明确同意后才 --apply。
 *  3. 本地私有数据绝不覆盖：ledger-config.local.json、state/*、.update-cache.json、.env*。
 *  4. 只从固定仓库取版本与安装包；默认 12 小时查一次，结果落 .update-cache.json。
 *  5. 下载包先解到临时目录、校验 ZIP Slip，再逐文件复制；不整目录删除。
 *  6. 与安装位置无关：所有路径由 import.meta.url 推导，不写死 ~/.workbuddy。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(HERE, '..');
export const SCRIPTS_DIR = HERE;
const VERSION_FILE = path.join(SKILL_ROOT, 'VERSION');
const CACHE_FILE = path.join(SKILL_ROOT, '.update-cache.json');

const DEFAULT_REPO = process.env.REVIEW_LEDGER_UPDATE_REPO || '630898288-collab/review-ledger-skill';
const DEFAULT_BRANCH = 'main';
export const DEFAULT_VERSION_URL =
  `https://raw.githubusercontent.com/${DEFAULT_REPO}/${DEFAULT_BRANCH}/VERSION`;
export const DEFAULT_ZIP_URL =
  `https://github.com/${DEFAULT_REPO}/archive/refs/heads/${DEFAULT_BRANCH}.zip`;

const HOUR = 3600000;
const RETRY_MS = HOUR;

function envConfig() {
  const pick = (k, fb) => String(process.env[k] ?? fb).trim() || fb;
  const hours = Number(pick('REVIEW_LEDGER_CHECK_HOURS', '12'));
  return {
    versionUrl: pick('REVIEW_LEDGER_VERSION_URL', DEFAULT_VERSION_URL),
    zipUrl: pick('REVIEW_LEDGER_ZIP_URL', DEFAULT_ZIP_URL),
    checkHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 720) : 12,
  };
}

export function readLocalVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim().split(/\r?\n/)[0].trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function compareVersions(a, b) {
  const pa = String(a ?? '').trim().split(/[.\-_]/).map(Number);
  const pb = String(b ?? '').trim().split(/[.\-_]/).map(Number);
  if (!pa.length || !pb.length || pa.some(Number.isNaN) || pb.some(Number.isNaN)) {
    const sa = String(a ?? ''), sb = String(b ?? '');
    return sa === sb ? 0 : sa > sb ? 1 : -1;
  }
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeCache(next) {
  const merged = { ...readCache(), ...next };
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    /* 目录只读时不影响主流程 */
  }
  return merged;
}

function isLocalUrl(url) {
  return /^(https?|file):\/\/(localhost|127\.|192\.168\.|10\.|\[::1\]|\[::\])/i.test(url) ||
    url.startsWith('file:');
}

function assertRemoteUrl(url) {
  if (!/^(https?|file):\/\//i.test(url)) {
    throw new Error(`不支持的更新地址协议：${String(url).slice(0, 60)}`);
  }
}

async function fetchRemote(url, { timeoutMs = 4000, outFile = '' } = {}) {
  assertRemoteUrl(url);
  const common = ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000))];
  if (isLocalUrl(url)) common.push('--noproxy', '*');
  try {
    if (outFile) {
      execFileSync('curl', [...common, '-o', outFile, url], { timeout: timeoutMs + 3000, stdio: 'pipe' });
      return fs.readFileSync(outFile);
    }
    return Buffer.from(execFileSync('curl', [...common, url], {
      timeout: timeoutMs + 3000, stdio: 'pipe', encoding: 'utf8', maxBuffer: 1024 * 1024,
    }));
  } catch {
    if (url.startsWith('file:')) throw new Error('无法读取本地更新镜像');
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (outFile) fs.writeFileSync(outFile, buf);
    return buf;
  }
}

function decide(state, cache) {
  const hasUpdate = Boolean(state.latestVersion) &&
    compareVersions(state.latestVersion, state.localVersion) > 0;
  const dismissed = hasUpdate && cache.dismissedVersion === state.latestVersion;
  return {
    ...state, hasUpdate, dismissed,
    available: hasUpdate && !dismissed,
  };
}

export async function checkForUpdate({ force = false } = {}) {
  const cfg = envConfig();
  const localVersion = readLocalVersion();
  const cache = readCache();
  const base = {
    localVersion,
    latestVersion: cache.latestVersion ?? null,
    checked: false,
    checkedAt: cache.checkedAt ?? null,
    reason: '',
    versionUrl: cfg.versionUrl,
    zipUrl: cfg.zipUrl,
  };
  const nextCheckAt = Number(cache.nextCheckAt ?? 0);
  if (!force && nextCheckAt && Date.now() < nextCheckAt && cache.latestVersion) {
    return decide({ ...base, checked: true, reason: 'cached' }, cache);
  }
  try {
    const raw = await fetchRemote(cfg.versionUrl, { timeoutMs: 4000 });
    const latestVersion = raw.toString('utf8').trim().split(/\r?\n/)[0].trim();
    if (!latestVersion || latestVersion.length > 40 || /\s/.test(latestVersion)) {
      throw new Error('VERSION 内容异常');
    }
    const next = writeCache({
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + cfg.checkHours * HOUR,
      latestVersion,
      lastError: '',
    });
    return decide({
      ...base, latestVersion, checked: true, checkedAt: next.checkedAt, reason: 'ok',
    }, next);
  } catch (e) {
    writeCache({
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + RETRY_MS,
      lastError: String(e?.message ?? e).slice(0, 120),
    });
    return {
      ...base, checked: false, reason: 'check-failed',
      error: String(e?.message ?? e).slice(0, 120),
      hasUpdate: false, dismissed: false, available: false,
    };
  }
}

export function formatUpdate(state) {
  const script = path.join(SCRIPTS_DIR, 'ledger.mjs');
  return {
    available: Boolean(state.available),
    hasUpdate: Boolean(state.hasUpdate),
    currentVersion: state.localVersion,
    latestVersion: state.latestVersion,
    checked: Boolean(state.checked),
    checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
    dismissed: Boolean(state.dismissed),
    reason: state.reason || '',
    updateCommand: `node ${script} --self-update`,
    dismissCommand: `node ${script} --dismiss-update`,
    message: state.available
      ? `复盘台账 Skill 有新版本 ${state.latestVersion}（当前 ${state.localVersion}）。` +
        `请先问用户「要现在更新吗」，明确同意后执行 ${`node ${script} --self-update`}；` +
        `拒绝则执行 ${`node ${script} --dismiss-update`} 并继续原任务。不要自行更新。`
      : '',
  };
}

export async function dismissUpdate() {
  let cache = readCache();
  if (!cache.latestVersion) {
    await checkForUpdate({ force: true });
    cache = readCache();
    if (!cache.latestVersion) return { ok: false, error: '暂时拿不到云端版本号，稍后再试' };
  }
  writeCache({ ...cache, dismissedVersion: cache.latestVersion });
  return { ok: true, dismissedVersion: cache.latestVersion };
}

function findSkillRoot(dir, depth = 0) {
  if (depth > 3) return null;
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const hit = findSkillRoot(path.join(dir, ent.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 私有数据与本地状态不覆盖；这是自更新的核心安全边界。 */
function shouldSkip(name, rel) {
  if (name === '.git' || name === 'node_modules' || name === '__pycache__' || name === '.DS_Store') return true;
  if (name === '.update-cache.json' || name === 'ledger-config.local.json') return true;
  if (rel.replace(/\\/g, '/').startsWith('state/')) return true;
  if (name.endsWith('.zip')) return true;
  if (name.startsWith('.env')) return name !== '.env.example';
  return false;
}

/** 项目别名是共享字典，但不能覆盖用户本地新增的别名：合并两侧。 */
function mergeAliases(src) {
  const localPath = path.join(SKILL_ROOT, 'references', 'project-aliases.json');
  const remotePath = path.join(src, 'references', 'project-aliases.json');
  if (!fs.existsSync(remotePath)) return null;
  const remote = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
  if (!fs.existsSync(localPath)) return null;
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const merged = { ...remote, aliases: { ...(local.aliases || {}), ...(remote.aliases || {}) } };
  for (const [std, list] of Object.entries(local.aliases || {})) {
    if (!merged.aliases[std]) merged.aliases[std] = list;
    else merged.aliases[std] = [...new Set([...(Array.isArray(list) ? list : []), ...(Array.isArray(merged.aliases[std]) ? merged.aliases[std] : [])])];
  }
  return { localPath, content: JSON.stringify(merged, null, 2) + '\n' };
}

function copyTree(src, dest, skipped) {
  let copied = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = path.relative(src, path.join(src, ent.name));
    if (shouldSkip(ent.name, rel)) { skipped.push(rel); continue; }
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copied += copyTree(s, d, skipped);
    else if (ent.isFile()) { fs.copyFileSync(s, d); copied += 1; }
  }
  return copied;
}

/** 用户确认后执行：下载 → 校验 → 备份 → 覆盖包文件 → 清缓存。 */
export async function applyUpdate() {
  const cfg = envConfig();
  const from = readLocalVersion();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ledger-update-'));
  const zipPath = path.join(tmp, 'skill.zip');
  try {
    const buf = await fetchRemote(cfg.zipUrl, { timeoutMs: 30000, outFile: zipPath });
    if (!buf.length || buf.length > 20 * 1024 * 1024) throw new Error('安装包大小异常');
    if (buf.subarray(0, 2).toString() !== 'PK') throw new Error('下载内容不是 ZIP');

    const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      .split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
    for (const e of entries) {
      if (e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.split('/').includes('..')) {
        throw new Error(`安装包含非法路径：${e}`);
      }
    }
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmp], { stdio: 'pipe' });
    const src = findSkillRoot(tmp);
    if (!src) throw new Error('安装包里找不到 SKILL.md，已中止，本地文件未改动');

    const remoteVersionFile = path.join(src, 'VERSION');
    const to = fs.existsSync(remoteVersionFile)
      ? fs.readFileSync(remoteVersionFile, 'utf8').trim().split(/\r?\n/)[0].trim()
      : '(未标注)';

    let backup = '';
    try {
      backup = path.join(os.tmpdir(), `review-ledger-backup-${Date.now()}.zip`);
      execFileSync('zip', [
        '-r', '-q', backup, path.basename(SKILL_ROOT),
        '-x', '*/ledger-config.local.json', '*/.update-cache.json', '*/state/*',
        '*/.env', '*/.env.local', '*/.env.*.local', '*/node_modules/*', '*/.git/*',
        '*.zip', '*/.DS_Store',
      ], { cwd: path.dirname(SKILL_ROOT), stdio: 'pipe' });
    } catch {
      backup = '';
    }

    const skipped = [];
    // 必须在覆盖之前读出本地别名，否则 copyTree 已经把用户的自定义项冲掉了。
    const aliasMerge = mergeAliases(src);
    const copied = copyTree(src, SKILL_ROOT, skipped);
    if (aliasMerge) fs.writeFileSync(aliasMerge.localPath, aliasMerge.content, 'utf8');
    try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }

    return {
      ok: true, from, to, copiedFiles: copied,
      skipped_local_files: skipped,
      preserved: ['ledger-config.local.json', 'state/*（候选值与登记日志）', '.env*', '用户自行添加的文件'],
      aliases_merged: !!aliasMerge,
      backup: backup || '(备份失败，但更新已完成)',
      note: '更新只覆盖包内文件，未删除任何本地文件；本地台账坐标与状态保持不变。',
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), note: '本地 Skill 未改动，可稍后重试或手动下载 ZIP 覆盖。' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const invokedDirectly = Boolean(process.argv[1] && /(?:^|[\\/])update\.mjs$/i.test(process.argv[1]));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--apply') || args.includes('--self-update')) {
    const r = await applyUpdate();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else if (args.includes('--dismiss')) {
    const r = await dismissUpdate();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else {
    const s = await checkForUpdate({ force: args.includes('--force') || args.includes('--check-update') });
    console.log(JSON.stringify(formatUpdate(s), null, 2));
  }
}

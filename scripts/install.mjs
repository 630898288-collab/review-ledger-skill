#!/usr/bin/env node
/**
 * review-ledger 通用安装器：把 Skill 装到任意 Agent 的 skills 目录。
 *
 * 不做任何「~/.workbuddy 就是家」的假设：
 *   --dir <目录>        直接指定目标 skills 目录（也可以用 SKILLS_DIR 环境变量）
 *   --list              只列出探测到的候选目录
 *   --from-github       强制从 GitHub ZIP 安装（默认优先复制当前包）
 *
 * 目标目录指 skills 根目录，例如 ~/.claude/skills；脚本会在其下建 review-ledger/。
 * 输出 JSON，便于 Agent 解析。安装不会覆盖目标已有的 ledger-config.local.json 与 state/*。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(HERE, '..');
const REPO = process.env.REVIEW_LEDGER_UPDATE_REPO || '630898288-collab/review-ledger-skill';
const BRANCH = 'main';
const ZIP_URL = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`;

function candidateSkillsDirs() {
  const home = os.homedir();
  return [
    ['WorkBuddy', path.join(home, '.workbuddy', 'skills')],
    ['Claude Code', path.join(home, '.claude', 'skills')],
    ['Codex', path.join(home, '.codex', 'skills')],
    ['Cursor', path.join(home, '.cursor', 'skills')],
    ['Windsurf', path.join(home, '.windsurf', 'skills')],
    ['OpenCode', path.join(home, '.config', 'opencode', 'skills')],
  ];
}

function isSkillRoot(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(dir, 'scripts', 'ledger.mjs'));
}

function findSkillRoot(dir, depth = 0) {
  if (depth > 3) return null;
  if (isSkillRoot(dir)) return dir;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const hit = findSkillRoot(path.join(dir, ent.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

function skip(name, rel) {
  if (['.git', 'node_modules', '__pycache__', '.DS_Store'].includes(name)) return true;
  if (name === '.update-cache.json' || name === 'ledger-config.local.json') return true;
  if (rel.replace(/\\/g, '/').startsWith('state/')) return true;
  return name.endsWith('.zip');
}

function copyTree(src, dest, skipped) {
  let copied = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = path.relative(src, path.join(src, ent.name));
    if (skip(ent.name, rel)) { skipped.push(rel); continue; }
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copied += copyTree(s, d, skipped);
    else if (ent.isFile()) { fs.copyFileSync(s, d); copied += 1; }
  }
  return copied;
}

function downloadFromGithub() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ledger-install-'));
  const zip = path.join(tmp, 'skill.zip');
  try {
    const args = ['-fsSL', '--max-time', '40', '-o', zip, ZIP_URL];
    try { execFileSync('curl', args, { stdio: 'pipe', timeout: 45000 }); }
    catch { execFileSync('curl', [...args, '--noproxy', '*'], { stdio: 'pipe', timeout: 45000 }); }
    const buf = fs.readFileSync(zip);
    if (buf.subarray(0, 2).toString() !== 'PK') throw new Error('下载内容不是 ZIP');
    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      .split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
    for (const e of entries) {
      if (e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.split('/').includes('..')) throw new Error(`非法路径：${e}`);
    }
    execFileSync('unzip', ['-q', '-o', zip, '-d', tmp], { stdio: 'pipe' });
    const root = findSkillRoot(tmp);
    if (!root) throw new Error('安装包内找不到 SKILL.md');
    return { root, tmp };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const has = (name) => argv.includes(name);
  const candidates = candidateSkillsDirs();
  if (has('--list')) {
    console.log(JSON.stringify({
      ok: true, command: 'list',
      candidates: candidates.map(([agent, dir]) => ({ agent, dir, exists: fs.existsSync(dir) })),
      hint: '用 --dir <skills 根目录> 指定目标，例如 node install.mjs --dir ~/.claude/skills'
    }, null, 2));
    return;
  }

  const targetSkills = arg('--dir') || process.env.SKILLS_DIR;
  if (!targetSkills) {
    console.log(JSON.stringify({
      ok: false, error: '未指定目标目录',
      candidates: candidates.map(([agent, dir]) => ({ agent, dir, exists: fs.existsSync(dir) })),
      hint: '传 --dir <skills 根目录>，如 node install.mjs --dir ~/.claude/skills；先看候选可加 --list'
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const target = path.join(path.resolve(targetSkills.replace(/^~/, os.homedir())), 'review-ledger');
  let src = SELF_ROOT;
  let tmp = null;
  if (has('--from-github') || !isSkillRoot(src)) {
    const dl = downloadFromGithub();
    src = dl.root;
    tmp = dl.tmp;
  }

  const existed = fs.existsSync(target);
  const skipped = [];
  const copied = copyTree(src, target, skipped);
  const localCfg = path.join(target, 'references', 'ledger-config.local.json');
  if (!fs.existsSync(localCfg)) {
    fs.writeFileSync(localCfg, JSON.stringify({
      _note: '本机私有配置：填写自己的台账坐标。本文件不进版本库，Skill 自更新不会覆盖。',
      base_token: '', table_id: '', view_id: '', base_url: ''
    }, null, 2) + '\n', 'utf8');
  }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }

  console.log(JSON.stringify({
    ok: true, command: 'install',
    from: src, target, existed, copiedFiles: copied,
    skipped_local_files: skipped,
    configured: !!(JSON.parse(fs.readFileSync(localCfg, 'utf8')).base_token),
    next_steps: [
      '在 ' + localCfg + ' 填入 base_token / table_id / view_id（或设 REVIEW_LEDGER_BASE_TOKEN 等环境变量）',
      '在目标 Agent 中加载 review-ledger Skill；首次使用会跑 health 校验连通性',
      '自更新：node ' + path.join(target, 'scripts', 'ledger.mjs') + ' --self-update（需用户确认后执行）'
    ]
  }, null, 2));
}

main();

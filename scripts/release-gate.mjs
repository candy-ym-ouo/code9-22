#!/usr/bin/env node
/**
 * 发布质量门禁（Release Quality Gate）
 *
 * 四道门禁按序自动执行，任一失败即阻断后续门禁与发布产物：
 *   1. typecheck         类型检查（shared / server / web 三个工作区）
 *   2. migration-replay  迁移回放（全新空库从零建 + 幂等回放 + 完整性校验）
 *   3. api-contract      接口契约（临时实例上跑 69 项真实 HTTP 冒烟断言）
 *   4. web-build         前端构建（tsc + vite，产物非空校验）
 *
 * 全部通过才生成可追溯产物：
 *   release/manifest.json          机器可读清单（版本 / 门禁结果 / SHA-256 校验和）
 *   release/RELEASE-CHECKLIST.md   人类可读校验清单
 *   release/history/<时间戳>.json  历次归档（只增不改）
 *
 * 用法：npm run release:gate
 * 退出码：0 = 全部通过；1 = 某道门禁失败（产物被阻断）。
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------- 工具

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function fmtDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

class GateFailure extends Error {
  constructor(message, output = '') {
    super(message);
    this.output = output;
  }
}

/** 运行子进程：输出实时透传（CI 日志可见），同时保留尾部供失败时摘要。 */
function run(cmd, args, { env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: ROOT, env: env ?? process.env });
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      process.stdout.write(s);
      buf += s;
      if (buf.length > 256 * 1024) buf = buf.slice(-128 * 1024);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => resolve({ code: 127, output: `${buf}\n${err}`, durationMs: Date.now() - t0 }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: buf, durationMs: Date.now() - t0 }));
  });
}

function must(result, label) {
  if (result.code !== 0) {
    const tail = result.output.trim().split('\n').slice(-30).join('\n');
    throw new GateFailure(`${label} 失败（退出码 ${result.code}）\n—— 输出尾部 ——\n${tail}`, result.output);
  }
  return result;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs, serverProc, serverLog) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  serverProc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new GateFailure(
        `被测服务提前退出\n—— 服务日志尾部 ——\n${serverLog.text.trim().split('\n').slice(-30).join('\n')}`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 服务尚未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new GateFailure(`等待服务就绪超时（${timeoutMs / 1000}s）：${url}`);
}

function killProcessTree(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // detached 进程组整组终止
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
}

function waitProcessExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 隔离环境：数据库与文件目录全部指向临时目录，门禁绝不触碰 ./data 真实数据。 */
function gateEnv(tmp, extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: path.join(tmp, 'app.db'),
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    THUMB_DIR: path.join(tmp, 'thumbs'),
    SHARE_DIR: path.join(tmp, 'share'),
    BACKUP_DIR: path.join(tmp, 'backups'),
    WEATHER_PROVIDER: 'fixture', // 确定性天气源，门禁不依赖外网
    JWT_SECRET: 'release-gate-only',
    ...extra,
  };
}

// ---------------------------------------------------------------- 门禁定义

const gates = [
  {
    id: 'typecheck',
    title: '类型检查',
    command: 'npm run typecheck',
    async run() {
      must(await run(NPM, ['run', '--silent', 'typecheck']), '类型检查');
      return { workspaces: ['@flil/shared', '@flil/server', '@flil/web'] };
    },
  },
  {
    id: 'migration-replay',
    title: '迁移回放',
    command: 'tsx apps/server/src/scripts/verify-migration-replay.ts（临时空库）',
    async run() {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-migration-'));
      try {
        const res = must(
          await run(TSX_BIN, ['apps/server/src/scripts/verify-migration-replay.ts'], { env: gateEnv(tmp) }),
          '迁移回放校验',
        );
        const jsonLine = res.output.trim().split('\n').findLast((l) => l.startsWith('{'));
        const report = jsonLine ? JSON.parse(jsonLine) : {};
        return {
          migrationsApplied: report.migrationsApplied ?? [],
          replayIdempotent: report.replayIdempotent === true,
          tableCount: report.tableCount ?? null,
          integrityCheck: report.integrityCheck ?? null,
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'api-contract',
    title: '接口契约',
    command: 'node apps/server/scripts/smoke.mjs（临时实例，WEATHER_PROVIDER=fixture）',
    async run() {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-contract-'));
      const port = await getFreePort();
      const serverLog = { text: '' };
      const server = spawn(TSX_BIN, ['apps/server/src/index.ts'], {
        cwd: ROOT,
        env: gateEnv(tmp, { PORT: String(port) }),
        detached: true,
      });
      server.stdout.on('data', (d) => (serverLog.text += d));
      server.stderr.on('data', (d) => (serverLog.text += d));
      try {
        process.stdout.write(`  … 临时实例启动中（端口 ${port}，数据库与目录均为临时隔离）\n`);
        await waitForHealth(`http://127.0.0.1:${port}/api/health`, 60_000, server, serverLog);
        const smoke = must(
          await run('node', ['apps/server/scripts/smoke.mjs', `http://127.0.0.1:${port}`]),
          '接口契约（冒烟断言）',
        );
        const m = smoke.output.match(/通过 (\d+) 项，失败 (\d+) 项/);
        return { assertionsPassed: m ? Number(m[1]) : null, assertionsFailed: m ? Number(m[2]) : null };
      } finally {
        killProcessTree(server);
        await waitProcessExit(server, 8_000);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'web-build',
    title: '前端构建',
    command: 'npm run build',
    async run() {
      must(await run(NPM, ['run', '--silent', 'build']), '前端构建');
      const distDir = path.join(ROOT, 'apps', 'web', 'dist');
      if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        throw new GateFailure('构建声称成功但 apps/web/dist/index.html 不存在');
      }
      const files = walkFiles(distDir).map((rel) => {
        const full = path.join(distDir, rel);
        return { path: rel, bytes: fs.statSync(full).size, sha256: sha256File(full) };
      });
      if (files.length < 2) throw new GateFailure(`构建产物异常：dist 下仅 ${files.length} 个文件`);
      const combined = crypto.createHash('sha256');
      for (const f of files) combined.update(`${f.path}:${f.sha256}\n`);
      return {
        distFiles: files,
        distFileCount: files.length,
        distTotalBytes: files.reduce((s, f) => s + f.bytes, 0),
        distSha256: combined.digest('hex'),
      };
    },
  },
];

// ---------------------------------------------------------------- 清单与产物

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function gitInfo() {
  try {
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (commit.status !== 0) return null;
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    return { commit: commit.stdout.trim(), branch: branch.stdout?.trim() || null };
  } catch {
    return null;
  }
}

function npmVersion() {
  try {
    const res = spawnSync(NPM, ['--version'], { encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

function buildManifest(results, totalMs) {
  const rootPkg = readJson('package.json');
  const buildDetail = results.find((r) => r.id === 'web-build')?.detail ?? {};
  const replayDetail = results.find((r) => r.id === 'migration-replay')?.detail ?? {};
  return {
    schema: 'flil.release-manifest/1',
    name: rootPkg.name,
    version: rootPkg.version,
    builtAt: new Date().toISOString(),
    durationMs: Math.round(totalMs),
    tool: { node: process.version, npm: npmVersion(), platform: `${process.platform}/${process.arch}` },
    git: gitInfo(),
    workspaces: Object.fromEntries(
      ['packages/shared', 'apps/server', 'apps/web'].map((dir) => {
        const pkg = readJson(path.join(dir, 'package.json'));
        return [pkg.name, pkg.version];
      }),
    ),
    gates: results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      command: r.command,
      durationMs: r.durationMs ?? null,
      detail: r.detail ?? null,
      error: r.error ?? null,
    })),
    inputs: {
      lockfileSha256: sha256File(path.join(ROOT, 'package-lock.json')),
      migrations: fs
        .readdirSync(path.join(ROOT, 'apps/server/sql'))
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => ({ file: f, sha256: sha256File(path.join(ROOT, 'apps/server/sql', f)) })),
      replayVerified: replayDetail.replayIdempotent === true,
    },
    artifacts: {
      webDist: {
        dir: 'apps/web/dist',
        fileCount: buildDetail.distFileCount ?? 0,
        totalBytes: buildDetail.distTotalBytes ?? 0,
        sha256: buildDetail.distSha256 ?? null,
        files: buildDetail.distFiles ?? [],
      },
    },
  };
}

function renderChecklist(manifest) {
  const gateRows = manifest.gates
    .map((g, i) => {
      const mark = g.status === 'passed' ? '✅ 通过' : g.status === 'failed' ? '❌ 失败' : '⛔ 阻断';
      const dur = g.durationMs != null ? fmtDuration(g.durationMs) : '—';
      return `| ${i + 1} | ${g.title} | \`${g.command}\` | ${mark} | ${dur} |`;
    })
    .join('\n');
  const migrationRows = manifest.inputs.migrations
    .map((m) => `| \`${m.file}\` | \`${m.sha256}\` |`)
    .join('\n');
  const distRows = manifest.artifacts.webDist.files
    .map((f) => `| \`${f.path}\` | ${f.bytes} | \`${f.sha256}\` |`)
    .join('\n');
  const contract = manifest.gates.find((g) => g.id === 'api-contract');
  const assertions = contract?.detail?.assertionsPassed;

  return `# 发布校验清单 v${manifest.version}

| 项 | 值 |
| --- | --- |
| 版本 | ${manifest.version} |
| 生成时间 | ${manifest.builtAt} |
| Git 提交 | ${manifest.git ? `\`${manifest.git.commit.slice(0, 12)}\`（${manifest.git.branch ?? '未知分支'}）` : '不可用（非 git 工作区）'} |
| Node / npm | ${manifest.tool.node} / ${manifest.tool.npm ?? '未知'} |
| 平台 | ${manifest.tool.platform} |
| 工作区版本 | ${Object.entries(manifest.workspaces).map(([k, v]) => `${k}@${v}`).join('、')} |
| 总耗时 | ${fmtDuration(manifest.durationMs)} |

## 质量门禁（任一失败即阻断产物）

| # | 门禁 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
${gateRows}

## 迁移回放

- 回放幂等（重复执行零变更）：${manifest.inputs.replayVerified ? '是' : '否'}
- 完整性校验：${manifest.gates.find((g) => g.id === 'migration-replay')?.detail?.integrityCheck ?? '—'}
- 锁定文件 SHA-256：\`${manifest.inputs.lockfileSha256}\`

| 迁移文件 | SHA-256 |
| --- | --- |
${migrationRows}

## 接口契约

- 冒烟断言：${assertions != null ? `${assertions} 项全部通过` : '—'}（临时实例，\`WEATHER_PROVIDER=fixture\`，不依赖外网）

## 前端产物（apps/web/dist）

- 文件数：${manifest.artifacts.webDist.fileCount}，总大小：${(manifest.artifacts.webDist.totalBytes / 1024).toFixed(1)} KB
- 产物组合 SHA-256：\`${manifest.artifacts.webDist.sha256}\`

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
${distRows}

## 复算方式

\`\`\`bash
npm run release:gate   # 四道门禁全跑；全过才会重新生成本清单与 manifest.json
\`\`\`
`;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const overallT0 = Date.now();
  process.stdout.write(`\n═══ 发布质量门禁 ═══  共 ${gates.length} 道，任一失败即阻断产物\n`);

  const results = [];
  let blocked = false;
  for (const gate of gates) {
    if (blocked) {
      results.push({ id: gate.id, title: gate.title, command: gate.command, status: 'blocked' });
      process.stdout.write(`\n── [${gate.id}] ${gate.title} —— ⛔ 因前序门禁失败被阻断，未执行\n`);
      continue;
    }
    process.stdout.write(`\n── [${gate.id}] ${gate.title} ── ${'-'.repeat(Math.max(4, 40 - gate.title.length))}\n`);
    const t0 = Date.now();
    try {
      const detail = await gate.run();
      results.push({ id: gate.id, title: gate.title, command: gate.command, status: 'passed', durationMs: Date.now() - t0, detail });
      process.stdout.write(`── [${gate.id}] ✅ 通过（${fmtDuration(Date.now() - t0)}）\n`);
    } catch (err) {
      const failure = err instanceof GateFailure ? err : new GateFailure(err?.stack ?? String(err));
      results.push({
        id: gate.id,
        title: gate.title,
        command: gate.command,
        status: 'failed',
        durationMs: Date.now() - t0,
        error: failure.message.split('\n')[0],
      });
      process.stdout.write(`\n── [${gate.id}] ❌ 失败（${fmtDuration(Date.now() - t0)}）\n${failure.message}\n`);
      blocked = true;
    }
  }

  const failedGate = results.find((r) => r.status === 'failed');
  if (failedGate) {
    process.stdout.write(
      `\n═══ 门禁未通过 ═══  失败：${failedGate.title}；` +
        `被阻断：${results.filter((r) => r.status === 'blocked').map((r) => r.title).join('、') || '无'}\n` +
        `发布产物已阻断：release/ 未生成或更新。修复后重新执行 npm run release:gate。\n\n`,
    );
    process.exit(1);
  }

  const manifest = buildManifest(results, Date.now() - overallT0);
  fs.mkdirSync(path.join(RELEASE_DIR, 'history'), { recursive: true });
  const stamp = manifest.builtAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(RELEASE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(RELEASE_DIR, 'RELEASE-CHECKLIST.md'), renderChecklist(manifest));
  fs.writeFileSync(path.join(RELEASE_DIR, 'history', `${stamp}-v${manifest.version}.json`), JSON.stringify(manifest, null, 2) + '\n');

  process.stdout.write(
    `\n═══ 门禁全部通过 ═══  ${gates.length}/${gates.length}（总耗时 ${fmtDuration(manifest.durationMs)}）\n` +
      `  版本：${manifest.version}（${Object.entries(manifest.workspaces).map(([k, v]) => `${k}@${v}`).join('、')}）\n` +
      `  产物校验和（apps/web/dist）：${manifest.artifacts.webDist.sha256}\n` +
      `  清单：release/manifest.json、release/RELEASE-CHECKLIST.md、release/history/\n\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\n门禁编排器自身异常：${err?.stack ?? err}\n`);
  process.exit(1);
});

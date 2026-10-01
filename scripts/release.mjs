#!/usr/bin/env node
/**
 * 发布质量门禁编排器。
 *
 * 四道门禁按序自动执行，任一失败即阻断产物：
 *   1. typecheck         类型检查（shared / server / web 三个工作区）
 *   2. migration-replay  迁移回放（全新临时库重放迁移 + 种子，验证幂等与账本）
 *   3. api-contract      接口契约（vitest 契约套件 + 真实 HTTP 冒烟）
 *   4. web-build         前端构建（tsc --noEmit && vite build）
 *
 * 可追溯性：每次运行（无论成败）都会留下
 *   release/manifest-<buildId>.json   版本、环境、各门禁耗时与退出码、迁移与产物校验和
 *   release/checklist-<buildId>.md    人可读的校验清单
 *   release/logs/<buildId>/           每道门禁的完整日志
 *   release/history.jsonl             全部历史的一行式审计流水
 *   release/latest.json               最近一次成功发布的指针
 *
 * 用法：
 *   node scripts/release.mjs                完整发布（门禁全过才产出 release/*.tar.gz）
 *   node scripts/release.mjs --gates-only   只跑门禁不出产物（PR/推送检查用）
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'release');
const gatesOnly = process.argv.includes('--gates-only');
const GATE_TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS ?? 15 * 60 * 1000);

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = rootPkg.version;
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const buildId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
const logDir = path.join(releaseDir, 'logs', buildId);
fs.mkdirSync(logDir, { recursive: true });

const startedAt = now.toISOString();
const t0 = Date.now();

/** 以子进程运行命令，输出同时上屏并（可选）落盘到门禁日志。 */
function runCommand(command, args, { env = {}, cwd = repoRoot, logFile = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tee = (chunk) => {
      if (logFile) fs.appendFileSync(logFile, chunk);
    };
    child.stdout.on('data', (d) => {
      tee(d);
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      tee(d);
      process.stderr.write(d);
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, GATE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 1 : 0) });
    });
  });
}

function gitCommit() {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    child.on('error', () => resolve(null));
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 服务尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 接口契约门禁 = 契约测试套件（vitest，含 supertest API 闭环）
 *             + 真实 HTTP 冒烟（临时库启动真实服务端，跑 smoke.mjs）。
 */
async function contractGate(logFile) {
  fs.appendFileSync(logFile, '\n── 步骤 3a/2：契约测试套件（vitest run）──\n');
  process.stdout.write('\n── 步骤 3a/2：契约测试套件（vitest run）──\n');
  const unit = await runCommand('npm', ['test'], { logFile });
  if (unit.exitCode !== 0) return { exitCode: unit.exitCode, detail: '契约测试套件失败' };

  fs.appendFileSync(logFile, '\n── 步骤 3b/2：真实 HTTP 冒烟（临时库 + 临时端口）──\n');
  process.stdout.write('\n── 步骤 3b/2：真实 HTTP 冒烟（临时库 + 临时端口）──\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-gate-'));
  const port = await findFreePort();
  const serverEnv = {
    PORT: String(port),
    DATABASE_URL: path.join(tmp, 'gate.db'),
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    THUMB_DIR: path.join(tmp, 'thumbs'),
    SHARE_DIR: path.join(tmp, 'share'),
    BACKUP_DIR: path.join(tmp, 'backups'),
    JWT_SECRET: 'release-gate-secret',
    WEATHER_PROVIDER: 'fixture',
    ENABLE_CLIMATE_BASELINE: 'false',
    LOG_SILENT: 'true',
  };
  const server = spawn('npm', ['--workspace', '@flil/server', 'run', 'start'], {
    cwd: repoRoot,
    shell: true,
    detached: true,
    env: { ...process.env, ...serverEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const teeServer = (d) => {
    fs.appendFileSync(logFile, d);
    process.stdout.write(d);
  };
  server.stdout.on('data', teeServer);
  server.stderr.on('data', teeServer);

  const stopServer = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      try {
        server.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
  };

  try {
    const healthy = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
    if (!healthy) return { exitCode: 1, detail: '冒烟服务端 60s 内未就绪' };
    const smoke = await runCommand(
      'node',
      ['apps/server/scripts/smoke.mjs', `http://127.0.0.1:${port}`],
      { logFile },
    );
    return smoke.exitCode === 0
      ? { exitCode: 0, detail: '契约套件 + 真实 HTTP 冒烟均通过' }
      : { exitCode: smoke.exitCode, detail: '真实 HTTP 冒烟失败' };
  } finally {
    stopServer();
    await new Promise((r) => setTimeout(r, 800));
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const gates = [
  {
    id: 'typecheck',
    name: '类型检查',
    command: 'npm run typecheck',
    run: (logFile) => runCommand('npm', ['run', 'typecheck'], { logFile }),
  },
  {
    id: 'migration-replay',
    name: '迁移回放',
    command: 'npm run db:replay',
    run: (logFile) =>
      runCommand('npm', ['run', 'db:replay'], {
        env: { REPLAY_REPORT_PATH: path.join(logDir, 'migration-replay-report.json') },
        logFile,
      }),
  },
  {
    id: 'api-contract',
    name: '接口契约',
    command: 'npm test + 真实 HTTP 冒烟',
    run: (logFile) => contractGate(logFile),
  },
  {
    id: 'web-build',
    name: '前端构建',
    command: 'npm run build',
    run: (logFile) => runCommand('npm', ['run', 'build'], { logFile }),
  },
];

function copyInto(src, destDir) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(src)) {
      copyInto(path.join(src, entry), path.join(destDir, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.copyFileSync(src, destDir);
  }
}

function tarGz(stagingParent, dirName, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', outFile, '-C', stagingParent, dirName]);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`)),
    );
    child.on('error', reject);
  });
}

function npmVersion() {
  return new Promise((resolve) => {
    const child = spawn('npm', ['-v']);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out.trim() || 'unknown'));
    child.on('error', () => resolve('unknown'));
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────

process.stdout.write(`\n发布质量门禁 · v${version} · build ${buildId}\n`);
process.stdout.write(`模式：${gatesOnly ? '仅门禁（不产出物）' : '完整发布（门禁全过才产出物）'}\n\n`);

const gateResults = [];
let failedGate = null;

for (let i = 0; i < gates.length; i++) {
  const gate = gates[i];
  const logFile = path.join(logDir, `${String(i + 1).padStart(2, '0')}-${gate.id}.log`);
  process.stdout.write(`\n━━ 门禁 ${i + 1}/${gates.length} · ${gate.name}（${gate.command}）━━\n`);
  const g0 = Date.now();
  let result;
  try {
    result = await gate.run(logFile);
  } catch (err) {
    result = { exitCode: 1, detail: String(err?.stack ?? err) };
  }
  const durationMs = Date.now() - g0;
  const ok = result.exitCode === 0;
  gateResults.push({
    id: gate.id,
    name: gate.name,
    command: gate.command,
    status: ok ? 'passed' : 'failed',
    exitCode: result.exitCode,
    durationMs,
    log: path.relative(releaseDir, logFile),
    ...(result.detail ? { detail: result.detail } : {}),
  });
  process.stdout.write(
    `\n${ok ? '✅' : '❌'} ${gate.name} ${ok ? '通过' : '失败'}（${(durationMs / 1000).toFixed(1)}s）\n`,
  );
  if (!ok) {
    failedGate = gate;
    break; // 快速失败：后续门禁不再执行，产物直接阻断
  }
}

// 迁移清单（无论成败都记录，便于追溯当时放行的迁移内容）
const sqlDir = path.join(repoRoot, 'apps/server/sql');
const migrations = fs
  .readdirSync(sqlDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({
    file: f,
    sha256: sha256File(path.join(sqlDir, f)),
    bytes: fs.statSync(path.join(sqlDir, f)).size,
  }));

// ── 产物：仅当全部门禁通过且非 gates-only 模式 ────────────────────────────

let artifact = null;
if (!failedGate && !gatesOnly) {
  const distDir = path.join(repoRoot, 'apps/web/dist');
  const distFiles = fs.existsSync(distDir) ? [...walk(distDir)] : [];
  if (distFiles.length === 0) {
    failedGate = { name: '产物校验' };
    gateResults.push({
      id: 'artifact-check',
      name: '产物校验',
      command: 'check apps/web/dist',
      status: 'failed',
      exitCode: 1,
      durationMs: 0,
      log: null,
      detail: '前端构建产物为空',
    });
  } else {
    const artifactName = `flil-${version}-${buildId}`;
    const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-stage-'));
    const staging = path.join(stagingParent, artifactName);
    fs.mkdirSync(staging, { recursive: true });

    // 可部署产物 = 前端产物 + 后端源码与迁移 + 共享包 + 锁文件
    copyInto(distDir, path.join(staging, 'apps/web/dist'));
    copyInto(path.join(repoRoot, 'apps/server/src'), path.join(staging, 'apps/server/src'));
    copyInto(sqlDir, path.join(staging, 'apps/server/sql'));
    copyInto(
      path.join(repoRoot, 'apps/server/package.json'),
      path.join(staging, 'apps/server/package.json'),
    );
    copyInto(
      path.join(repoRoot, 'packages/shared/src'),
      path.join(staging, 'packages/shared/src'),
    );
    copyInto(
      path.join(repoRoot, 'packages/shared/package.json'),
      path.join(staging, 'packages/shared/package.json'),
    );
    copyInto(path.join(repoRoot, 'package.json'), path.join(staging, 'package.json'));
    copyInto(
      path.join(repoRoot, 'package-lock.json'),
      path.join(staging, 'package-lock.json'),
    );

    const files = [...walk(staging)].map((f) => ({
      path: path.relative(staging, f),
      sha256: sha256File(f),
      bytes: fs.statSync(f).size,
    }));

    const tarFile = path.join(releaseDir, `${artifactName}.tar.gz`);
    await tarGz(stagingParent, artifactName, tarFile);
    artifact = {
      file: path.basename(tarFile),
      sha256: sha256File(tarFile),
      bytes: fs.statSync(tarFile).size,
      fileCount: files.length,
      files,
    };
    fs.rmSync(stagingParent, { recursive: true, force: true });
  }
}

const status = failedGate ? 'failed' : 'passed';
const finishedAt = new Date().toISOString();

const manifest = {
  schemaVersion: 1,
  project: rootPkg.name,
  version,
  buildId,
  status,
  mode: gatesOnly ? 'gates-only' : 'release',
  startedAt,
  finishedAt,
  durationMs: Date.now() - t0,
  git: { commit: await gitCommit() },
  env: {
    node: process.version,
    npm: await npmVersion(),
    platform: `${os.platform()}/${os.arch()}`,
  },
  workspaces: Object.fromEntries(
    ['apps/server', 'apps/web', 'packages/shared'].map((w) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, w, 'package.json'), 'utf8'));
      return [pkg.name, pkg.version];
    }),
  ),
  gates: gateResults,
  migrations,
  artifact,
};

// ── 落盘：清单 + 校验单 + 历史流水 + latest 指针 ─────────────────────────

const manifestFile = path.join(releaseDir, `manifest-${buildId}.json`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

const gateLines = gateResults
  .map(
    (g) =>
      `| ${g.status === 'passed' ? '✅' : '❌'} | ${g.name} | \`${g.command}\` | ${(g.durationMs / 1000).toFixed(1)}s | ${g.exitCode} | ${g.log ?? '—'} |`,
  )
  .join('\n');
const migrationLines = migrations
  .map((m) => `| ${m.file} | \`${m.sha256.slice(0, 16)}…\` | ${m.bytes} |`)
  .join('\n');
const checklist = `# 发布校验清单 · v${version} · ${buildId}

- 状态：**${status === 'passed' ? '通过 ✅' : `失败 ❌（阻断于：${failedGate.name}）`}**
- 开始：${startedAt}
- 结束：${finishedAt}
- 环境：node ${manifest.env.node} / npm ${manifest.env.npm} / ${manifest.env.platform}
- Git 提交：${manifest.git.commit ?? '（非 git 仓库，以构建号追溯）'}

## 质量门禁

| 结果 | 门禁 | 命令 | 耗时 | 退出码 | 日志 |
| --- | --- | --- | --- | --- | --- |
${gateLines}

## 迁移清单（sha256 前缀）

| 迁移文件 | 校验和 | 字节 |
| --- | --- | --- |
${migrationLines}

## 产物

${
  artifact
    ? `- 文件：\`${artifact.file}\`
- sha256：\`${artifact.sha256}\`
- 大小：${artifact.bytes} 字节（含 ${artifact.fileCount} 个文件，逐文件校验和见 manifest）
- 复核：\`npm run release:verify release/${artifact.file}\``
    : gatesOnly
      ? '仅门禁模式，不产出物。'
      : '**门禁未全过，产物已阻断。**'
}
`;
const checklistFile = path.join(releaseDir, `checklist-${buildId}.md`);
fs.writeFileSync(checklistFile, checklist);

fs.appendFileSync(
  path.join(releaseDir, 'history.jsonl'),
  JSON.stringify({
    buildId,
    version,
    status,
    mode: manifest.mode,
    finishedAt,
    failedGate: failedGate?.id ?? failedGate?.name ?? null,
    artifact: artifact ? { file: artifact.file, sha256: artifact.sha256 } : null,
  }) + '\n',
);

if (status === 'passed' && artifact) {
  fs.writeFileSync(
    path.join(releaseDir, 'latest.json'),
    JSON.stringify(
      { buildId, version, manifest: path.basename(manifestFile), artifact: artifact.file },
      null,
      2,
    ),
  );
}

// ── 总结 ──────────────────────────────────────────────────────────────────

process.stdout.write(`\n${'═'.repeat(60)}\n`);
process.stdout.write(`发布校验清单 · v${version} · ${buildId}\n\n`);
for (const g of gateResults) {
  process.stdout.write(
    `  ${g.status === 'passed' ? '✅' : '❌'} ${g.name.padEnd(6)}（${(g.durationMs / 1000).toFixed(1)}s）\n`,
  );
}
process.stdout.write(`\n  状态：${status === 'passed' ? '全部通过 ✅' : `失败 ❌（阻断于：${failedGate.name}）`}\n`);
if (artifact) {
  process.stdout.write(`  产物：release/${artifact.file}\n`);
  process.stdout.write(`  sha256：${artifact.sha256}\n`);
} else if (!gatesOnly) {
  process.stdout.write('  产物：已阻断（门禁未全过，不产出）\n');
}
process.stdout.write(`\n  清单：release/${path.basename(manifestFile)}\n`);
process.stdout.write(`  校验单：release/${path.basename(checklistFile)}\n`);
process.stdout.write(`  日志：release/logs/${buildId}/\n`);
process.stdout.write(`  历史：release/history.jsonl\n\n`);

process.exit(status === 'passed' ? 0 : 1);

/**
 * 迁移回放校验（发布质量门禁用）。
 *
 * 对一个全新的空库执行四步验证：
 *  1. 从零应用 sql/*.sql —— 证明"新环境可建库"（不是只在开发机上能跑）；
 *  2. 紧接着再跑一遍 migrate() —— 证明回放幂等（重复执行零变更）；
 *  3. 校验 _migration 表记录与磁盘迁移文件一一对应（无漏跑、无幽灵记录）；
 *  4. 校验核心表齐全 + PRAGMA integrity_check / foreign_key_check。
 *
 * 用法：DATABASE_URL=<临时库路径> npm --workspace @flil/server run db:verify-replay
 * 退出码非 0 即门禁失败。注意：本脚本拒绝在已存在的库上运行，以防误伤真实数据。
 */
import fs from 'node:fs';
import { config, ensureDirs } from '../config.js';
import { migrate, getDb, closeDb } from '../db.js';

function fail(message: string): never {
  process.stderr.write(`❌ 迁移回放校验失败：${message}\n`);
  process.exit(1);
}

ensureDirs();

const dbFile = config.databaseFile;
if (fs.existsSync(dbFile)) {
  fail(`目标库已存在（${dbFile}）。回放校验必须在全新空库上进行，请指向临时路径。`);
}

const sqlFiles = fs
  .readdirSync(config.sqlDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
if (sqlFiles.length === 0) fail(`迁移目录 ${config.sqlDir} 下没有任何 .sql 文件`);

// 1. 从零应用全部迁移
const first = migrate();
if (first.length !== sqlFiles.length || first.join(',') !== sqlFiles.join(',')) {
  fail(`首次应用结果与磁盘文件不一致：应用=[${first.join(', ')}]，磁盘=[${sqlFiles.join(', ')}]`);
}

// 2. 幂等回放：第二遍必须零变更
const second = migrate();
if (second.length !== 0) {
  fail(`重复回放产生了额外迁移：${second.join(', ')}（_migration 记录可能丢失）`);
}

// 3. _migration 记录与磁盘文件一一对应
const db = getDb();
const recorded = (db.prepare('SELECT name FROM _migration ORDER BY name').all() as { name: string }[]).map(
  (r) => r.name,
);
if (recorded.join(',') !== sqlFiles.join(',')) {
  fail(`_migration 记录与磁盘文件不一致：记录=[${recorded.join(', ')}]，磁盘=[${sqlFiles.join(', ')}]`);
}

// 4. 核心表齐全 + 完整性 / 外键检查
const tables = new Set(
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (r) => r.name,
  ),
);
const requiredTables = [
  'user',
  'library',
  'library_member',
  'place',
  'spot',
  'inspiration',
  'asset',
  'tag',
  'inspiration_tag',
  'timing',
  'repro_window',
  'reminder',
  'shoot_plan',
  'shoot_result',
  'album',
  'album_gap',
  'share_link',
  'offline_op',
  'weather_cache',
  'job_run',
];
const missing = requiredTables.filter((t) => !tables.has(t));
if (missing.length > 0) fail(`核心表缺失：${missing.join(', ')}`);

const integrity = db.pragma('integrity_check', { simple: true }) as string;
if (integrity !== 'ok') fail(`PRAGMA integrity_check 未通过：${integrity}`);

const fkViolations = db.pragma('foreign_key_check') as unknown[];
if (fkViolations.length > 0) fail(`PRAGMA foreign_key_check 存在 ${fkViolations.length} 处违规`);

closeDb();

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    db: dbFile,
    migrationsApplied: first,
    replayIdempotent: true,
    tableCount: tables.size,
    integrityCheck: integrity,
  })}\n`,
);

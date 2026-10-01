/**
 * 迁移回放门禁（发布质量门禁的第 2 环）。
 *
 * 在一个全新的临时数据库上完整回放全部迁移与种子基线，验证：
 *   1. 全新回放：空库按文件名顺序应用全部 sql/*.sql；
 *   2. 幂等：迁移与基线种子各跑第二遍，均无新增写入；
 *   3. 账本一致：_migration 表记录与磁盘上的迁移文件一一对应；
 *   4. 模式完整：关键表全部存在，外键完整性检查通过；
 *   5. 零业务数据：迁移与种子不夹带任何虚构业务数据。
 *
 * 任一检查失败以退出码 1 阻断发布。设置 REPLAY_REPORT_PATH 可输出 JSON 报告。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须先于任何 config/db 导入设置环境（config 在模块加载时读取环境变量）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-replay-'));
process.env.DATABASE_URL = path.join(tmpDir, 'replay.db');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
process.env.SHARE_DIR = path.join(tmpDir, 'share');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.LOG_SILENT = 'true';

const { migrate, getDb, closeDb, newId, nowIso } = await import('../db.js');
const { ensureDirs, config } = await import('../config.js');
const { ensureBaselineTags, baselineTagCount, businessDataCounts } = await import(
  '../seed/baseline.js'
);

interface CheckResult {
  id: string;
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(id: string, name: string, ok: boolean, detail = ''): void {
  results.push({ id, name, ok, ...(detail ? { detail } : {}) });
  process.stdout.write(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const KEY_TABLES = [
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
  'calibration_log',
  'album',
  'album_item',
  'album_gap',
  'album_snapshot',
  'share_link',
];

async function main(): Promise<void> {
  process.stdout.write('\n迁移回放门禁（全新临时库，不触碰开发/生产数据）\n\n');
  ensureDirs();

  const sqlFiles = fs
    .readdirSync(config.sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  check('sql-files', '迁移文件可枚举', sqlFiles.length > 0, sqlFiles.join(', ') || '(空)');

  // 1. 全新回放：空库按序应用全部迁移
  const applied = migrate();
  check(
    'fresh-replay',
    '全新库回放应用全部迁移',
    applied.length === sqlFiles.length && applied.every((f, i) => f === sqlFiles[i]),
    `应用 ${applied.length}/${sqlFiles.length}`,
  );

  // 2. 迁移幂等：第二遍无新增
  const secondPass = migrate();
  check('idempotent', '迁移幂等（第二遍无新增）', secondPass.length === 0, `新增 ${secondPass.length}`);

  // 3. 账本一致：_migration 与磁盘文件一一对应
  const db = getDb();
  const ledger = (db.prepare('SELECT name FROM _migration ORDER BY name').all() as { name: string }[]).map(
    (r) => r.name,
  );
  check(
    'ledger',
    '迁移账本与磁盘文件一致',
    ledger.length === sqlFiles.length && ledger.every((f, i) => f === sqlFiles[i]),
    `账本 ${ledger.length} 条 / 磁盘 ${sqlFiles.length} 个`,
  );

  // 4. 模式完整：关键表存在 + 外键完整性
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const missing = KEY_TABLES.filter((t) => !tables.has(t));
  check('schema', '关键表全部存在', missing.length === 0, missing.length ? `缺失：${missing.join(', ')}` : `${tables.size} 张表`);

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  check('fk-integrity', '外键完整性检查通过', fkViolations.length === 0, `违规 ${fkViolations.length} 行`);

  // 5. 种子回放：基线标签写入且幂等
  const now = nowIso();
  const userId = newId();
  const libraryId = newId();
  db.prepare(
    'INSERT INTO "user" (id, email, password_hash, display_name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, 'replay@gate.local', 'x', '迁移回放', 'Asia/Shanghai', now, now);
  db.prepare(
    'INSERT INTO library (id, name, owner_id, default_fuzz_level, tz, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(libraryId, '迁移回放库', userId, 'g500', 'Asia/Shanghai', now, now);

  const expected = baselineTagCount().total;
  const firstSeed = ensureBaselineTags(libraryId).inserted;
  check('seed-replay', '基线种子完整写入', firstSeed === expected, `写入 ${firstSeed}/${expected}`);

  const secondSeed = ensureBaselineTags(libraryId).inserted;
  check('seed-idempotent', '基线种子幂等（第二遍零写入）', secondSeed === 0, `新增 ${secondSeed}`);

  const tagRows = db
    .prepare('SELECT COUNT(*) AS n FROM tag WHERE library_id = ?')
    .get(libraryId) as { n: number };
  check('seed-count', '库内标签行数与基线一致', tagRows.n === expected, `${tagRows.n}/${expected}`);

  // 6. 零业务数据：迁移与种子不夹带业务数据
  const business = businessDataCounts();
  const businessTotal = Object.values(business).reduce((a, b) => a + b, 0);
  check('no-business-data', '迁移与种子不含业务数据', businessTotal === 0, JSON.stringify(business));

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n结果：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项\n`);

  const reportPath = process.env.REPLAY_REPORT_PATH;
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          gate: 'migration-replay',
          ok: failed.length === 0,
          migrations: sqlFiles,
          checks: results,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (failed.length) {
    process.stdout.write('失败明细：\n');
    for (const f of failed) process.stdout.write(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}\n`);
    process.exit(1);
  }
  process.stdout.write('迁移回放全部通过 ✅\n\n');
}

main().catch((err) => {
  process.stderr.write(`迁移回放异常：${err?.stack ?? err}\n`);
  try {
    closeDb();
  } catch {
    /* 忽略 */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 产物复核：重新计算发布产物的 sha256，与发布清单（manifest）中的记录比对。
 * 让"校验清单可追溯"落地为一条可独立复算的命令。
 *
 * 用法：
 *   node scripts/verify-artifact.mjs release/flil-1.0.0-<buildId>.tar.gz
 *   node scripts/verify-artifact.mjs          # 复核 release/latest.json 指向的产物
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'release');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fail(msg) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
}

let tarPath = process.argv[2];
if (!tarPath) {
  const latestFile = path.join(releaseDir, 'latest.json');
  if (!fs.existsSync(latestFile)) fail('未指定产物且 release/latest.json 不存在');
  const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  tarPath = path.join(releaseDir, latest.artifact);
  process.stdout.write(`未指定产物，复核 latest.json 指向的 ${latest.artifact}\n`);
}
if (!path.isAbsolute(tarPath)) tarPath = path.join(repoRoot, tarPath);
if (!fs.existsSync(tarPath)) fail(`产物不存在：${tarPath}`);

const tarName = path.basename(tarPath);
const m = /^flil-(.+)-(\d{8}-\d{6}-[0-9a-f]{6})\.tar\.gz$/.exec(tarName);
if (!m) fail(`产物文件名不符合 flil-<version>-<buildId>.tar.gz 约定：${tarName}`);
const [, version, buildId] = m;

const manifestFile = path.join(releaseDir, `manifest-${buildId}.json`);
if (!fs.existsSync(manifestFile)) fail(`找不到对应清单：release/manifest-${buildId}.json`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  process.stdout.write(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

process.stdout.write(`\n复核产物 ${tarName}\n\n`);

check('清单记录的版本与文件名一致', manifest.version === version, `v${manifest.version}`);
check('清单记录的状态为通过', manifest.status === 'passed', manifest.status);
check('清单中四道门禁全部通过', manifest.gates?.length === 4 && manifest.gates.every((g) => g.status === 'passed'),
  (manifest.gates ?? []).map((g) => `${g.name}:${g.status}`).join('，'));

const actual = sha256File(tarPath);
check(
  '产物 sha256 与清单一致',
  manifest.artifact?.sha256 === actual,
  `记录 ${manifest.artifact?.sha256?.slice(0, 16)}… / 实际 ${actual.slice(0, 16)}…`,
);

if (checks.every(Boolean)) {
  process.stdout.write('\n复核通过 ✅ 产物与发布清单一致，可追溯。\n\n');
} else {
  process.stderr.write('\n复核失败 ❌ 产物与发布清单不一致，禁止放行。\n\n');
  process.exit(1);
}

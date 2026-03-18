import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const logPath = path.join(rootDir, 'sync.log');
const reportPath = path.join(rootDir, 'docs', 'data', 'sync-failure.json');

const exitCode = Number.parseInt(process.argv[2] || '0', 10) || 0;

if (exitCode === 0) {
  if (fs.existsSync(reportPath)) {
    fs.rmSync(reportPath, { force: true });
    console.log('Removed stale sync failure report.');
  } else {
    console.log('Sync succeeded; no failure report needed.');
  }
  process.exit(0);
}

const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
const logLines = logContent.split(/\r?\n/).filter(Boolean);
const report = {
  generated_at: new Date().toISOString(),
  exit_code: exitCode,
  commit_sha: process.env.GITHUB_SHA || null,
  run_id: process.env.GITHUB_RUN_ID || null,
  tail: logLines.slice(-80),
};

const nextContent = `${JSON.stringify(report, null, 2)}\n`;
fs.mkdirSync(path.dirname(reportPath), { recursive: true });

if (fs.existsSync(reportPath) && fs.readFileSync(reportPath, 'utf8') === nextContent) {
  console.log('Sync failure report unchanged.');
  process.exit(0);
}

fs.writeFileSync(reportPath, nextContent, 'utf8');
console.log(`Wrote sync failure report to ${path.relative(rootDir, reportPath)}.`);

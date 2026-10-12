// Small repository guard, not a replacement for a full secret scanner.
// Report locations only: never echo matched credentials.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const staged = process.argv.includes('--staged');
const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024 });
const files = git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean);
// Read the index in one batch instead of starting Git once per file.
const stagedContents = new Map();
if (staged) {
  const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== '0') throw new Error('Resolve index conflicts before checking secrets.');
    return { hash: match[2], file: match[4] };
  });
  const hashes = [...new Set(entries.map(entry => entry.hash))];
  if (hashes.length) {
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root, input: hashes.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024,
    });
    const blobs = new Map();
    let offset = 0;
    for (const hash of hashes) {
      const end = batch.indexOf(10, offset);
      const header = batch.subarray(offset, end).toString('utf8').split(' ');
      if (header[0] !== hash || header[1] !== 'blob') throw new Error('Cannot read staged file.');
      const size = Number(header[2]);
      blobs.set(hash, batch.subarray(end + 1, end + 1 + size));
      offset = end + 1 + size + 1;
    }
    for (const entry of entries) stagedContents.set(entry.file, blobs.get(entry.hash));
  }
}
const forbidden = /(?:^|\/)(?:project\.private(?:\.[^/]*)?\.json|\.env(?:\.[^/]*)?|\.npmrc|tcb_custom_login\.json|apiclient_(?:cert|key)\.[^/]+|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$|(?:^|\/)(?:\.cloudbase|\.tcb|local-data|backups)\//i;
const checks = [
  ['Real WeChat AppID', /\bwx[a-f0-9]{16}\b/gi],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['Provider token', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKID[A-Za-z0-9]{28,})\b/g],
  ['Credential literal', /\b(?:appsecret|secretkey|api[_-]?key|access[_-]?token|session[_-]?key)\b["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{24,})["']/gi],
];
let findings = 0;
const report = (file, reason, line) => {
  console.error(`${file}${line ? ':' + line : ''}: ${reason} (value withheld)`);
  findings++;
};
for (const file of files) {
  if (forbidden.test(file) && !file.endsWith('.env.example')) {
    report(file, 'Local-only file must not be tracked');
  }
  const absolute = path.join(root, file);
  if (!staged && !fs.existsSync(absolute)) continue;
  const contents = staged ? stagedContents.get(file) : fs.readFileSync(absolute);
  if (contents.includes(0)) continue;
  for (const [index, line] of contents.toString('utf8').split('\n').entries()) {
    for (const [reason, pattern] of checks) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) report(file, reason, index + 1);
    }
  }
}
if (findings) {
  console.error(`Repository security check failed: ${findings} finding(s).`);
  process.exitCode = 1;
} else {
  console.log(`Repository security check passed (${files.length} tracked files, ${staged ? 'staged' : 'working tree'}).`);
}

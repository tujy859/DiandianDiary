/** Conservative source-byte budget; the developer tool remains the final package-size authority. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const BUDGET = 1500 * 1024;
const ASSET_BUDGET = 50 * 1024;
function ignored(file, rules) {
  return rules.some(rule => {
    const value = rule.value.replace(/\\/g, '/').replace(/\/$/, '');
    if (rule.type === 'folder') return file === value || file.startsWith(value + '/');
    if (rule.type === 'file') return file === value;
    if (rule.type === 'suffix') return file.endsWith(value);
    throw new Error(`Unsupported packOptions rule: ${rule.type}`);
  });
}
function inventory(root, rules) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name);
      if (ignored(file, rules)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symlink cannot be included in the package: ${file}`);
      if (entry.isDirectory()) walk(file);
      else files.push({ file, bytes: fs.statSync(path.join(root, file)).size });
    }
  }
  walk('');
  return files;
}
function check(root = ROOT) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json')));
  if (config.packOptions.include.length) throw new Error('Explicit package includes can override exclusions; review the budget checker first.');
  const rules = config.packOptions.ignore;
  for (const directory of ['resources', 'docs', 'tools', 'cloudfunctions', '.git', 'node_modules']) {
    if (!ignored(`${directory}/future-file.bin`, rules)) throw new Error(`${directory}/ must stay outside the mini-program package`);
  }
  const files = inventory(root, rules);
  const problems = [];
  const appPath = path.join(root, 'app.json');
  if (fs.existsSync(appPath)) {
    for (const page of JSON.parse(fs.readFileSync(appPath)).pages) {
      for (const suffix of ['.json', '.wxml', '.wxss']) {
        const file = page + suffix;
        if (!fs.existsSync(path.join(root, file)) || ignored(file, rules)) problems.push(`Registered page is missing or excluded: ${file}`);
      }
    }
  }
  for (const { file, bytes } of files) {
    if (file.startsWith('assets/') && bytes > ASSET_BUDGET) problems.push(`${file}: ${(bytes / 1024).toFixed(1)} KiB; asset limit is 50 KiB`);
  }
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools/assets-lock.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/assets-manifest.json')));
  if (JSON.stringify(manifest) !== JSON.stringify(lock.map(({ sourceSha256, targetSha256, ...spec }) => spec))) problems.push('Asset manifest changed; run npm run assets:build');
  for (const item of lock) {
    if (sha(item.source) !== item.sourceSha256 || sha(item.target) !== item.targetSha256) problems.push(`${item.target}: source/export changed; run npm run assets:build`);
  }
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`Package source upper estimate: ${(total / 1024).toFixed(1)} KiB / ${BUDGET / 1024} KiB (${files.length} files, before compilation/minification)`);
  if (total > BUDGET) problems.push('Package budget exceeded. Largest files:\n' + files.sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(f => `  ${f.file}: ${(f.bytes / 1024).toFixed(1)} KiB`).join('\n'));
  if (problems.length) throw new Error(problems.join('\n'));
  return { total, files };
}
module.exports = { ignored, inventory, check, BUDGET };
if (require.main === module) {
  try { check(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

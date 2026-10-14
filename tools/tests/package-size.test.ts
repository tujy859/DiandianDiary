import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { check } = require('../check-package-size.cjs');
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-package-'));
  fs.copyFileSync(path.resolve(__dirname, '../../project.config.json'), path.join(root, 'project.config.json'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'tools/assets-manifest.json'), '[]');
  fs.writeFileSync(path.join(root, 'tools/assets-lock.json'), '[]');
  fs.writeFileSync(path.join(root, 'app.js'), 'App({});');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('未来的文档、设计原图与测试文件不进入体积统计，运行时图片仍被计入', () => {
  for (const folder of ['docs', 'resources', 'tools', 'assets']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/proposal.docx'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'resources/portrait.png'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'future-report.pdf'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'assets/avatar.png'), Buffer.alloc(1024));
  const result = check(root);
  expect(result.files.some((f: any) => f.file === 'assets/avatar.png')).toBe(true);
  expect(result.files.some((f: any) => /proposal|portrait|report/.test(f.file))).toBe(false);
  expect(result.total).toBeLessThan(20 * 1024);
});
test('高清图片误放入 assets 时失败并指出路径', () => {
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets/accidental-original.png'), Buffer.alloc(60 * 1024));
  expect(() => check(root)).toThrow('assets/accidental-original.png');
});
test('代码增长超过预算时失败，而不是依赖上传时才发现', () => {
  fs.writeFileSync(path.join(root, 'large.js'), Buffer.alloc(1600 * 1024));
  expect(() => check(root)).toThrow('Package budget exceeded');
});

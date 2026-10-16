// Layout-only renders from current WCC templates and WXSS. No app storage or cloud access.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), cp = require('node:child_process');
const { createRequire } = require('node:module');
const [packageRoot, repoRoot] = process.argv.slice(2);
const requireRuntime = createRequire(path.join(packageRoot, '__contest_ux__.cjs'));
const { chromium } = requireRuntime('playwright');
const compiler = 'C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
const output = path.join(repoRoot, 'resources/document-assets/private/contest-ux');
fs.mkdirSync(output, { recursive: true });
const templates = ['pages/chat/chat', 'pages/album/album', 'custom-tab-bar/index'];
const context = { window: {}, console }; vm.createContext(context);
vm.runInContext(cp.execFileSync(path.join(compiler, 'wcc.exe'), templates.map(p => p + '.wxml'), { cwd: repoRoot, encoding: 'utf8' }), context);
const read = p => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const esc = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const photoRoot = path.join(repoRoot, 'resources/document-assets/private/diandian');
const photos = ['diandian-01-cat-tree.jpg', 'diandian-02-daily.jpg'].map(name => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(photoRoot, name)).toString('base64'));
const iconCss = read('miniprogram_npm/tdesign-miniprogram/icon/icon.wxss').replace(/@import[^;]+;/g, '');
function render(node) {
  if (node == null) return '';
  if (typeof node !== 'object') return esc(node);
  const tag = (node.tag || '').replace(/^wx-/, ''), a = node.attr || {};
  const children = () => (node.children || []).map(render).join('');
  if (['page', 'virtual'].includes(tag)) return children();
  if (['offline-bar', 'test-space-bar', 't-dialog', 't-action-sheet', 't-toast', 'draft-editor', 'pending-card', 't-popup'].includes(tag)) return '';
  if (tag === 't-icon') return `<i class="t-icon t-icon-base t-icon-${esc(a.name)}" style="font-size:${esc(a.size || '32rpx')};color:${esc(a.color || '#32694f')}"></i>`;
  if (tag === 'image') {
    let src = a.src || '';
    if (src.startsWith('/assets/')) src = 'data:image/png;base64,' + fs.readFileSync(path.join(repoRoot, src)).toString('base64');
    return `<img class="${esc(a.class)}" src="${src}" style="${esc(a.style)};object-fit:${a.mode === 'aspectFit' ? 'contain' : 'cover'}">`;
  }
  if (tag === 'textarea') return `<textarea class="${esc(a.class)}" placeholder="${esc(a.placeholder)}">${esc(a.value)}</textarea>`;
  if (tag === 't-tag') return `<span class="demo-tag">${children()}</span>`;
  if (tag === 't-button') return `<button class="${esc(a.class)}">${children()}</button>`;
  const htmlTag = tag === 'text' ? 'text' : 'div';
  return `<${htmlTag} class="${esc(a.class)}" style="${esc(a.style)}">${children()}</${htmlTag}>`;
}
const pet = { id: 'demo-pet', name: '点点', species: '猫' };
const base = { currentPet: pet, pets: [pet], petAvatar: '/assets/pets/cat-british-longhair-gray.png', messages: [], sessions: [], attachments: [],
  inputValue: '', placeholder: '说点什么，比如：今天和点点玩了', keyboardOffset: 0, keyboardUp: false, tabbarHeight: 56, viewportHeight: 716,
  loading: false, loadError: '', refreshing: false, flowRun: null, editorVisible: false, testFamily: false,
  records: [
    { id: 'demo-one', dateText: '10月15日 · 周四', rel: '今天', text: '在猫爬架上待了一会儿。', photos: [photos[0]], tags: ['日常'] },
    { id: 'demo-two', dateText: '10月14日 · 周三', rel: '昨天', text: '给点点驱虫了。', photos: [], tags: ['驱虫'] }
  ], view: 'timeline', gallery: [] };
const tabs = [{ pagePath: '/pages/album/album', icon: 'image', text: '时光册' }, { pagePath: '/pages/chat/chat', icon: 'chat', text: '聊聊' }, { pagePath: '/pages/mine/mine', icon: 'user-circle', text: '我的' }];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 3 });
    for (const [name, index, selected, title] of [['chat', 0, 1, '聊聊'], ['timeline', 1, 0, '时光册']]) {
      const pageTree = context.$gwx(templates[index] + '.wxml')({ ...base });
      const tabTree = context.$gwx(templates[2] + '.wxml')({ hidden: false, list: tabs, selected, safeBottom: 0, tabHeightStyle: 'height:56px;' });
      const css = (read('app.wxss').replace(/\bpage\s*\{/g, 'body {') + read(templates[index] + '.wxss') + read('custom-tab-bar/index.wxss') + iconCss)
        .replace(/(-?\d*\.?\d+)rpx/g, (_, n) => Number(n) * 390 / 750 + 'px');
      await page.setContent(`<meta charset="utf-8"><style>body{margin:0;background:#faf8f3;font-family:'Microsoft YaHei',sans-serif}div,img,text{box-sizing:border-box}text{display:inline}.native-title{height:44px;display:flex;align-items:center;justify-content:center;font-size:15px;color:#253a30}.screen{height:716px;position:relative}.screen>.page{height:716px!important}img{display:block}textarea{resize:none;border:0;outline:0;background:transparent;min-width:0;height:24px!important;font-family:inherit}textarea::placeholder{color:#a7b3ab}.demo-tag{font-size:11px;color:#32694f;background:#edf3ee;padding:3px 6px;border-radius:5px}.body,.msgs{overflow:auto}::-webkit-scrollbar{display:none}${css}</style><div class="native-title">${title}</div><div class="screen">${render(pageTree)}${render(tabTree)}</div>`);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(name + ' horizontal overflow');
      await page.screenshot({ path: path.join(output, name + '.png') });
      console.log(name + ': 390 x 760, current WCC/WXSS, demo content');
    }
    fs.writeFileSync(path.join(output, 'SOURCE.md'), '# 页面布局展示来源\n\n基于当前 pages/chat/chat、pages/album/album 和 custom-tab-bar 的 WCC 编译结果与 WXSS，使用浏览器适配原生控件、TDesign 图标字体及演示内容渲染。不是微信真机截图，不证明业务流程已验收。点点照片仅用于本机文稿展示，不写入业务缓存、云端或真实日记。日期与日记文字为演示。截图含授权私人照片，目录由 Git 忽略。\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Publication derivatives of Antigravity's design; original delivery stays intact.
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const [packageRoot, repoRoot] = process.argv.slice(2);
const runtimeRequire = createRequire(path.join(packageRoot, '__contest_publication__.cjs'));
const { chromium } = runtimeRequire('playwright');
const base = path.join(repoRoot, 'resources/document-assets/diagrams/contest');
const output = path.join(base, 'publication');
fs.mkdirSync(output, { recursive: true });
const tidyMarkup = text => text.replace(/[ \t]+$/gm, '').trimEnd() + '\n';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 2 });
    for (const name of ['product-structure', 'record-confirmation', 'architecture']) {
      const source = fs.readFileSync(path.join(base, 'antigravity', name + '.svg'), 'utf8');
      const html = source.slice(source.indexOf('<!DOCTYPE html>'), source.lastIndexOf('</html>') + 7);
      if (!html || /<script\b/i.test(html)) throw new Error('Expected a static HTML/CSS design');
      await page.setContent(html);
      await page.evaluate(name => {
        document.querySelectorAll('.badge,.subtitle,.footer-bar,.col-tag,.card-tag,.zone-tag').forEach(n => n.remove());
        const title = document.querySelector('.title');
        const replaceBoxes = (selector, entries) => {
          const nodes = [...document.querySelectorAll(selector)];
          if (nodes.length !== entries.length) throw new Error('Unexpected diagram structure: ' + selector);
          nodes.forEach((n, i) => {
            n.querySelector('h4,h5').textContent = entries[i][0];
            n.querySelector('p').innerHTML = entries[i][1];
          });
        };
        if (name === 'product-structure') {
          title.textContent = '三个入口的功能分工';
          replaceBoxes('.item-card', [
            ['文字与照片', '随手说一句，发一张照片'], ['待确认草稿', '核对日期与正文后保存'],
            ['历史查询', '查日期，并打开原记录'], ['话题上下文', '按需读取前文与历史话题'],
            ['竖线时间轴', '按发生日期回看日常'], ['照片画廊', '同一批日记的照片视角'],
            ['日记管理', '查看、编辑与逻辑删除'], ['原文对照', '整理正文与原始输入并存'],
            ['宠物档案', '照片与三款内置头像'], ['家庭空间', '邀请家人，共享宠物日记'],
            ['模型连接', '云开发 AI 或自定义 API'], ['身份隔离', '按账号与家庭管理缓存']
          ]);
          document.querySelectorAll('.col-role').forEach((n, i) => n.textContent = ['表达与查询', '浏览与回看', '档案与配置'][i]);
        } else if (name === 'record-confirmation') {
          title.textContent = '用户确认后才成为正式记录';
          replaceBoxes('.box', [
            ['文字原话', '明确发生的事实'], ['生活照片', '可单独形成草稿'],
            ['AI 辅助整理', '整理正文与标签'], ['程序核对', '原文出处与日期'],
            ['纯照片草稿', '无需文字摘取<br/>记录日期由用户确认'],
            ['检查这条记录', '日期 正文<br/>标签 照片'],
            ['身份与家庭鉴权', '通过 diaryApi 接口'], ['保存两份内容', '整理结果与原始输入'],
            ['进入时光册', '可以查询与回看']
          ]);
          document.querySelectorAll('.b-desc').forEach((n, i) => n.textContent = ['写入云端', '重新核对', '丢弃草稿'][i]);
          document.querySelectorAll('.card-title').forEach((n, i) => n.innerHTML = `<span class="step-num ${i === 2 ? 'orange' : ''}">${i + 1}</span> ${['输入', '草稿', '用户确认', '保存'][i]}`);
        } else {
          title.textContent = '模型 程序 用户与云端的分工';
          replaceBoxes('.node-box', [
            ['交互页面', '聊聊 · 时光册 · 我的'],
            ['客户端 Agent', '组织上下文，选择工具路径'],
            ['四项工具', '查询记录 / 生成草稿<br/>读取当前话题 / 读取历史话题'],
            ['程序校验与计算', '核对文字出处与日期<br/>限定宠物范围，生成条数与引用'],
            ['微信云开发 AI / 自定义 API', '理解表达，选择工具，整理文字<br/>模型没有直接保存日记的工具'],
            ['本机已同步缓存', '查询读取当前宠物的已同步记录<br/>按账号与家庭隔离'],
            ['云函数 diaryApi', '处理微信身份与家庭权限<br/>用户确认后保存，管理照片访问'],
            ['家庭云端', '保存宠物档案、日记与私有照片<br/>整理结果与原始输入并存']
          ]);
          document.querySelectorAll('.zone-title').forEach((n, i) => n.textContent = ['客户端工具与校验', '模型服务', '记录与数据访问'][i]);
        }
        const css = document.createElement('style');
        css.textContent = `body{padding:0;display:block}#canvas-container{width:1040px;padding:24px}.header{margin-bottom:22px}.title{font-size:25px;letter-spacing:0}.grid{gap:18px}.col-title,.card-title,.zone-title{font-size:22px}.col-role{font-size:18px;margin-top:5px}.col-header,.card-header,.zone-header{padding:13px}.col-body,.card-body,.zone-body{padding:13px;gap:10px}.item-card{padding:11px}.item-card h4,.box h5,.node-box h5{font-size:19px;line-height:1.4;margin-bottom:6px}.item-card p,.box p,.node-box p{font-size:18px;line-height:1.55}.card-body .box,.node-box{padding:11px}.b-tag,.b-desc{font-size:17px;line-height:1.4}.b-tag{white-space:nowrap;padding:3px 6px}.branch-card{padding:8px;gap:8px}.step-num{font-size:18px}.arch-grid{grid-template-columns:1.15fr 1fr;gap:18px}.dot{display:none}.col-icon{font-size:18px}.branch-group{gap:10px}`;
        document.head.append(css);
      }, name);
      await page.evaluate(() => document.fonts.ready);
      const bounds = await page.locator('#canvas-container').boundingBox();
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.col,.card,.zone,.item-card,.box,.node-box')].some(n => n.scrollWidth > n.clientWidth + 1));
      if (overflow) throw new Error(name + ': text overflow');
      const htmlOut = await page.content();
      fs.writeFileSync(path.join(output, name + '.html'), tidyMarkup(htmlOut));
      const xhtml = await page.evaluate(() => new XMLSerializer().serializeToString(document.documentElement));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
      fs.writeFileSync(path.join(output, name + '.svg'), tidyMarkup(svg));
      await page.locator('#canvas-container').screenshot({ path: path.join(output, name + '.png') });
      let mmd = fs.readFileSync(path.join(base, 'antigravity', name + '.mmd'), 'utf8');
      mmd = mmd.replace('· 支持离线与毫秒级快速响应', '· 按账号与家庭隔离').replace('宠物成长档案', '宠物档案');
      fs.writeFileSync(path.join(output, name + '.mmd'), mmd);
      console.log(name + ': ' + bounds.width + ' x ' + bounds.height + ', publication derivative');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

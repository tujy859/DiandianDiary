/* Use the Node runtime and package root returned by load_workspace_dependencies. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [packageRoot, mermaidScript, repoRoot] = process.argv.slice(2);
if (!packageRoot || !mermaidScript || !repoRoot) throw new Error('Expected package root, Mermaid script and repository root');
const runtimeRequire = createRequire(path.join(packageRoot, '__contest_builder__.cjs'));
const { chromium } = runtimeRequire('playwright');
const diagramRoot = path.join(repoRoot, 'resources/document-assets/diagrams/contest');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1800 }, deviceScaleFactor: 2 });
    await page.setContent('<html><head><meta charset="utf-8"><style>body{margin:0;background:white;font-family:"Microsoft YaHei",sans-serif}#figure{display:inline-block;padding:12px}svg{display:block}</style></head><body><div id="figure"></div></body></html>');
    await page.addScriptTag({ path: mermaidScript });
    await page.evaluate(() => mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'base',
      themeVariables: {
        fontFamily: 'Microsoft YaHei, sans-serif', fontSize: '19px',
        primaryColor: '#F2F6F1', primaryTextColor: '#253D31', primaryBorderColor: '#648370',
        lineColor: '#648370', secondaryColor: '#FFF2E4', tertiaryColor: '#FAF8F3',
        edgeLabelBackground: '#FFFFFF', clusterBkg: '#FAF8F3'
      },
      flowchart: { htmlLabels: false, curve: 'linear', nodeSpacing: 26, rankSpacing: 32, padding: 15, useMaxWidth: false }
    }));
    for (const name of ['product-structure', 'record-confirmation', 'architecture']) {
      const source = fs.readFileSync(path.join(diagramRoot, name + '.mmd'), 'utf8');
      const svg = await page.evaluate(async ({ source, name }) => {
        const result = await mermaid.render('diagram-' + name, source);
        document.querySelector('#figure').innerHTML = result.svg;
        return result.svg;
      }, { source, name });
      fs.writeFileSync(path.join(diagramRoot, name + '.svg'), svg);
      await page.locator('#figure').screenshot({ path: path.join(diagramRoot, name + '.png') });
      console.log(name + ': ' + JSON.stringify(await page.locator('#figure').boundingBox()));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

/**
 * 品牌图标构建：手绘 SVG（app icon 风格：深棕描边 + 奶油底 + 橘/绿点缀）
 * SVG 源文件输出到 resources/icons-src/*.svg（不入包），
 * 透明底 PNG（96px）输出到 assets/icons/*.png（运行时资源，入包）
 * 运行：node tools/icons/build.js（需 NODE_PATH 指向受管 node 工作区）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', '..', 'assets', 'icons');
const SRC = path.join(__dirname, '..', '..', 'resources', 'icons-src');

const S = '#4A3728'; // 深棕描边
const CREAM = '#FFF6E8';
const ORANGE = '#E8833A';
const PEACH = '#F5C9A0';
const GREEN = '#7FB685';
const MINT = '#BFE3D0';

const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${body}</svg>`;

const icons = {
  cat: wrap(`
    <path d="M14 18 L11 8 L21 13 M34 18 L37 8 L27 13" fill="${CREAM}" stroke="${S}" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="24" cy="26" r="13" fill="${CREAM}" stroke="${S}" stroke-width="2.2"/>
    <circle cx="19.5" cy="24" r="1.6" fill="${S}"/><circle cx="28.5" cy="24" r="1.6" fill="${S}"/>
    <path d="M21 29.5 Q24 32 27 29.5" fill="none" stroke="${S}" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="24" cy="27.5" r="1.2" fill="${ORANGE}"/>`),

  dog: wrap(`
    <ellipse cx="11" cy="25" rx="4.5" ry="10" fill="${PEACH}" stroke="${S}" stroke-width="2.2" transform="rotate(8 11 25)"/>
    <ellipse cx="37" cy="25" rx="4.5" ry="10" fill="${PEACH}" stroke="${S}" stroke-width="2.2" transform="rotate(-8 37 25)"/>
    <circle cx="24" cy="25" r="12" fill="${CREAM}" stroke="${S}" stroke-width="2.2"/>
    <circle cx="19.5" cy="23" r="1.6" fill="${S}"/><circle cx="28.5" cy="23" r="1.6" fill="${S}"/>
    <ellipse cx="24" cy="27.5" rx="2.2" ry="1.7" fill="${S}"/>
    <path d="M24 29.2 Q24 32.5 21 32.5 M24 29.2 Q24 32.5 27 32.5" fill="none" stroke="${S}" stroke-width="1.6" stroke-linecap="round"/>`),

  paw: wrap(`
    <ellipse cx="24" cy="30" rx="8.5" ry="6.5" fill="${PEACH}" stroke="${S}" stroke-width="2.2"/>
    <circle cx="15.5" cy="19.5" r="3.2" fill="${PEACH}" stroke="${S}" stroke-width="2"/>
    <circle cx="24" cy="15.5" r="3.2" fill="${PEACH}" stroke="${S}" stroke-width="2"/>
    <circle cx="32.5" cy="19.5" r="3.2" fill="${PEACH}" stroke="${S}" stroke-width="2"/>`),

  pencil: wrap(`
    <g transform="rotate(35 24 24)">
      <rect x="20" y="10" width="8" height="20" rx="2.5" fill="${ORANGE}" stroke="${S}" stroke-width="2.2"/>
      <path d="M20 30 L24 38 L28 30 Z" fill="${CREAM}" stroke="${S}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="24" cy="34.5" r="1.2" fill="${S}"/>
    </g>
    <path d="M34 36 l4 0 M37 33 l3 3" stroke="${GREEN}" stroke-width="2.2" stroke-linecap="round"/>`),

  bath: wrap(`
    <circle cx="19" cy="12" r="2.5" fill="${MINT}" stroke="${S}" stroke-width="1.6"/>
    <circle cx="27" cy="9" r="1.8" fill="${MINT}" stroke="${S}" stroke-width="1.4"/>
    <path d="M11 20 h26 v6 a7 7 0 0 1 -7 7 H18 a7 7 0 0 1 -7 -7 Z" fill="${MINT}" stroke="${S}" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M16 33 v4 M32 33 v4" stroke="${S}" stroke-width="2.2" stroke-linecap="round"/>`),

  pill: wrap(`
    <g transform="rotate(-40 24 24)">
      <rect x="12" y="19" width="24" height="11" rx="5.5" fill="${CREAM}" stroke="${S}" stroke-width="2.2"/>
      <path d="M24 19 h6.5 a5.5 5.5 0 0 1 0 11 H24 Z" fill="${ORANGE}" stroke="${S}" stroke-width="1.8"/>
    </g>`),

  heart: wrap(`
    <path d="M24 19 C23 15 17 13 13.5 16.5 C10 20 15 25.5 24 31 C33 25.5 38 20 34.5 16.5 C31 13 25 15 24 19 Z" fill="${PEACH}" stroke="${S}" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M10 24 h5 l2.5 -5 3 8 2.5 -6 2 3 h5" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),

  book: wrap(`
    <path d="M11 12 Q17 9.5 24 12 Q31 9.5 37 12 V36 Q31 33.5 24 36 Q17 33.5 11 36 Z" fill="${ORANGE}" stroke="${S}" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M24 12 V36" stroke="${S}" stroke-width="1.8"/>
    <path d="M15 18 q3.5 -1.2 6 0 M27 18 q3.5 -1.2 6 0" stroke="${CREAM}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`),

  calendar: wrap(`
    <rect x="11" y="13" width="26" height="23" rx="3" fill="${CREAM}" stroke="${S}" stroke-width="2.2"/>
    <path d="M11 20 h26" stroke="${S}" stroke-width="1.8"/>
    <path d="M17 9 v5 M31 9 v5" stroke="${S}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="18" cy="26" r="1.5" fill="${GREEN}"/><circle cx="24" cy="26" r="1.5" fill="${ORANGE}"/><circle cx="30" cy="26" r="1.5" fill="${GREEN}"/>
    <circle cx="18" cy="31" r="1.5" fill="${ORANGE}"/><circle cx="24" cy="31" r="1.5" fill="${GREEN}"/>`),

  image: wrap(`
    <rect x="11" y="12" width="26" height="22" rx="2.5" fill="${MINT}" stroke="${S}" stroke-width="2.2"/>
    <circle cx="29" cy="19" r="2.5" fill="${CREAM}" stroke="${S}" stroke-width="1.6"/>
    <path d="M11 28 L19 20 L25 27 L30 22 L37 28 V31 a2.5 2.5 0 0 1 -2.5 2.5 h-21 A2.5 2.5 0 0 1 11 31 Z" fill="${GREEN}" stroke="${S}" stroke-width="1.8" stroke-linejoin="round"/>`),

  leaf: wrap(`
    <path d="M36 12 C22 14 13 22 13 33 C13 36 15 37 17 37 C29 37 36 26 36 12 Z" fill="${MINT}" stroke="${S}" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M16 34 C21 27 28 21 34 16" fill="none" stroke="${S}" stroke-width="1.8" stroke-linecap="round"/>`),

  sparkle: wrap(`
    <path d="M24 10 L27 21 L38 24 L27 27 L24 38 L21 27 L10 24 L21 21 Z" fill="${PEACH}" stroke="${S}" stroke-width="2" stroke-linejoin="round"/>`),
};

(async () => {
  fs.mkdirSync(SRC, { recursive: true });
  for (const [name, svg] of Object.entries(icons)) {
    fs.writeFileSync(path.join(SRC, `${name}.svg`), svg.trim());
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(96, 96)
      .png()
      .toFile(path.join(OUT, `${name}.png`));
    console.log(`built ${name}.png`);
  }
})().catch((err) => { console.error(err); process.exit(1); });

"""Build the contest PDF from the Markdown source using bundled Python packages.

Pass --output PATH to choose a local output. Exports contain authorized private
pet photos, so the default exports/ directory is intentionally ignored by Git.
"""
import argparse
import html
import io
import re
from pathlib import Path

from PIL import Image as PILImage, ImageOps
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak, Flowable,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = HERE / 'contest-description.md'
FIGURES = ROOT / 'resources/document-assets/diagrams/contest/publication'
GREEN = colors.HexColor('#2F6048')
GRAY = colors.HexColor('#647269')
WIDTH, HEIGHT = A4
MARGIN = 45
CONTENT_WIDTH = WIDTH - 2 * MARGIN


def font_setup():
    windows = Path('C:/Windows/Fonts')
    pdfmetrics.registerFont(TTFont('BodyCJK', str(windows / 'msyh.ttc'), subfontIndex=0))
    pdfmetrics.registerFont(TTFont('BoldCJK', str(windows / 'msyhbd.ttc'), subfontIndex=0))
    pdfmetrics.registerFontFamily('BodyCJK', normal='BodyCJK', bold='BoldCJK', italic='BodyCJK', boldItalic='BoldCJK')


def styles():
    common = dict(fontName='BodyCJK', textColor=colors.HexColor('#24322A'), wordWrap='CJK', allowWidows=0, allowOrphans=0)
    return {
        'title': ParagraphStyle('title', fontName='BoldCJK', fontSize=28, leading=40, textColor=colors.black, spaceAfter=5, wordWrap='CJK'),
        'h1': ParagraphStyle('chapter', fontName='BoldCJK', fontSize=20, leading=30, textColor=colors.black, spaceBefore=0, spaceAfter=13, keepWithNext=True, wordWrap='CJK'),
        'h2': ParagraphStyle('subheading', fontName='BoldCJK', fontSize=12.5, leading=20, textColor=colors.black, spaceBefore=10, spaceAfter=6, keepWithNext=True, wordWrap='CJK'),
        'body': ParagraphStyle('body', fontSize=10.5, leading=17.2, spaceAfter=9, **common),
        'caption': ParagraphStyle('caption', fontSize=8.3, leading=12.5, spaceBefore=4, spaceAfter=10, **common),
        'meta': ParagraphStyle('metadata', fontSize=9, leading=15, spaceAfter=6, **common),
        'table': ParagraphStyle('cell', fontSize=9, leading=14, **common),
        'thead': ParagraphStyle('headercell', fontName='BoldCJK', fontSize=9, leading=14, textColor=colors.white, wordWrap='CJK'),
    }


def inline(text):
    text = html.escape(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`(.+?)`', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1', text)
    # A long URL needs a modest smaller face without character-space expansion.
    if text.startswith('赛事入口：'):
        return '赛事入口：<link href="https://contest.weixin.qq.com/eventDetails?id=4598379302114656257" color="#2F6048">微信小程序开发大赛官网</link>'
    return text


def image_bytes(filename):
    with PILImage.open(filename) as source:
        im = ImageOps.exif_transpose(source)
        im.thumbnail((2000, 2000))
        buf = io.BytesIO()
        if 'A' in im.getbands() or im.mode == 'P':
            im.convert('RGBA').save(buf, 'PNG')
        else:
            im.convert('RGB').save(buf, 'JPEG', quality=94)
        buf.seek(0)
        return buf, im.size


def figure(filename, max_width, max_height):
    data, (w, h) = image_bytes(filename)
    scale = min(max_width / w, max_height / h)
    item = Image(data, width=w * scale, height=h * scale)
    item.hAlign = 'CENTER'
    item.spaceBefore = 5
    item.spaceAfter = 5
    return item


class ImageRow(Flowable):
    def __init__(self, paths, labels, height=240, gap=16, show_labels=True, framed=False):
        super().__init__()
        self.width = CONTENT_WIDTH
        self.height = height + (26 if show_labels else 10)
        self.gap = gap
        self.labels = labels if show_labels else []
        self.framed = framed
        self.figures = [figure(p, (CONTENT_WIDTH - gap * (len(paths) - 1)) / len(paths), height) for p in paths]
        self.spaceBefore = 5
        self.spaceAfter = 10

    def draw(self):
        cell_width = (self.width - self.gap * (len(self.figures) - 1)) / len(self.figures)
        for n, item in enumerate(self.figures):
            x = n * (cell_width + self.gap) + (cell_width - item.drawWidth) / 2
            y = self.height - item.drawHeight - (6 if self.framed else 4)
            if self.framed:
                padding = 4
                self.canv.saveState()
                self.canv.setStrokeColor(colors.HexColor('#B7C7BD'))
                self.canv.setFillColor(colors.white)
                self.canv.setLineWidth(.8)
                self.canv.roundRect(x - padding, y - padding,
                    item.drawWidth + padding * 2, item.drawHeight + padding * 2,
                    radius=8, stroke=1, fill=1)
                self.canv.restoreState()
            item.drawOn(self.canv, x, y)
            if self.labels:
                self.canv.setFont('BodyCJK', 8.2)
                self.canv.setFillColor(GRAY)
                self.canv.drawCentredString(n * (cell_width + self.gap) + cell_width / 2, 5, self.labels[n])


def make_table(rows, page, sty):
    count = len(rows[0])
    if count == 2:
        widths = [CONTENT_WIDTH * .34, CONTENT_WIDTH * .66]
    elif rows[0][0].strip() == '工具':
        widths = [123, 173, CONTENT_WIDTH - 296]
    else:
        widths = [81, 211, CONTENT_WIDTH - 292]
    data = [[Paragraph(inline(cell.strip()), sty['thead' if n == 0 else 'table']) for cell in row] for n, row in enumerate(rows)]
    table = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#3F4E47')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F4F6F4')]),
        ('GRID', (0, 0), (-1, -1), .45, colors.HexColor('#D9D9D9')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    table.spaceBefore = 5
    table.spaceAfter = 12
    return table


def page_decoration(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor('#FAF9F5'))
    canvas.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)
    canvas.setFont('BodyCJK', 8)
    canvas.setFillColor(colors.black)
    if doc.page > 1:
        canvas.drawString(MARGIN, HEIGHT - 27, '记一下喵  DiandianDiary')
    canvas.setFillColor(GRAY)
    canvas.drawString(MARGIN, 25, '参赛作品说明  2026 年 10 月')
    canvas.drawRightString(WIDTH - MARGIN, 25, str(doc.page))
    canvas.restoreState()


def build(output):
    font_setup()
    sty = styles()
    pages = SOURCE.read_text(encoding='utf-8').split('<!-- pagebreak -->')
    flowables = []
    diagram_names = iter(['product-structure', 'record-confirmation', 'architecture'])
    for page_number, content in enumerate(pages):
        if page_number:
            flowables.append(PageBreak())
        lines = content.strip().splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            if not line:
                i += 1
                continue
            if line.startswith('```mermaid'):
                name = next(diagram_names)
                i += 1
                while i < len(lines) and not lines[i].strip().startswith('```'):
                    i += 1
                max_height = {'product-structure': 310, 'record-confirmation': 310, 'architecture': 390}[name]
                flowables.append(figure(FIGURES / (name + '.png'), CONTENT_WIDTH, max_height))
            elif line.startswith('!['):
                matches = []
                labels = []
                while i < len(lines) and lines[i].strip().startswith('!['):
                    match = re.fullmatch(r'!\[(.*?)\]\((.*?)\)', lines[i].strip())
                    if not match:
                        raise ValueError('Invalid image syntax: ' + lines[i])
                    matches.append((HERE / match.group(2)).resolve())
                    labels.append(match.group(1))
                    i += 1
                if len(matches) > 1:
                    is_ux = 'contest-ux' in str(matches[0])
                    is_pet_art = 'resources\\pets' in str(matches[0]) or 'resources/pets' in str(matches[0])
                    height = 330 if is_ux else 105 if is_pet_art else 125 if len(matches) == 3 else 240
                    flowables.append(ImageRow(matches, labels, height=height, gap=24 if is_ux else 16, framed=is_ux))
                else:
                    height = 210 if page_number == 0 else 170
                    flowables.append(figure(matches[0], CONTENT_WIDTH, height))
                continue
            elif line.startswith('|'):
                rows = []
                while i < len(lines) and lines[i].strip().startswith('|'):
                    cells = lines[i].strip().strip('|').split('|')
                    if not all(re.fullmatch(r'\s*:?-+:?\s*', cell) for cell in cells):
                        rows.append(cells)
                    i += 1
                flowables.append(make_table(rows, page_number, sty))
                continue
            elif line.startswith('# '):
                flowables.append(Spacer(1, 12))
                flowables.append(Paragraph(inline(line[2:]), sty['title']))
            elif line.startswith('## '):
                flowables.append(Paragraph(inline(line[3:]), sty['h1']))
            elif line.startswith('### '):
                flowables.append(Paragraph(inline(line[4:]), sty['h2']))
            else:
                texts = [line]
                i += 1
                while i < len(lines) and lines[i].strip() and not lines[i].startswith(('#', '|', '![', '```')):
                    texts.append(lines[i].strip())
                    i += 1
                text = ''.join(texts)
                kind = 'caption' if text.startswith(('图 ', '点点是我家猫的名字，也是这个项目的起点。照片', '这张随手拍下的照片')) else 'body'
                if page_number == 0 and text.startswith(('DiandianDiary', '用途：', '功能截止日期：', '阅读内容：')):
                    kind = 'meta'
                flowables.append(Paragraph(inline(text), sty[kind]))
                continue
            i += 1
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(output), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=48, bottomMargin=44, title='记一下喵参赛作品说明', author='记一下喵',
        subject='宠物生活记录与时光回看 微信小程序作品说明', pageCompression=1)
    doc.build(flowables, onFirstPage=page_decoration, onLaterPages=page_decoration)
    print(str(output))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=HERE / 'exports/diandian-diary-contest-20261015.pdf')
    args = parser.parse_args()
    build(args.output)

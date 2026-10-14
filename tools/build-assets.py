"""Export small PNGs without changing design originals. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageOps
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
lock = []
for item in json.loads((ROOT / 'tools/assets-manifest.json').read_text(encoding='utf-8')):
    source, target = ROOT / item['source'], ROOT / item['target']
    image = ImageOps.exif_transpose(Image.open(source)).convert('RGBA')
    image.thumbnail((item['width'], item['width']), Image.Resampling.LANCZOS)
    image = image.quantize(colors=item['colors'], method=Image.Quantize.FASTOCTREE)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, optimize=True)
    if target.stat().st_size > 50 * 1024:
        raise ValueError(f'{target.name} exceeds the 50 KiB asset budget')
    lock.append({**item, 'sourceSha256': digest(source), 'targetSha256': digest(target)})
    print(f"{item['target']}: {target.stat().st_size:,} bytes")
(ROOT / 'tools/assets-lock.json').write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')

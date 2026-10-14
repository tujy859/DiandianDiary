# resources —— 项目资产（不进代码包）

> 本目录及其子目录**不会被打进小程序代码包**（已在 `project.config.json` 的 `packOptions.ignore` 中配置 `{ "type": "folder", "value": "resources" }`）。

## 目录约定

| 目录 | 内容 | 入包 |
| --- | --- | --- |
| `resources/` | 设计源稿、品牌原图、AI 生成图、SVG 源文件、文档附件 | ❌ 不打包 |
| `assets/` | 运行时资源：代码里实际引用到的图片/图标 | ✅ 打包 |
| `docs/` | 技术文档、说明、HTML 预览 | ❌ 不打包 |
| `tools/` | 构建脚本（如图标生成） | ❌ 不打包 |

> 另外 `*.md`、`.html` 后缀的文件全局不打包，因此新增文档无需再改配置。

## 子目录说明

- `resources/brand/` —— logo / app icon 设计稿、原始高清图。上线前应导出压缩版本后再放入 `assets/`
- `resources/illustrations/` —— 空状态插画源图（PNG 原图）；已压缩出 WebP 版本放在 `assets/illustrations/`，用于时光册空状态、画廊空状态和日记不存在页
- `resources/pets/` —— 宠物默认头像 AI 生成源图 + 生成提示词（`generation-prompts.json`）
- `resources/icons-src/` —— 图标 SVG 源文件，由 `tools/icons/build.js` 生成到 `assets/icons/*.png`

## 插画接入与压缩

`resources/illustrations/*.png` 为原图（264KB / 264KB / 169KB），不进包。接入时转 WebP：

```bash
# 用 tools 的 Python 环境执行 Pillow 转换，源文件保持不动
python -c "from PIL import Image; import os; \
[Image.open(f'resources/illustrations/{n}.png').save(f'assets/illustrations/{n}.webp','WEBP',quality=85,method=6) \
 for n in ['empty-album','empty-gallery','missing-diary']]"
```

压缩结果：263KB → 17KB / 263KB → 15KB / 169KB → 11KB，合计 43KB。

## 使用原则

1. **新资产一律先放 `resources/`**，只有在代码中真正被 `/assets/xxx` 引用时才放进 `assets/`
2. 放入 `assets/` 前先压缩：PNG 建议走 tinyPNG / `sharp`，单张尽量 < 50KB
3. 超过 100KB 的图片优先考虑云存储 URL 或 CDN，不要塞进代码包
4. 主包目标：< 1.5MB，总包上限 4MB

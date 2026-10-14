# 设计源资源（不进入小程序代码包）

高清品牌图、头像、插画、图标源稿放在本目录。`project.config.json` 将整个 `resources/` 排除，即使以后增加大文件也不会进入代码包。文档统一放 `docs/`，同样整目录排除。

| 目录 | 内容 |
| --- | --- |
| `brand/` | 用户提供的品牌 icon 原图 |
| `pets/` | 三个头像原图、生成提示词和资源目录 |
| `illustrations/` | 现有相册、画廊、日记缺失空状态插画原图 |
| `icons-src/` | 复用的品牌功能图标 SVG 及对应 PNG 源文件 |

真正被页面引用的小尺寸导出文件放 `assets/`。生成配置在 `tools/assets-manifest.json`，通过 `npm run assets:build` 导出；所有 PNG 都保留原图，单张运行时图片上限 50 KiB。见 [打包与资源维护](../docs/package-size.md)。

`pets/avatar-options.json` 用于设计资源检索；实际页面的头像 ID、物种和路径由 `utils/pet-avatars.ts` 统一提供，云端只保存稳定 ID。

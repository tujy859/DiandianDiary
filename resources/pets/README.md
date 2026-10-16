# 默认宠物头像

## 可选头像资源

原有奶油橘猫保留，另补充两种同画风头像，均为透明背景 PNG：

| 文件 | 名称 | 设计依据 |
| --- | --- | --- |
| `default-cat-v1.png` | 奶油橘猫 | 已确认的默认猫头像 |
| `british-longhair-gray-v1.png` | 灰毛英长 | 用户自家英国长毛猫的照片：灰色长毛、金色眼睛、蓬松脸颊 |
| `default-dog-v1.png` | 奶油小狗 | 同画风奶油色脸、杏色垂耳的小狗 |

`avatar-options.json` 记录资源 ID、名称、物种和小程序内路径，供后续头像选择功能使用；小程序的添加/编辑宠物表单已接入头像选择；实际运行时目录由 `utils/pet-avatars.ts` 提供。

新增头像通过内置 ImageGen 生成；完整提示词见 `generation-prompts.json`。头像生成阶段的真实猫照片仅作为参考，未作为运行时头像入包。用户后续授权的点点照片保存在本机、被 Git 忽略的 `resources/document-assets/private/diandian/`，用于[参赛说明文档](../../docs/deliverables/contest/README.md)；原图不覆盖生成头像。

## default-cat-v1.png

- 用途：猫类宠物尚未设置照片时的默认头像候选。
- 创建方式：2026-10-14，内置 ImageGen，用户提供的品牌 icon 仅作为画风参考。
- 透明背景 PNG；完整生成原图保留，不覆盖品牌 icon。
- 已导出小尺寸 PNG 并用于宠物档案、宠物切换和日记页；高清原图不入包。
- 设计：奶油色橘猫头像、深棕轮廓、杏橙额纹、桃色耳朵，适配小尺寸显示。

### 生成提示词

```text
Use case: illustration-story. Asset type: single default pet avatar for a clean warm Chinese pet diary mini-program named 记一下喵. Input image 1 is STYLE REFERENCE ONLY: cream orange cat, chocolate-brown rounded outlines, peach ears, friendly expression. Generate ONE square image containing ONE centered front-facing cat HEAD portrait only, no body, no book, no accessories. A rounded cream-colored kitten face, two softly triangular ears with pale peach centers, three small orange forehead stripes, two dark chocolate friendly eyes with small highlights, tiny peach nose and a soft small smiling W mouth, one short whisker on each side. Flat polished 2D illustration, warm and restrained, bold smooth rounded dark-brown contours, simple cream and apricot fills, no texture, no 3D, no realistic fur. Important composition: this is displayed at 44x44 and 32x32 CSS pixels in pet profile rows, so make the face large and recognizable occupying about 82% of canvas, keep generous safe clearance around ears and whiskers, do not crop. Genuinely transparent background, no colored tile or circular frame behind head, no shadow, no text, no watermark. The head silhouette should be broad and softly rounded, cozy and approachable. This is a pet identity avatar distinct from the full cat-with-diary brand illustration.
```

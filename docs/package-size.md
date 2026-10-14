# 代码包体积与资源维护

## 目录边界

- `assets/`：页面真正使用的小尺寸运行时图片，单张不超过 50 KiB。
- `resources/`：品牌原图、生成头像原图、插画和图标源文件，整目录不入包。
- `docs/`：说明、设计记录、预览、PDF、Word 等文档，整目录不入包。
- `tools/`、`cloudfunctions/`、依赖安装目录及本地备份不进入小程序包；云函数单独部署。
- 未注册的 TDesign 示例页保留在仓库，通过 `packOptions.ignore` 排除。正式页面以 `app.json` 为准。新增页面若位于排除目录，需要同时调整配置，CI 会检查已注册页面没有被误排除。

此外，配置会排除散落的常见文档/设计格式（`.md`、`.html`、`.pdf`、`.docx`、`.pptx`、`.xlsx`、`.csv`、`.tsv`、`.psd`、`.sketch`、`.fig`、`.zip`），但仍应优先将它们放到 `docs/` 或 `resources/`。不要把源图复制到 `assets/`，也不要依赖“忽略未使用文件”作为唯一体积保护。

## 新增或更新资源

1. 将原始文件放到 `resources/`；不要覆盖旧版本，除非明确要替换它。
2. 在 `tools/assets-manifest.json` 指定源文件、运行时目标、尺寸和调色板颜色数。
3. 安装 Python/Pillow 并导出：

   ```sh
   python -m pip install -r tools/requirements-assets.txt
   cd tools
   npm run assets:build
   npm run check:package
   ```

4. 页面只引用导出的 `/assets/...` 路径；一起提交源图、导出文件、manifest 和 `tools/assets-lock.json`。

导出脚本按显示尺寸缩放、优化 PNG 调色板并保留透明通道，没有额外引入图片解码依赖。品牌图 192px，头像 128px，功能图标 96px，空状态插画最长边 320px；原始高清图不改变。lock 文件记录源图与导出图片的 SHA-256，CI 能发现改了原图却忘记重新导出。

## 体积门槛

运行 `cd tools && npm run check:package`。CI 在每次 push/PR 时同样执行：

- 按项目的实际 `packOptions.ignore` 规则扫描。
- 源码字节预算 1500 KiB，作为项目自行设定的保守维护门槛，不是微信官方包体积测量值。
- 运行时图片单张 50 KiB。
- 超限时失败，并输出最大文件路径；高清原图误入 `assets/` 也会失败。
- 验证资源导出未过期、注册页面未被排除。

统计包含保留下来的运行时组件库，未依赖“忽略未使用文件”缩小报告数字；它是编译/压缩前的源文件估算，不等同于开发者工具最终产物。上传前仍应在微信开发者工具的代码包分析中检查实际主包/分包体积。当前项目未使用分包；未来真实运行时代码接近预算时，再按功能拆分分包，不要将高清图和文档作为分包内容。

## UI 与云端头像

`utils/pet-avatars.ts` 提供猫、狗、其他的默认值和可选头像。旧宠物缺少头像 ID 时按物种回退；选择后的 ID 会在本机保存、云端保存和旧数据导入中携带。

云端同步需要重新部署本次修改后的 `cloudfunctions/diaryApi`。服务器校验头像 ID 与物种，旧客户端未传头像时保留原头像。无需数据库迁移。

以后新增头像时，还需同步更新 `utils/pet-avatars.ts` 的选项和云函数 `service.js` 的头像白名单。图标 SVG 修改后先导出对应 PNG 源文件，再运行资源构建。

旧插画已压缩并接到：时光册无日记、画廊无照片、日记缺失页面。它们不是后台下载资源，不需要 CDN 权限或额外网络请求。

## 微信开发者工具实际打包验证（2026-10-14）

已使用本机私有配置中的真实 AppID，通过 CLI 成功生成预览包。微信开发者工具报告 TOTAL 为 **548,966 字节（界面显示 536.1 KB）**，没有出现包体积超限。此前约 1007 KiB 的 CI 数字仍是保守源码估算，与最终编译压缩产物分开记录。

AppID 仅放在 `project.private.config.json`，该文件被 Git 和打包规则排除；没有修改仓库中的 `touristappid` 占位配置，也没有执行正式版本上传。模拟器验证结果与截图见 [UI 实测记录](ui-implementation/README.md#微信模拟器实测)。

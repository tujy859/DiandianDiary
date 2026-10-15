# 项目协作说明

## 项目背景

- 记一下喵（DiandianDiary）是通过聊天记录宠物生活、用时间轴和照片画廊回看陪伴时光的微信小程序。
- 主入口是聊聊、时光册、我的；支持宠物档案、家庭共享、日记管理和聊天话题。
- 前端使用原生 WXML / WXSS / TypeScript、WebView 和 TDesign，组件构建产物在 `miniprogram_npm/`。
- 后端为微信 CloudBase 云函数 `cloudfunctions/diaryApi/`；客户端入口为 `utils/cloud.ts`，环境配置为 `utils/cloud-config.ts`。
- 当前交互要求云端登录和模型配置。已确认日记与照片保存到家庭云端，本机保存缓存和当前会话。不要根据历史文档恢复已移除的本机模式或迁移入口。
- 模型生成待确认草稿，用户确认后保存，并保留原始输入。模型推断不得冒充用户事实；不明确的日期由用户补充。

## 开始工作前

1. 检查 Git 状态、分支和 worktree，确认实际代码位置；保留未提交的本地成果，不覆盖或清理无关修改。
2. 阅读 [README](README.md)、[文档索引](docs/README.md)和[开发记录](docs/development-log.md)，再查相关专题。
3. 历史日志、探索和截图描述当时状态，不自动代表当前代码或验收结果。矛盾之处先核对实现。
4. 用户当前指示优先于本文；改变设计方向时同步更新说明。

<!-- CODEGRAPH_START -->
## CodeGraph

根目录存在 `.codegraph/` 时，理解或定位代码应优先使用 CodeGraph，再使用文本搜索或逐文件阅读：

- MCP：`codegraph_explore`；如工具被延迟加载，先按名称发现。查询中写出文件或符号，可获取当前源码与调用关系。
- Shell：`codegraph explore "符号名称或问题"`。

没有 `.codegraph/` 时跳过，不自行建立索引；是否索引由用户决定。
<!-- CODEGRAPH_END -->

## 产品与 UX 设计

- 整体是“清爽耐看，带一点可爱”：暖白底、深绿主色、少量杏橙点缀，减少厚重阴影和重复装饰。
- 品牌小猫与宠物身份分开：品牌图用于欢迎区和品牌区；宠物身份使用照片或内置头像。
- 时光册保留竖线、圆点时间轴和画廊切换；突出照片、正文，弱化辅助日期与标签。
- 聊聊保持简洁欢迎区与短标题快捷入口；保留话题历史、停止生成和草稿确认等功能。
- UI 修改须配套核对 WXML 字段与事件、TypeScript 数据与方法、WXSS 布局；图片路径不能直接塞入原 emoji 文本节点。
- 键盘避让、切页视口恢复及底部安全区是重点回归项。公共度量在 `utils/layout.ts`，须与 `custom-tab-bar/` 一致；当前导航内容高度为 112rpx。
- 头像入口为 `utils/pet-avatars.ts`，显式内置选择优先，否则保留上传照片。变更需兼顾云端校验、持久化和旧记录兼容。
- 参考 [UX 探索](docs/ui-exploration/README.md)、[UI 实现与验证](docs/ui-implementation/README.md)及 [UX 整合取舍](docs/ux-integration-2026-10-15.md)。

## 资源与文档位置

| 位置 | 用途 |
| --- | --- |
| `assets/` | 实际运行时引用的压缩图片，进入小程序包；不放高清源图、说明书或 PPT |
| `resources/brand/` | 品牌原图 |
| `resources/pets/` | 头像原图、生成提示词与设计清单 |
| `resources/illustrations/` | 空状态插画原图 |
| `resources/icons-src/` | 图标 SVG / PNG 源稿 |
| `resources/document-assets/` | 后续说明书、PPT 的参考资料、脱敏截图及图表源稿 |
| `docs/` | 技术说明、设计决策、开发日志和验证记录 |
| `docs/deliverables/` | 后续项目说明书、PPT、PDF；保存可编辑源文件及导出版本 |
| `docs/ui-exploration/`、`docs/ui-implementation/` | 历史 UX 方案、预览及验证截图，复用时注明版本 |

资源细则见 [资源索引](resources/README.md)和[包体说明](docs/package-size.md)。原图保留在 `resources/`，通过 `tools/assets-manifest.json` 和 `tools/build-assets.py` 生成受管理的运行时图片。不要覆盖设计原稿。`resources/`、`docs/`、`tools/` 不进入小程序包。

说明书与 PPT 以当前代码和已验证功能为依据，区分已实现、已部署、已验收、计划中。素材标明来源、日期、版本，使用演示数据或脱敏截图；不带入真实日记、私人照片、账号标识和凭据。优先引用已有素材，不重复复制大型原图。

## 开发记录与协作

- 共享记录统一维护在 [docs/development-log.md](docs/development-log.md)，不要创建 `.workbuddy/` 或以工具私有记忆代替文档。
- 重要功能、修复、合并或部署完成后更新日志：北京时间日期、原因与结果、取舍、实际验证及未完成事项。提交号已知时再填写，不猜测修改日期。
- 长期有效的规则更新到专题文档，日志链接过去；新增专题或交付物加入相应索引。
- 代码和相关文档一起保存到 Git，提交前核对差异和无关文件。分别报告提交、推送、部署及真机验收状态。
- 不同特性、缺陷修复和协作规则必须拆成独立 Git 提交；每个提交应能单独理解、验证和回退。同一特性的实现、测试及对应文档一起提交，不混入其他未完成工作。
- 提交信息采用 `type(scope): 简明说明`，例如 `feat(auth): 增加退出登录`、`fix(date): 保留用户明确年份`、`docs(workflow): 明确提交规范`。说明最终行为与原因，避免“更新”“修改一些问题”等笼统描述。
- 多项修改同时存在时，按文件或补丁精确暂存；提交前检查 `git diff --cached` 和安全检查，确认范围、测试与说明相符。用户要求先保存已有成果时，先提交已完成特性，再继续新特性；未要求时不重写既有提交，也不自动推送远端。
- 合并 worktree 前先保全本地改动，再解决功能差异；自动合并成功不等于语义正确，不用整目录覆盖替代整合。

## 验证与运行

在项目根目录运行：

```sh
npm --prefix tools run typecheck
npm --prefix tools test -- --ci --runInBand
npm --prefix tools run check:package
node tools/check-repository-security.cjs --staged
```

首次依赖安装见 README，云 SDK 适配测试需要 `cloudfunctions/diaryApi/` 的依赖。资源生成用 `npm --prefix tools run assets:build`，Python 依赖见 `tools/requirements-assets.txt`。

按改动选择验证：纯文档检查链接、差异及敏感信息；逻辑修改运行相关测试与类型检查；资源或打包修改检查包体；页面修改还需微信编译及适当交互验证。重点复核键盘、底部安全区、头像、话题恢复和日记保存。测试通过不能代替真实云环境或真机验收。

开发自检与 CI 共用 `utils/self-check.ts` 的核心用例；修改日期、草稿、查询或上下文时评估是否同步更新。核心自检仅用内存演示数据和固定参考日期，禁止读写业务缓存、切换真实登录 / 家庭作用域或请求网络。复杂场景留在专题自动化测试。

端侧「流程测试」须由用户显式启动，仅在当前用户独占的测试家庭及专用测试宠物中执行；复用正式页面的发送、确认保存和新话题动作，不替换全局 Storage 或复制另一套 agent。失败、停止或身份变化后停止后续步骤；只按本轮已确认 ID 清理，遇到其他记录保留现场。执行日志须限量、脱敏、可关闭。场景与维护规则见 [开发自检](docs/developer-self-check.md)。

## 云端与配置

- 云端操作先确认目标环境，部署结果写入开发记录。更新函数前尽可能下载可恢复备份到被忽略的 `backups/`。
- 部署函数不代表数据库权限、索引及业务读写已验收，不顺带清理数据或改变云环境配置；相关操作必须属于用户授权范围。
- 私有配置、密钥、令牌、数据库导出和个人媒体不提交。仓库使用占位 AppID；云环境 ID 是公共配置。详见[仓库安全](docs/repository-security.md)。

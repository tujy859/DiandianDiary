# 记一下喵 · DiandianDiary

[![CI](https://github.com/tujy859/DiandianDiary/actions/workflows/ci.yml/badge.svg)](https://github.com/tujy859/DiandianDiary/actions/workflows/ci.yml)

通过聊天记录宠物生活，在时间轴与照片画廊里回看陪伴时光的微信小程序。

## 当前功能

- **聊聊**：宠物切换、文字与照片输入、待确认记录卡、编辑面板、历史查询与原记录入口。
- **时光册**：时间轴和照片画廊共享记录，照片预览与日记详情。
- **我的**：宠物档案、设置与模型连接配置。
- **记录管理**：用户确认后保存，支持纯文字、纯照片和图文记录的编辑、删除。
- **云端与家庭空间**：微信身份连接、家庭创建与切换、一次性邀请、成员退出与创建者解散、共享宠物与日记、原始输入保存、本机旧数据导入。解散关闭访问并释放名额，云端数据暂时保留。需要配置并部署微信云开发。
- **模型接入**：模型自主选择工具，严格 JSON 降级；失败提供错误与重试，支持停止生成。
- **对话与跨轮记录**：按字符预算组织上下文，完整话题按需取回；「把刚才的记下来」可引用前文用户事实，原文另存。
- **事实查询**：区分驱虫、疫苗等具体事件，支持月份、周、最近 N 天及起止日期范围；日期、条数和引用由代码生成。

当前交互需要完成云端登录与模型配置，已确认的日记和照片保存到家庭云端，家庭成员共享同一宠物。本机 Storage 保存读取缓存和当前会话，尚未保存的照片留在小程序用户目录。后端设计、集合、权限规则、部署与双账号验收见 [云开发说明](docs/cloud-backend.md)。

## 开发运行

UI 已采用统一的暖白/深绿样式，宠物档案支持内置头像选择，时光册保留竖线时间轴。运行时资源位于 `assets/`；高清源图与文档分别放在不入包的 `resources/`、`docs/`，见 [打包与资源维护](docs/package-size.md)。

开发者可在「我的」点击 5 次「关于记一下喵」，开启「开发者工具 → 新手流程测试」，重走引导或在独立空白测试家庭中验证首只宠物与首条记录，并可返回原家庭。入口、数据边界与验证状态见 [新手流程测试说明](docs/new-user-testing.md)。

1. 使用微信开发者工具导入仓库根目录，项目类型选择小程序。
2. 仓库的 `project.config.json` 使用 `touristappid` 占位。在本机 `project.private.config.json` 中填写自己有权限的真实 `appid`；新环境可复制 `project.private.config.json.example`，已有文件只添加 `appid` 字段，保留其他设置。云开发和真机预览需要真实 AppID。
3. 项目使用原生 WXML / WXSS / TypeScript 和 WebView 渲染；TypeScript 由开发者工具编译。
4. TDesign 构建产物已包含在 `miniprogram_npm/`，当前预览不需要重新构建组件库。
5. 配置并部署微信云开发后端，完成引导中的登录与宠物设置。
6. 在引导或「我的 → 模型连接配置」填写自己的服务配置；真机请求域名还需按微信要求配置。

`project.private.config.json` 仅用于本机开发，已从 Git 排除。当前开发配置关闭了 URL 检查，不代表真实发布可以跳过合法域名和权限配置。

提交与推送前运行 `node tools/check-repository-security.cjs --staged`，检查暂存内容中的真实 AppID、常见密钥模式及禁止提交的本机文件；CI 也会检查仓库快照。这只是基础防护，不替代 GitHub 的凭据扫描。哪些文件不能提交、历史提醒如何处理，见 [仓库配置与凭据](docs/repository-security.md)。

## 逻辑层测试

需要 Node.js，CI 使用 Node.js 24。

```sh
cd tools
npm ci
npm run typecheck
npm run check:package
npm test -- --runInBand
```

首次运行新增的真实云 SDK 适配测试前，还需在 `cloudfunctions/diaryApi/` 执行 `npm ci --ignore-scripts`，CI 已包含该步骤。

测试覆盖日期、意图、数据存取、统一查询、模拟模型工具调用、JSON 校验、聊天页异步行为，以及云端身份、家庭权限、事务、照片归属、迁移与缓存隔离。CI 在每次 push、pull request 和手动触发时运行锁定依赖安装、类型检查与 Jest 测试。类型检查包括逻辑层、聊天、时光册、我的、日记详情、家庭页和草稿编辑器，微信 API 使用测试工程的最小声明；它不替代微信开发者工具编译，也不包含真实模型、云环境权限、键盘/布局或真机端到端验证。

真实模型的十四个交互场景可单独运行 `npm run eval:agent`，需要通过环境变量提供自己的服务配置，会产生模型请求费用。配置方式与能力边界见 [查询、记录与话题上下文](docs/query-and-tools.md)。本轮逻辑问题与公开 agent 实践对照见 [Agent 设计审查](docs/agent-review.md)。

## 主要目录

| 目录 | 内容 |
|---|---|
| `pages/chat/` | 聊天主屏、模型调用和记录卡交互 |
| `pages/album/` | 时间轴与画廊 |
| `pages/mine/` | 宠物管理与设置 |
| `pages/diary/` | 日记详情与编辑删除 |
| `pages/model/` | 模型连接设置 |
| `components/pending-card/` | 待确认记录卡 |
| `components/draft-editor/` | 草稿编辑面板 |
| `utils/store.ts` | 本地数据与照片持久化 |
| `utils/repository.ts` | 云端写入、分账号/家庭缓存、分页读取与旧数据导入 |
| `utils/cloud-config.ts` | 云环境 ID 配置 |
| `cloudfunctions/diaryApi/` | 微信身份、家庭授权、宠物/日记/私有照片接口 |
| `pages/family/` | 账号、家庭、邀请与数据导入入口 |
| `utils/agent.ts` | 工具定义、本地执行与多轮编排 |
| `utils/llm.ts` | 模型 HTTP 请求和返回解析 |
| `utils/intent.ts` | 本地规则演示、分类和查询 |
| `utils/query.ts` | 三种模式共用的事件与日期范围查询 |
| `utils/draft.ts` | 草稿事实与日期校验 |
| `utils/cancellation.ts` | 独立请求信号与取消 |
| `tools/` | 独立的逻辑层测试工程 |
| `docs/query-and-tools.md` | 当前查询、工具和降级行为说明 |
| `assets/` | 运行时资源，会打进代码包，仅放代码实际引用的图片 |
| `resources/` | 项目资产：设计原图、AI 生成源图、SVG 源文件，不进代码包 |

正式页面以 `app.json` 的 `pages` 字段为准。非运行期资源统一放在 `resources/`、`docs/`、`tools/`，三者已配置在 `project.config.json` 的 `packOptions.ignore` 中，另外 `*.md`、`*.html` 后缀全局忽略；新增资产或文档默认不会被打包。

## 项目文档

项目背景、设计原则和协作约定见 [AGENTS.md](AGENTS.md)。后续说明书和 PPT 放在[交付文档目录](docs/deliverables/README.md)，参考资料与图表源稿放在[文档素材目录](resources/document-assets/README.md)。

[文档索引](docs/README.md)汇总维护说明；重要修改、合并、部署及验收状态记录在[开发记录](docs/development-log.md)中，随代码提交更新。

## 当前已知限制

- 2026-10-15 已更新现有云环境的 `diaryApi`，查询状态为 `Active`；数据库权限、索引及双账号真机业务验收仍需核实，详见开发记录。
- 云模式暂不支持离线写入、实时推送、家庭创建者转让与完整修改历史。照片压缩后限 1MB，具体权限、存储和软删除行为见云开发说明。
- 具体事件按原文和明确标签匹配，不能仅凭药名或宽泛「医疗」标签推断驱虫；自然语言和旧记录仍可能存在歧义。
- 查询统计的是记录条数，不是从任意日记自动提取的真实事件次数；尚无语义检索/RAG。
- 记录日期无法明确解析时留空供用户点选；查询日期由模型理解、程序校验。支持范围与工具接口见 [查询说明](docs/query-and-tools.md)。
- 咨询建议仍来自模型或演示规则，尚未接入经过审核的养宠知识库；测试不能证明所有真实模型输出可靠。
- 模型服务若同时不支持工具调用和 JSON 输出约束，会显示错误和重试入口；JSON 降级不具备按需读取长对话的能力。
- 模型 API Key 当前保存在本机配置并由客户端直连使用。正式面向用户分发前需迁往经过身份校验的服务端中转，不应在仓库或客户端包里放置共享密钥。

接下来的重点是核对云环境配置并完成双账号真机验收，以及真实模型验证、服务端模型代理和备份维护。

## 许可与第三方代码

公开仓库不自动授予本项目原创代码开源许可；项目级许可证尚待维护者选择。

TDesign 组件及其衍生示例遵循其 MIT 许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [TDesign 原始许可](licenses/TDesign-MIT.txt)。

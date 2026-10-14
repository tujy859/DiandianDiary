# 记一下喵 · DiandianDiary

[![CI](https://github.com/tujy859/DiandianDiary/actions/workflows/ci.yml/badge.svg)](https://github.com/tujy859/DiandianDiary/actions/workflows/ci.yml)

通过聊天记录宠物生活，在时间轴与照片画廊里回看陪伴时光的微信小程序。

## 当前功能

- **聊聊**：宠物切换、文字与照片输入、待确认记录卡、编辑面板、历史查询与原记录入口。
- **时光册**：时间轴和照片画廊共享记录，照片预览与日记详情。
- **我的**：宠物档案、设置与模型连接配置。
- **记录管理**：用户确认后保存，支持纯文字、纯照片和图文记录的编辑、删除。
- **云端与家庭空间**：微信身份连接、家庭创建与切换、一次性邀请、共享宠物与日记、原始输入保存、本机旧数据导入。需要配置并部署微信云开发。
- **模型接入**：工具调用、严格 JSON 降级和本地规则演示兜底；每条回复标识来源，支持停止生成。
- **事实查询**：区分驱虫、疫苗等具体事件，支持月份、周、最近 N 天及起止日期范围；日期、条数和引用由代码生成。

默认使用本机模式，数据保存在微信 Storage 和小程序用户目录。已提供可部署的微信云开发后端，配置后在「我的 → 账号与家庭空间」连接：已确认的日记和照片保存到家庭云端，家庭成员共享同一宠物。后端设计、集合、权限规则、部署与双账号验收见 [云开发说明](docs/cloud-backend.md)。

## 开发运行

UI 已采用统一的暖白/深绿样式，宠物档案支持内置头像选择，时光册保留竖线时间轴。运行时资源位于 `assets/`；高清源图与文档分别放在不入包的 `resources/`、`docs/`，见 [打包与资源维护](docs/package-size.md)。

1. 使用微信开发者工具导入仓库根目录，项目类型选择小程序。
2. 仓库的 `project.config.json` 使用 `touristappid` 占位。在本机 `project.private.config.json` 中填写自己有权限的真实 `appid`；新环境可复制 `project.private.config.json.example`，已有文件只添加 `appid` 字段，保留其他设置。云开发和真机预览需要真实 AppID。
3. 项目使用原生 WXML / WXSS / TypeScript 和 WebView 渲染；TypeScript 由开发者工具编译。
4. TDesign 构建产物已包含在 `miniprogram_npm/`，当前预览不需要重新构建组件库。
5. 编译后可以不配置模型，先用明确标识的本地演示交互体验记录闭环。
6. 如需真实模型，在「我的 → 模型连接配置」填写自己的服务配置；真机请求域名还需按微信要求配置。

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

仓库保留部分 TDesign 示例页面和资源，不代表都已接入产品；正式页面以 `app.json` 为准。清理示例时需先检查引用，不能删除整个 `pages/`。

## 当前已知限制

- 未配置云开发时仍是本机存储。云模式需先部署云函数、创建集合并设置权限与索引；本工作区尚未完成真实云环境/双账号真机验收。
- 云模式暂不支持离线写入、实时推送、家庭创建者转让与完整修改历史。照片压缩后限 1MB，具体权限、存储和软删除行为见云开发说明。
- 具体事件按原文和明确标签匹配，不能仅凭药名或宽泛「医疗」标签推断驱虫；自然语言和旧记录仍可能存在歧义。
- 查询统计的是记录条数，不是从任意日记自动提取的真实事件次数；尚无语义检索/RAG。
- 未实现的时间表达会请求用户明确日期。支持范围与工具接口见 [查询说明](docs/query-and-tools.md)。
- 咨询建议仍来自模型或演示规则，尚未接入经过审核的养宠知识库；测试不能证明所有真实模型输出可靠。
- 模型服务若同时不支持工具调用和 JSON 输出约束，会明确降级为本地演示。
- 模型 API Key 当前保存在本机配置并由客户端直连使用。正式面向用户分发前需迁往经过身份校验的服务端中转，不应在仓库或客户端包里放置共享密钥。

接下来的重点是部署云环境并完成双账号真机验收，以及真实模型验证、服务端模型代理和备份维护。

## 许可与第三方代码

公开仓库不自动授予本项目原创代码开源许可；项目级许可证尚待维护者选择。

TDesign 组件及其衍生示例遵循其 MIT 许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [TDesign 原始许可](licenses/TDesign-MIT.txt)。

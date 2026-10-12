# 当前查询、工具调用与 JSON 降级说明

核对日期：2026-10-12。本文件描述现有实现；「建议扩展」不代表已经开发。

## 1. 查询在哪里执行

当前没有云端查询 API、向量库或 RAG。记录来自 `utils/store.ts` 的本机 Storage；`getRecords(petId)` 先按宠物过滤，再按发生日期倒序排列，同日按创建时间倒序。

有两条查询路径：

1. 真实模型路径：模型请求调用 `query_records`，`utils/agent.ts` 在本地执行查询，把结果作为 tool message 交回模型，再把最终回复和原记录引用交给页面。
2. 演示/JSON 回退路径：`utils/intent.ts` 的 `answerQuery` 按本地规则查询，再直接构造答复与引用。

它们目前有重复查询逻辑，扩展时应抽出一个共享查询函数，避免两个模式表现不一致。

## 2. 三个 tool

这些是模型工具协议中的函数，不是已部署的 HTTP 接口。前端通过 `chatTurn` 把定义交给模型，模型返回工具名称与参数后，由 `runAgent` 的分支执行代码。最多进行三轮模型请求。

| 工具 | 当前模型参数 | 本地实际行为 |
|---|---|---|
| `query_records` | `keyword`、可选 `limit`（默认 3） | 读取当前宠物记录，按宽分类/关键词匹配，截取前几条；计算总匹配记录数、最近记录日期与距今天数；为第一条命中生成引用 |
| `create_draft_record` | `text`、可选 `date`、`tags` | 只生成 `AgentDraft`；宠物 ID 来自调用上下文，第一张草稿附当前照片；不写正式日记 |
| `list_recent_records` | 可选 `limit`（默认 5） | 读取最近几条记录，返回日期、正文、标签及摘要，供模型参考 |

正式保存由 `pages/chat/chat.ts` 的 `onCardSave` 调用 `addRecord`，不是模型工具。当前没有供模型修改或删除正式记录的工具。

`queryRecords`、`listRecent` 当前是模块内函数；`runAgent`、`TOOLS`、`respond`、`answerQuery` 和 `getRecords` 等有导出。不存在带日期范围的统一 QueryOptions 接口。

## 3. 当前限制

- 「医疗」分类包含驱虫、疫苗、就医等。查驱虫会扩大到整个医疗分类，最近疫苗记录可能被误认为驱虫记录。
- 工具 schema 没有 startDate/endDate、eventType 或 latest/count/list 等参数，因而不支持可靠的时间范围查询。
- 本地 `answerQuery` 遇到「几次」返回全量匹配记录数，未按「这个月」过滤；记录条数也不必然等于真实事件次数。
- 工具返回确定性结果，但模型最终转述仍可能更改数字或日期；仅使用工具调用并不能保证回复事实无误。
- `limit` 缺少整数/边界校验，日期只用正则检查外观，尚未验证真实日历合法性。

## 4. 建议扩展的最小接口（尚未实现）

```ts
type RecordQueryOptions = {
  petId: string; // 执行器从当前请求注入，不让模型自行指定归属
  eventType?: 'bath' | 'deworming' | 'vaccination' | 'vet_visit' | 'feeding';
  keyword?: string;
  startDate?: string;        // YYYY-MM-DD，包含
  endDateExclusive?: string; // YYYY-MM-DD，不包含
  mode?: 'latest' | 'count' | 'list';
  limit?: number;
};
```

示例：「2026 年 10 月驱虫记录」转换为 `eventType=deworming`、`startDate=2026-10-01`、`endDateExclusive=2026-11-01`。相对时间由日期工具按请求参考日期解析。

实施步骤：

1. 抽出共享的 `queryRecords(options)`，同时供模型工具、本地演示和未来列表筛选使用。
2. 区分具体事件类型与展示分类，迁移旧记录时对歧义保守处理，不把所有医疗记录都变成驱虫。
3. 先按宠物、具体事件和时间范围过滤，再排序、统计、截取；`totalMatched` 在 limit 前计算。
4. 校验日期、起止关系和 limit；明确「记录条数」与「发生次数」的区别。一条日记可描述多次事件时不能简单按条数计数。
5. 给 `query_records` 增加相应 schema 参数；模型负责理解问题，代码负责过滤与计算。
6. 返回结构化 `latestDate / daysElapsed / totalMatched / records / refs`，关键事实直接渲染，不依赖模型再次计算。

本地数组阶段扩展并不困难，不需要为此先引入 RAG 或复杂后端。上云后可以保留此契约，再把底层读取换成数据库查询。

## 5. JSON 降级是什么意思

预期流程：支持工具调用的模型先使用 function calling；不支持时，让模型输出约定的 JSON，例如：

```json
{
  "reply": "先帮你整理好了，确认后再保存。",
  "draft": { "date": "2026-10-12", "text": "给咪咪洗澡了", "tags": ["洗澡"] },
  "queryTag": null
}
```

程序解析 JSON 后，仍然执行同一套查询或生成草稿逻辑。它是兼容模型协议的替代方案，不是另一套数据库，也不意味着跳过确认。

当前 `chatWithModel` 并未真正要求这种 JSON：它复用讲工具调用的提示词，却没有传 tools，也没有专门 JSON 输出要求或 response_format。`extractJson` 从自由文本里尝试抓取 JSON；没有找到或解析失败时，直接把文本当回复成功返回。

影响：网络请求成功但可能不生成记录卡、不触发查询；它不一定继续进入本地规则兜底。用户可能以为助手完成记录，实际并未创建待确认卡。

建议：不需要过早支持很多模式。优先把目标模型的工具调用链做好；若保留 JSON 模式，给它独立明确的输出 schema/提示，严格校验，并把解析失败标为失败，最后再显式降级到本地规则。所有模式共用同一个查询服务和草稿校验，保持行为一致。

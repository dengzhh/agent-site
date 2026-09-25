# AI Agent Tools Site — Design Doc

Date: 2026-09-25
Status: Approved (phasing & scope)

## 1. 目标与约束

**目标**：建一个面向全球英文用户的 AI Agent 工具站，以搜索流量 + 广告收入为主要变现，做成可持续的长期副业资产。

**已确认的约束**：
- 语言：英文内容，面向国际（欧美为主）流量
- 生产模式：AI 辅助批量生产（工具代码 + 程序化页面），人工审核把关
- 投入：长期副业，每天 1–2 小时，接受 6–12 个月成长期
- 变现：广告为主（AdSense 起步 → Mediavine/Raptive 升级），后续可加联盟佣金
- 技术路线：零/低成本起步，海外托管，无备案

## 2. 站点概念

**定位**：AI Agent 开发者/爱好者的在线工具箱——生成器、计算器、对比器、目录/模板库的组合矩阵。

**目标用户**：
- 构建 AI Agent 的开发者（选框架、算成本、写 prompt、配 MCP）
- 评估 AI Agent 工具的非技术用户（对比、选型）

**差异化**：作者是真实的 AI 基础设施从业者（AI 网关/Agent 记忆系统方向），工具出自真实工作流痛点，内容有真实经验背书（EEAT），区别于纯 AI 生成的同质化目录站。

## 3. 分期计划

### Phase 1（第 1–2 个月）：纯前端工具矩阵上线

5–8 个客户端工具，零边际成本：

| 工具 | 类型 | 目标关键词示例 |
|---|---|---|
| LLM API 成本计算器（多模型对比） | 计算器 | "claude api cost calculator", "gpt-4 pricing calculator" |
| Token 估算器（文本→token 数） | 计算器 | "token counter", "prompt token estimator" |
| 上下文窗口计算器（能塞多少文档） | 计算器 | "context window calculator" |
| System Prompt 生成器 | 生成器 | "system prompt generator" |
| MCP Server 配置生成器（JSON） | 生成器 | "mcp server config generator" |
| Agent 框架对比器 | 对比器 | "langgraph vs crewai" |
| 模型定价对比表（程序化页） | 数据页 | "claude vs gpt pricing" |

技术栈：**Astro**（静态优先、岛屿架构放交互工具、SEO 友好）+ 少量原生 JS/React 岛屿。
托管：**Cloudflare Pages 免费版**（带宽不限）。域名：Cloudflare Registrar（~$10.44/年）。
持续成本：**≈ $1/月**（域名摊销）。

程序化 SEO：模板 × 数据批量生成页面（如每个模型对一页对比、每个场景一页配置模板），首期目标 30–50 个可收录页面。

### Phase 2（第 3–4 个月）：目录/模板库

- MCP Server 目录（结构化数据 + 分类目录页，程序化 SEO 主力）
- Prompt 模板库（按用例分类，AI 辅助初稿 + 人工审核）
- 目标新增 100–300 个收录页面

### Phase 3（第 5 个月+，流量验证后）：API 智能工具

- Prompt 优化器、Agent 配置校验器等需调 LLM API 的工具
- 架构：Cloudflare Workers + AI 网关（作者熟悉 Higress，可自建控制成本）
- 免费额度限流（如每 IP 每天 3 次），确保成本 < 当月广告收入
- 此阶段视 Phase 1/2 流量数据决定是否投入

## 4. 架构

```
浏览器
  └─ Cloudflare Pages（静态站：Astro SSG + 工具岛屿 JS）
       ├─ Phase 3 起：/api/* → Cloudflare Workers（LLM 调用，限流）
       └─ 数据文件（模型定价、框架参数）→ JSON 构建时注入页面
```

- 数据（定价/框架元数据）以 JSON 文件形式进仓库，构建时生成页面与工具默认值；更新数据 = 改 JSON + 重新部署
- 无数据库、无后端（Phase 3 前无后端）
- 分析：Cloudflare Web Analytics（免费、无 cookie，不影响性能）

## 5. 变现与合规

- **AdSense**：上线后内容页 20–30 篇（工具说明 + 博客文章）即申请；必备页面：Privacy Policy、About、Contact、Cookie Policy（含 GDPR 同意条）
- **升级路径**：5 万会话/月 → Mediavine/Raptive（RPM $15–40+）
- 联盟佣金：Phase 2 起在对比/评测页嵌入 AI 工具推荐链接
- 税务：AdSense 收款提交 W-8BEN

## 6. 成功指标

| 时间 | 里程碑 |
|---|---|
| 第 1 月末 | 站点上线，5+ 工具，30+ 页面，提交 sitemap |
| 第 3 月 | Google 收录 100+ 页，日 UV > 100 |
| 第 6 月 | 日 UV > 500，AdSense 收入 > $50/月 |
| 第 12 月 | 月 PV 5 万+，进入 Mediavine/Raptive，收入 $500+/月 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Google 对 AI 内容的打击 | 工具为主体、内容为辅；文章必须人工审核 + 注入真实经验 |
| 工具站竞争同质化 | 深耕 Agent/MCP 垂类（作者专业领域），不做大而全 |
| AdSense 拒批 | 保证内容量与必备合规页后再申请；被拒则先上 Adsterra/Ezoic 过渡 |
| 流量起不来 | Phase 1 结束时复盘关键词数据，砍无效工具、加有效工具，不硬撑 |

## 8. 非目标（本期不做）

- 用户系统/注册登录
- 中文版站点
- 国内访问优化/备案
- 移动 App
- 付费订阅

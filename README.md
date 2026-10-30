# SpreadJS 协同架构实验室

[English](README.en.md)

你的业务需要多少台协同服务器、每台什么配置？答案取决于同时打开多少份文档、每份有多少人、多久编辑一次，以及文档本身的复杂度。这个仓库让客户在自己的环境中运行协同部署与负载实验，和售前、售后一起收集测量依据，再讨论硬件候选与需要进一步验证的条件。

你可以运行单节点、按文档分片、同房间跨节点三种部署方式，检查同步行为，逐级增加人数和编辑频率，并保存报告。它适合比较部署方案、排查同步问题，也可以作为业务容量验证的起点。完整流程见[在客户环境中做容量实验](docs/14-customer-sizing-guide.md)。

## 先选对验证路径

| 你的目的 | 应使用的实现 | 当前入口与能力 |
|---|---|---|
| 验证框架、部署编排、房间路由、消息转发及报告流程 | `mirror` | 默认启动路径；`check`、`bench`、`big-doc` 用于框架与合成负载实验 |
| 评估真实业务的 CPU、内存、磁盘、网络和机器数量 | 真实 SpreadJS 工作簿 + 官方协同客户端、服务端和 OT（`real`） | 已有授权接入页面与小规模同步测试；自动化业务容量压测尚待补齐 |

**mirror 用于验证框架；硬件评估必须使用真实 SpreadJS 官方协同链路、业务工作簿与操作负载，并结合资源监控。** mirror 的吞吐、延迟和每格内存不能折算成官方实现的硬件需求。

这里的 `mirror` 指协同引擎。默认 `/client/` 页面也使用真实 SpreadJS 表格控件，但用自定义协议同步简单单元格值；`/official/` 配合 `--impl=real` 才走官方协同链路。`bench` 通过 Node 模拟客户端发送 mirror 操作，不运行浏览器工作簿。仅添加授权或切换 `real`，不会让现有 `bench` 变成官方容量测试；官方路径的使用方法见[授权与官方实现](docs/07-license.md)。

模型与示例的适用条件见[使用边界与免责声明](DISCLAIMER.md)，已执行的验证见[验证记录](docs/11-project-review.md)。

## 先验证框架（mirror）

准备 Node.js 22 或 24 的 LTS 版本和 npm，以下命令都在工程根目录的 PowerShell 中执行。当前已在 Windows + Node.js 24 上验证；macOS / Linux 尚未验证。

```sh
git clone https://github.com/GrapeCityXA/spreadjs-collab-arch-lab.git
cd spreadjs-collab-arch-lab
npm ci
npm run doctor
npm run up -- --mode=single
```

打开 [本机控制台](http://127.0.0.1:5173/)，可以看到当前部署和节点状态。再运行：

```sh
npm run check
npm run down
```

`check` 会检查同步行为，在 `reports/` 中生成 Markdown 和 JSON 报告。`down` 停止本工程记录的进程，保留日志和数据。

`npm ci` 按仓库的锁文件安装依赖。第一次推荐 `single`：不需要 Redis，也不需要配置授权码。安装依赖失败、端口被占用等问题，见 [第一次运行](docs/01-quickstart.md)。

## 看两个页面同步

启动后，分别打开下面两个链接。在 Alice 页面输入一个单元格值，确认 Bob 页面出现相同的值，再反过来试一次。

- [Alice 的页面](http://127.0.0.1:5173/client/?room=arch-lab-demo&label=alice&auto=1)
- [Bob 的页面](http://127.0.0.1:5173/client/?room=arch-lab-demo&label=bob&auto=1)

两个页面的 `room` 相同，表示编辑同一份演示文档；`label` 是昵称。页面会显示连接到的节点、文档版本和消息日志。普通的两个标签页即可，隐身窗口只用于需要隔离会话的排查。

## 三种方式有什么区别

这里的“节点”是一个服务进程。“房间”是一组共同编辑同一份文档的用户。默认多节点演示是在一台电脑上启动多个进程，并不需要多台机器。

| 模式 | 怎么分配用户 | 适合先验证什么 | 额外条件 |
|---|---|---|---|
| `single` 单节点 | 所有用户连同一个进程 | 最基本的连接和编辑同步 | 无 |
| `sharded` 按房间分组 | 同一文档的用户固定连同一节点，不同文档可以分到不同节点 | 很多房间分摊到多个节点 | 入口必须按房间路由 |
| `shared` 同房间跨节点 | 同一文档的用户可以连不同节点 | 跨节点转发修改、共享文档数据 | Redis + 共享文档库 |

切换模式前先停止当前部署：

```sh
npm run down
npm run up -- --mode=sharded
npm run check
```

想看同一文档的用户连接到不同节点，把模式改为 `shared`。它需要 Redis；Windows 推荐通过 Docker Desktop 准备 Redis，具体命令见 [准备 Redis](docs/01-quickstart.md#在-windows-上准备-redis)。独立仓库不附带 Redis 二进制。

`shared` 同时需要两条路径：Redis 负责把修改及时送到其他节点，文档库负责让新加入或重新连接的人读到已有数据。只配好其中一条，仍可能出现同步问题。见 [模式说明](docs/02-modes.md) 和 [选型指南](docs/03-decision-guide.md)。

## 试一次错误配置

下面的例子共享了文档库，却关闭跨节点消息转发。它演示“刷新后数据是对的，但编辑时看不到对方修改”的情况。

```sh
npm run down
npm run up -- --variant=broken-no-adapter
npm run check
npm run down
```

这是故意设置的错误，报告应显示 `expected-broken`。另外还有“同房间被分到不同节点”和“消息能转发、文档库却各存各的”两种例子，见 [模式说明](docs/02-modes.md)。

## 想让 AI 帮你算硬件

先把下面的输入交给 AI，并要求它阅读 [硬件咨询规则与容量账](docs/13-ai-hardware-sizing.md)、[性能与容量](docs/05-performance.md)和[生产边界](docs/06-production.md)。完整例子见 [2 000 文档候选容量账](docs/12-scenario-assessment-saas-2000docs.md)。AI 可以梳理需求、计算负载与存储账、设计官方实现的验证方案；硬件候选必须说明假设和待验证项，不能由 mirror 实测折算得出。

```text
请按本仓库文档评估 CPU/内存/磁盘/网络/台数，并写出计算、单位和故障后的余量。
区分：确定计算、历史/演示实测、工程假设、候选硬件、待验证。
信息不足时先列缺项及已能算出的结果；广播模型0核不代表不需要CPU或内存。
mirror结果只用于框架实验，不能折算为官方硬件需求；选型实测须走真实SpreadJS官方协同链路。
版本/实现/操作系统/云地域：
在线文档数、会话数（含多标签）、房间人数分布：
有效有值/公式/样式格数分布、图片/长字符串/导入导出、JSON/压缩体积：
每人/每房间op频率（平均/峰值）、一次改多少格、op平均/p95/最大字节数：
“保存”是增量op还是整本上传；ACK是否要求耐久落库：
presence/光标频率、体积和订阅范围：
SLO：ACK/广播p95/p99、首次打开、全量重连窗口、失败率：
历史：热/归档总保留天数、快照频率、分层保留与对象版本策略：
RPO（可丢多少已确认编辑）、单文档/整库RTO：
故障范围（进程/主机/AZ/区域）、故障期间是否同时发布、增长和预算：
已有实测与原始报告（硬件、建连耗时、稳态写入窗口/成功op数、组件监控）：
```

### 四个提问示例

先让 AI 阅读本页及上方链接，再选择接近自己业务的问题，替换其中的人数、文档规模和操作频率。尚不清楚的条件可以写“未知”，请 AI 帮你整理需要补充的信息和实验步骤。

<details>
<summary>1. 1000 人在线，每人 30 秒操作一次，需要什么硬件？</summary>

```text
我们有1000人同时在线编辑表格，每人约30秒操作一次，需要什么硬件？
请先告诉我还需要提供哪些业务信息，以及怎样在我们的环境中设计实验，
收集判断硬件配置所需的数据。
```

</details>

<details>
<summary>2. 2000 份文档、每份 2 人，生产环境怎么配？</summary>

```text
我们的SaaS同时编辑2000份文档，每份2人，每人每2秒保存一次。
文档有效格数为1万/10万/50万，分别占60%/35%/5%。
需要历史恢复和生产高可用。
请先确认“保存”的含义、历史保留和故障恢复目标，再帮我们设计使用真实SpreadJS
官方协同链路的实验，收集评估CPU、内存、磁盘、网络和机器数量所需的证据。
```

</details>

<details>
<summary>3. 1000 人集中在同一份文档，4 核 8 GB 够吗？</summary>

```text
1000人集中在同一份文档，每人每2秒修改一次，4核8 GB服务器够吗？
应该怎样用真实SpreadJS和官方协同实现验证？需要观察哪些指标、怎样约定通过条件？
如果想增加节点，应该比较哪些部署方式，又该怎样验证扩容效果？
```

</details>

<details>
<summary>4. 大量独立文档，怎样测量内存和扩容需求？</summary>

```text
1000人各自编辑一份文档，每份约10万有效格，每人每2秒操作一次。
我们想评估同时打开这些文档时的内存和其他资源需求，以及用户增加后的扩容方式。
应该怎样准备业务样本、运行真实SpreadJS官方协同实验、采集监控，
并把结果整理给售前售后一起分析？
```

</details>

## 按自己的用户场景验证框架（mirror）

先启动一个模式，再指定用户数、编辑间隔、持续时间和房间数。建议从小场景开始：

```sh
npm run up -- --mode=single
npm run bench -- --users=50 --interval=2 --duration=20 --rooms=1
npm run down
```

这里 `--interval=2` 表示每人每 2 秒编辑一次，`--duration=20` 表示目标写入窗口 20 秒。此步骤只验证 mirror 框架负载；业务硬件评估必须在真实 SpreadJS 官方协同链路上另做实测。

同样是 1000 人在线，分散在不同文档、很少编辑，与集中在一份文档、频繁编辑，负载会相差很大。先看 [性能测试怎么做](docs/05-performance.md)，再增加人数。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run doctor` | 检查依赖、端口、Redis、浏览器与授权配置 |
| `npm run up -- --mode=single` | 启动一个部署，可选 `single` / `sharded` / `shared` |
| `npm run status` | 查看当前部署和节点健康状态 |
| `npm run web` | 单独启动控制台，然后在页面上操作 |
| `npm run check` | 检查正在运行的 mirror 部署，生成报告 |
| `npm run bench -- --users=50 --interval=2 --duration=20` | mirror 框架负载实验，不做官方硬件评估 |
| `npm run compare` | 依次启动并检查三种模式，生成对比报告；需要 Redis |
| `npm run down` | 停止当前部署 |
| `npm run self-test` | 运行工程自测；缺 Redis 时会跳过相关用例 |

完整参数见 [命令参考](docs/10-cli-reference.md)。`check` 不依赖浏览器；页面测试使用 `test:ui`，官方实现的测试使用 `test:official`。

## 按需要继续阅读

| 你想做什么 | 文档 |
|---|---|
| 跑通第一个例子 | [第一次运行](docs/01-quickstart.md) |
| 向团队介绍用途、适用场景与基本用法 | [容量实验简介](docs/15-official-doc-introduction.md) |
| 按业务设计实验、记录结果并与售前售后讨论配置 | [客户环境容量实验指南](docs/14-customer-sizing-guide.md) |
| 了解节点、房间、Redis 的作用 | [模式说明](docs/02-modes.md) |
| 为自己的场景选一种部署方式 | [选型指南](docs/03-decision-guide.md) |
| 看懂检查结果 | [检查与报告](docs/04-architecture-check.md) |
| 做负载测试、了解历史数据的范围 | [性能与容量](docs/05-performance.md) |
| 评估上线前还缺什么 | [生产部署注意事项](docs/06-production.md) |
| 使用官方实现 | [授权与官方实现](docs/07-license.md) |
| 解决启动或同步问题 | [排障](docs/08-troubleshooting.md) |
| 把节点或负载生成器放到其他电脑 | [多机操作手册](docs/09-multi-machine.md) |
| 把业务输入交给 AI，核对硬件计算与验证条件 | [AI 硬件咨询模板](docs/13-ai-hardware-sizing.md) |
| 看内存、历史保留、带宽与故障台数怎么一起算 | [候选容量账（SaaS 2 000 文档）](docs/12-scenario-assessment-saas-2000docs.md) |
| 修改代码、提交贡献 | [贡献指南](CONTRIBUTING.md) |

## 使用范围

统一说明见[使用边界与免责声明](DISCLAIMER.md)。以下列出主要技术限制：

- `mirror` 用于验证本工程的消息转发、房间隔离和文档共享行为，不能验证官方 OT 算法、复杂工作簿协作兼容性或官方实现的性能。
- `shared` 用同一台机器上的 SQLite 文件演示共享存储。当前工程未接入 PostgreSQL，跨真实主机的 `shared` 会被拒绝。
- 多机编排已用本机多个 agent 进程模拟验证，真实跨主机环境仍需测试。
- 历史性能数据来自另一套官方 19.1.4 压测工程；当前依赖声明为 19.2.1 系列。原始压测产物不随本目录发布，不能直接作为当前版本的性能证明。
- 控制台和诊断接口用于受控实验环境，尚未提供完整的生产鉴权。部署限制见 [生产部署注意事项](docs/06-production.md)。

## 目录

```text
src/cli.mjs       命令入口
src/lab/          模式配置、进程启停、环境检查
src/server/       协同节点、mirror 实现、官方实现接入
src/lb/           负载均衡
src/checks/       同步检查与报告
src/bench/        负载生成
src/remote/       多机 agent 与调度
src/web/          控制台服务
public/           控制台和演示页面
config/           默认配置、授权模板、nginx 参考配置
tests/           自动检查
docs/            使用说明
```

运行时生成的 `.lab/`、`data/`、`logs/`、`reports/` 已加入忽略列表。`.lab/state.json` 包含进程记录及管理凭据，不要公开。

## 许可

本仓库自有代码使用 [MIT 许可](LICENSE)。SpreadJS 与 `@grapecity-software/*` 依赖遵循各自的商业许可，MIT 不覆盖这些依赖。本仓库不分发授权码；具体使用条件见 [授权说明](docs/07-license.md)。

[更新记录](CHANGELOG.md) · [项目审查记录](docs/11-project-review.md)

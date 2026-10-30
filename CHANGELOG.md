# 变更记录

本文件记录用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

- 中英文 README 的业务示例改为可复制的提问，移除预设答案、计算结果和硬件候选。
- 明确 mirror 用于框架验证，真实业务硬件评估必须走 SpreadJS 官方协同链路；mirror 主要结果去掉预测核数，保留兼容 JSON 与独立历史模型计算器。
- 以客户与售前售后共同开展现场实验为入口，新增简短介绍稿与客户环境容量实验指南，说明场景、加压步骤、结果记录及真实业务容量验证所需的补充能力。
- 修正官方同步测试对未启用 presence 的错误要求，改查实际 OT 文档及双端版本推进、收敛；异常路径返回失败，明确该测试不验证容量。
- 新增中英文使用边界与免责声明，明确模型、AI 硬件候选、测试结论和商业依赖许可的适用范围。
- 修复均匀房间人数不能整除时的广播模型，CLI 与控制台按实际人数分布计算；capacity 保留建议命令的房间参数。
- 分布式负载按全局用户序号分配房间，全部连接就绪后写入、全部写完后释放连接；报告可核对实际人数分布，单独记录连接、写入、接收窗口和发送目标达成率。
- 支持一个主控本地节点加远端 agent 时保留负载均衡，修复场景样例的多机启动路径。
- 重算 SaaS 样例的快照、归档、故障内存余量与重连带宽，新增从 README 进入的 AI 硬件咨询模板。
- 新增容量、负载计量和拓扑回归检查，浏览器与分布式测试覆盖非整除房间及多房间分配。

- 演示文档聚焦 Windows + PowerShell，补齐 Docker Desktop 准备 Redis 的步骤。
- 场景输入非法时明确失败，页面不再自动修改输入；capacity 补齐参数校验。
- 修正 compare 结果退出码，bench 区分写入结果与性能是否达标，补充 mirror 范围提示。
- 统一所有入口的授权读取规则，支持环境变量配置，不再自动查找父目录授权。
- 新增 test:inputs 回归检查，API 与浏览器检查覆盖非法场景。

- 重写中英文首页及使用指南：从单节点演示开始，拆出命令参考，解释术语和报告读法。
- 修正文档中 check 的浏览器依赖、官方实现测试入口、内存存储和多机支持范围说明。
- 将历史官方性能数据与当前 mirror 测试分开说明，撤去通用容量保证。
- 控制台 API 和 CLI JSON 中的管理 token 改为 SET / MISSING，保留私有状态中的实际凭据供清理使用。
- 修复控制台 POST /shutdown 路由，支持通过 HTTP 正常停止。
- 修复 mirror 跨节点成员列表被各节点本地名单覆盖的问题，浏览器测试同时检查两个页面的成员信息。
- up / down / check 的 JSON 输出将进度写到 stderr，stdout 保持可解析。
- 自测统计不再把跳过项算作通过，结论报告实际执行范围。
- 补齐官方页面构建需要的 CSS loader 依赖与锁文件，移除两个一次性源码补丁脚本。
- 新增 test:api 回归检查及项目审查记录，补充本地环境文件忽略规则。
- 场景房间数上限从 1 000 提高到 10 000（SaaS 场景常有数千份文档同时在线），控制台回退上限同步。
- 新增 [场景评估样例](docs/12-scenario-assessment-saas-2000docs.md)：用实测与模型估算回答“2 000 文档 × 2 人 × 每 2 秒保存、文档 1 万/10 万/50 万格”的硬件配置。
- 新增 `npm run big-doc`：向单个房间写入 N 个单元格，测单文档内存、快照体积与加入耗时；`/health` 增加 `rssBytes` / `heapUsedBytes` 便于外部测量。

## [1.1.0] - 2026-10-27

这一版把实验室从"验证拓扑语义"扩到"回答**你的**场景"，并把负载拆到多台机器。

### 新增 · 按你的场景跑（`check` / `bench` / `compare` / 控制台共用一套词汇）

- 场景四参数：`--users`（并发用户）、`--interval`（每人每几**秒**编辑一次）、
  `--duration`（负载几**秒**）、`--rooms`（分几个房间）。`--interval-ms` 是精确别名；
  旧的 `--clients` / `--intervalMs` 仍然可用。
- 报告、终端矩阵、控制台都会打印场景与模型（`≈ N 次编辑/s · 扇出 M 条/s · 预测 K 核`）；
  报告 JSON 里是 `scenario` + `scenario.load`。**两份不同场景的报告不可比**，
  `compare` 会把同一个场景传给三种模式。
- 第 12 项检查 `load.scenario`（期望 `record`，终端显示"仅记录"）：按你的场景跑一段
  短负载，只记录实测 p95、扇出与模型核数，不判断行不行。负载阶段默认最多 300 个客户端
  （`--max-load-clients`），被收敛时 `detail` 会写明"其余按模型推算"。
- `check` 默认 `20 用户 / 2 秒 / 8 秒 / 1 房间`；`bench` 默认 `50 用户 / 0.6 秒 / 20 秒 / 1 房间`。
- **不兼容变更**：`bench` 的 `--interval` / `--duration` 单位改为**秒**
  （`--interval=0.6` 等于原来的 `--interval=600`）；需要毫秒精度用 `--interval-ms=600`。
  `npm run capacity` 的 `--interval` 仍是**毫秒**（纯计算器，未改）。

### 新增 · 多机：controller + agent

- 新命令 `npm run agent -- --port=9100 --lb=http://<controller>:3000 --token=<token> --public-host=<ip>`：
  在另一台机器上起 agent。**启动即拉起协同节点**，然后监听控制端口（`--node-port` 冲突是
  启动错误）；controller attach 只负责把 `http://<public-host>:<node-port>` 注册到负载均衡。
  控制接口 `/agent/*` 全部要求 `x-lab-token`（`/agent/attach|detach|load|load/cancel|status|shutdown`）。
- `up --agents=<agent-url,...> --agent-token=<token>`：controller 起负载均衡（带管理 API）后
  逐个 attach（把拓扑配置传给 agent，节点配置不一致时会重启），节点总数 = 本机节点 + 远端节点；
  `status` 与拓扑图标出每个节点所在主机。
- **跨主机的 `shared` 被明确拒绝**：演示文档库是 SQLite 文件，跨主机会各自建一份本地文件，
  等于反模式 B。报错给出三条出路（`--mode=sharded` / agent 跑本机 127.0.0.1 同机模拟 /
  换 PostgreSQL）。同机模拟下 SQLite 真的是同一份：2 本机节点 + 2 个 loopback agent 的
  4 节点 `shared` 实测 `check` = healthy（`store.consistency` / `join.consistency` /
  `realtime.crossNode` 全 PASS）。这是实验室的诚实边界，不是未完成项。
- 负载均衡新增管理 API `POST/DELETE /__lb/upstreams`：**默认关闭**，只有设了
  `SJS_LB_ADMIN_TOKEN` 才启用（无 token → `403 admin-disabled`，错 token → `401`）。
- `bench --distribute=local,http://h1:9100`：用户按参与者平均分（余数给前面的参与者）、
  并行跑、合并统计。聚合字段（`ops` / `opsPerSecond` / `fanoutPerSecond` / `ackMs` /
  `broadcastMs` / `perNode`）是整场景口径；ACK 百分位由各参与者上报的原始样本重算，
  广播延迟取最慢参与者，**扇出按全局房间成员重算**（`fanoutBasis: 'global-room-membership'`，
  避免每份只按自己的切片算导致少报）。`participants[]` 行是各生成器自己的口径，不可相加。
- `bench` 的场景行统一为 `[lab] 压测：…（≈ … 次编辑/s · 扇出 … 条/s · 模型预测 … 核）`：
  开跑前打印 `[lab] 压测：` + `[lab] 目标：…`（`--distribute` 还多一行 `[lab] 分摊：…`），
  结果块再重复场景行；**每行都带 `[lab]` 前缀**。`check` 仍用 `[lab] 场景：` + `[lab] 模型：`
  两行，且这组两行只在开头出现一次（不再在进度列表后重复）。
- 模型核数低于 0.01 时显示 `<0.01 核`（不再显示 `0 核`）；`广播到达` 行末尾的
  `多机取最差参与者` 只在 `--distribute` 下出现（本机 bench 不再误带这个注记）。
- agent 节点由 supervisor 看管：agent 被强杀/崩溃（关终端、`taskkill /T /F`）后节点在
  约 1 秒内退出、`--node-port` 释放，**不泄漏监听端口**；优雅路径（`/agent/shutdown`、
  `down --stop-agents`）仍然先注销再停节点。
- attach 会对比远端节点当前配置：不一致时打印 `node 配置不一致（…），按 controller 配置重启`，
  一致时打印 `node 配置一致，复用 pid …`；HTTP 响应里带 `restarted` 标志。
- `down` 逐个 detach 远端节点（每台 10 秒上限，失败的写 `! agent <host> 未能摘除：<原因>`，
  其余照常、退出码 0）；`down --stop-agents` 额外让 agent 进程退出。
- 负载生成只有一份实现（`src/bench/load.mjs`），check 的负载阶段、`bench`、agent 共用。

### 新增 · 测试与文档

- `npm run test:distributed`：本机起两个 agent 模拟两台主机，验证附着、节点注册与分布式压测。
- 新增 `docs/09-multi-machine.md`：controller/agent 角色、端口与防火墙、`--public-host` 的坑、
  token 处理、按场景加压、收尾、容量推算表（标注"推算"）、常见失败、安全边界。
- `README` / `README.en` / `02-modes` / `04-architecture-check` / `05-performance` /
  `CONTRIBUTING` / `CHANGELOG` 同步更新；`05` 新增"用你自己的场景测"（四参数 → 扇出 → 核数）。
- `npm run capacity` 的说明补上单位是毫秒，并补充 `--rooms` / `--node-cores` / `--presence`。

### 注意

- **多机路径的验证程度**：分布式能力在**同一台机器上用两个本地 agent 模拟两台主机**验证
  （不同 agent 端口 + 不同节点端口）；**没有**在真实多台物理机/云主机上跑过。
  真实跨机的 RTT、防火墙、带宽不在验证范围内，见 `docs/09-multi-machine.md` §13。
- 场景容量数字（`docs/09` 的估算表、`docs/02` 的每模式估算）都是**模型推算**，
  不是多机实测；公式与实测锚点在 `docs/05-performance.md`。

## [1.0.0] - 2026-10-27

首个版本。目标是把"SpreadJS 协同该用哪种多服务器架构"变成一条命令可复现的实验，
而不是一组只存在于 PPT 里的结论。

### 新增 · 三种拓扑，一条命令切换

- `single`（单机）、`sharded`（分区多机 + 房间亲和，不共享 room）、
  `shared`（共享 room：Redis 适配器 + 共享文档库）。
- 三种"故意做错"的变体用于复现真实客户事故：
  `broken-sharded`（没有房间亲和）、`broken-adapter-only`（只加适配器没共享文档库）、
  `broken-no-adapter`（共享了文档库但忘了适配器）。

### 新增 · CLI（`node src/cli.mjs`，由 npm scripts 包装）

- `npm run doctor` —— 环境自检：Node、依赖解析、端口占用、Redis 可得性、浏览器、
  三个授权 key 的 `SET`/`MISSING`、机器码。
- `npm run up -- --mode=...` / `--variant=...` —— 串行、健康门控地起一套栈；
  失败时回滚已启动的进程并打印日志尾部。开关包括 `--nodes`、`--impl`、`--store`、
  `--adapter`、`--affinity`、`--presence`、`--no-web`、`--json`。
- `npm run status` / `npm run down` / `npm run web` —— 查看、停止（只停自己启动的进程，
  先请求优雅退出再回退到系统 kill，并验证进程确实退出）、只起控制台。
- `npm run check` —— 体检**正在运行的**栈，11 项检查，写 `reports/check-<ts>.{json,md}`；
  退出码区分 healthy / broken / no-stack / degraded，`--fail-on-degraded` 把 degraded 视为失败。
- `npm run bench` —— 小负载测试（客户端数、写入间隔、时长、房间），写 `reports/bench-<ts>.json`。
- `npm run capacity` —— 纯容量计算器，不需要起栈。
- `npm run compare` —— 依次跑完三种模式（可加 `--variants`）并生成并排对比表。

### 新增 · 体检（11 项）

`nodes.health`、`topology.config`、`lb.distribution`、`room.placement`、
`realtime.sameNode`、`realtime.crossNode`、`join.consistency`、`store.consistency`、
`isolation.rooms`、`ack.latency`、`eventual.mask`。

- 每项都带"期望"和"观测"两个维度：终端矩阵四列（状态 / 期望 / 检查项 / 说明），
  JSON 里是 `expected` / `status` 两个字段。
- 跑不了的检查是 `N-A` **并写明原因**，不会被算成通过。
- `eventual.mask` 专门检测"跨节点实时断了、但最终一致性检查通过"的组合。
- `broken-*` 变体里被破坏的项显示 `EXPECTED-FAIL`（实验室的成功，不是架构的成功）。

### 新增 · 零授权 mirror 实现

- 复刻线协议：socket.io event `m`、`[type, data, compressed]`、128 字节 gzip 阈值、
  房间与 `except-sender` 语义、相同的连接/进房/断开的钩子契约。
- 默认实现，不需要任何 GrapeCity 授权码。
- 明确不做：官方 OT 的业务行为、官方实现的性能、授权行为。
  `mirror` 下开启 OT/presence 会被拒绝（exit 2），不假装验证过。

### 新增 · 官方实现路径（可选）

- `--impl=real` 走官方 `js-collaboration`；需要机器码绑定的服务端授权，
  缺授权时节点退出码 2 而不是静默降级。
- `npm run build:official` 构建 `/official/` 页面；
  未构建时页面明确提示，而不是白屏。
- `npm run test:official` 是授权后的浏览器验证，未配授权时明确跳过。

### 新增 · 网页控制台与客户端页面

- `/` 控制台：拓扑、每节点健康、起停、体检、报告列表、三种模式对比。
- `/client/?room=&label=&auto=1`：零授权的 SpreadJS 协同客户端，显示
  **服务你的节点**、文档版本、成员列表、消息日志；暴露 `window.__lab*` 自动化钩子。
- `/official/?room=&label=`：可选的官方实现客户端（需构建 + 授权）。

### 新增 · 跨平台负载均衡器

- `src/lb/load-balancer.mjs`：HTTP + 原生 WebSocket upgrade 代理，
  `rr` / `least-conn` / `room-affinity` 三种策略，`/healthz` 与 `/__lb/state` 自省接口。
- 不需要安装 nginx；另附 `config/nginx.reference.conf` 作为**生产**参考
  （实验室本身不使用它）。

### 文档

- `README.md` / `README.en.md`：项目定位、30 秒上手、三种架构对比、证据示例、
  实测数据（区分实测与外推）、命令表、FAQ、授权与商标。
- `docs/01-quickstart.md` … `docs/08-troubleshooting.md`：上手、模式、决策、体检、
  性能、生产、授权、排障。
- `CONTRIBUTING.md`：开发环境、代码约定、如何加一项检查、文档规矩。
- `docs/DEV-CONTRACT.md`：内部契约（CLI/API/检查结果结构/页面钩子）。

### 注意

- **性能数字有口径。** 1000 人 / 每人 30 秒的两组实测（同机 loopback 2.21 核 vs
  跨机有线 0.82 核）都真实存在，原因与用法见 `docs/05-performance.md` §1；
  15 s / 6 s / 2 s 档位是**外推，未实测**。
- **不是所有东西都被验证过。** 明确的未验证清单在 `docs/05-performance.md` §7。
- **不要用"最终数据一致"验收多服务器部署。** 见 `docs/04-architecture-check.md` §4。

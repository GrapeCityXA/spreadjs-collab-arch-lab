# 命令参考

所有命令在工程根目录执行。npm 脚本后面的 `--` 用来把参数传给程序，例如 `npm run up -- --mode=single`。

## 启动与停止

| 命令 | 用途 |
|---|---|
| `npm run doctor` | 环境检查 |
| `npm run up -- --mode=single` | 启动单节点 |
| `npm run up -- --mode=sharded` | 启动按房间路由的多节点 |
| `npm run up -- --mode=shared` | 启动共享房间多节点，需要 Redis |
| `npm run status` | 查看部署与健康状态 |
| `npm run down` | 停止部署 |
| `npm run web` | 单独启动控制台，Ctrl+C 停止控制台进程 |

up 常用选项：

| 选项 | 说明 |
|---|---|
| `--mode=single\|sharded\|shared` | 模式，默认 single |
| `--nodes=N` | 本地节点数；一个本地节点加 agent 仍启动负载均衡，只有总共一个节点时不启动 |
| `--variant=broken-sharded\|broken-adapter-only\|broken-no-adapter` | 故意配错的例子，覆盖 mode |
| `--impl=mirror\|real` | 默认 mirror；real 需要 server 授权，可由文件或环境变量提供 |
| `--no-web` | 不随部署启动控制台 |
| `--agents=http://主机:9100,...` | 附着远端 agent，见 [多机手册](09-multi-machine.md) |
| `--agent-token=值` | agent 与入口管理使用的 token |
| `--store=local\|shared` | 文档存储覆盖项 |
| `--adapter=0\|1` | 跨节点消息转发覆盖项 |
| `--affinity=room\|none` | 房间路由覆盖项 |
| `--presence=0\|1` | 官方 presence；只适用于 real |

修改底层覆盖项可能破坏模式的默认行为，适合诊断实验。不要把它们作为首次运行的必要配置。切换模式前先 down。

down 可加 `--stop-agents`，请求远端 agent 一并退出。up / status / down 可用 `--json`；管理 token 输出为 SET / MISSING，实际凭据仍保留在私有状态文件。

## 检查与负载

| 命令 | 用途 |
|---|---|
| `npm run check` | 检查运行中的 mirror 部署并生成报告 |
| `npm run bench` | 对运行中的 mirror 部署施加负载 |
| `npm run compare` | 依次启停三种模式，生成对比报告 |

三者共用以下场景参数：

| 参数 | 单位 | check / compare 默认 | bench 默认 |
|---|---|---|---|
| `--users=N` | 人 | 20 | 50 |
| `--interval=N` | 秒，可带小数 | 2 | 0.6 |
| `--interval-ms=N` | 毫秒，代替 interval | — | — |
| `--duration=N` | 秒 | 8 | 20 |
| `--rooms=N` | 房间数 | 1 | 1 |

check 额外支持 `--max-load-clients=N`（默认 300）、`--json`、`--out-dir=目录` 和 `--fail-on-degraded`。状态与退出码见 [检查与报告](04-architecture-check.md)。

参数省略时才使用默认值。非数值、缺少参数值、非正间隔或时长会报错；users / rooms 必须是整数，rooms 不得超过 users。CLI 对非法参数返回 2，控制台接口返回 HTTP 400，不会悄悄替换成默认场景。

bench 可加 `--distribute` 或 `--distribute=local,http://主机:9100` 分配模拟用户。它不输出 CLI JSON，原始统计保存在报告中；见 [性能测试](05-performance.md#8-用你自己的场景测)。

这些命令用于 mirror 框架与消息路径验证；其吞吐、延迟和内存不能折算成官方硬件需求。硬件评估必须使用真实 SpreadJS 工作簿与官方协同客户端、服务端，覆盖实际业务操作并收集资源监控；当前仓库尚未提供官方业务容量压测器。

bench 退出 0 表示本次有成功写入、没有报告写入失败且未取消；存在失败或没有成功写入时退出 1。报告的 outcome.performance 为 not-evaluated：没有自动判定性能达标。延迟、样本数和失败率仅描述本次 mirror 实验。

compare 可加 `--modes=single,sharded` 限制模式，或 `--variants` 加入错误配置。它会操作当前部署，运行前先 down。只有正常模式均为 healthy、错误配置均为 expected-broken 时退出 0；启动错误、broken 或 degraded 等未达到预期的结果退出 1。场景参数非法时退出 2。

## 容量计算

```sh
npm run capacity -- --users=1000 --interval=30000 --rooms=1 --node-cores=4
```

capacity 不启动负载，输出模型估算。`--interval` 在这个命令里是**毫秒**，默认 600。支持 `--presence` 和 `--json`。node-cores 是估算分母，不表示一个 Node 进程可以用满这些核。

mirror 实验的终端、Markdown 与控制台主要结果不再展示预测核数。JSON 中的模型字段为兼容保留，独立 `capacity` 命令仍可演算历史广播模型；两者均不是选型结果。

## 自动测试与构建

| 命令 | 条件与用途 |
|---|---|
| `npm run self-test` | 三种模式与错误变体；缺 Redis 会跳过相关用例 |
| `npm run self-test -- --only=single,sharded` | 只运行指定用例 |
| `npm run test:api` | 公开响应脱敏、CLI JSON 与控制台停止回归检查 |
| `npm run test:inputs` | 场景参数、结果判定和授权读取规则的回归检查 |
| `npm run test:capacity` | 非整除房间模型、频率表、完整场景建议命令与旧报告识别 |
| `npm run test:load` | 全局房间分配、写入窗口速率与分布式统计的回归检查 |
| `npm run test:topology` | 一个本地节点加 agent 的模式配置与启动保护规则 |
| `npm run test:ui` | mirror 页面同步与控制台渲染，需要浏览器 |
| `npm run test:distributed` | 同机两个 agent 的编排与分布式负载 |
| `npm run build:official` | 构建官方客户端 |
| `npm run test:official` | 官方实现浏览器验证，需要构建、授权与浏览器 |
| `npm run test:official -- --mode=shared` | 官方共享模式验证，另需 Redis |

测试会启停部署，执行前停止手动演示。不要并行运行共享同一状态目录的套件。

## 配置入口与 JSON

默认配置在 [lab.config.json](../config/lab.config.json)。常用环境变量包括 `SJS_LAB_WEB_PORT`、`SJS_LAB_LB_PORT`、`SJS_LAB_NODE_BASE_PORT`、`SJS_LAB_BIND_HOST`、`SJS_LAB_LB_PUBLIC_URL`、`SJS_LAB_REDIS_URL`。

机器读取 JSON 时，直接调用 Node 入口以避开 npm 脚本标题：

```sh
node src/cli.mjs status --json
node src/cli.mjs check --json
```

up / down / check 的进度写到 stderr，JSON 写到 stdout。不要将两者合并后再按 JSON 解析。`node src/cli.mjs --help` 可查看程序内帮助。

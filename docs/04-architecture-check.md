# 看懂检查与报告

`npm run check` 检查正在运行的 mirror 部署。它回答的是“当前模式需要的同步行为是否正常”，同时记录一小段负载数据。

## 先运行一次

```sh
npm run up -- --mode=single
npm run check
npm run down
```

报告保存在 `reports/check-<时间戳>.md` 和同名 JSON 文件中。终端显示结论和文件路径；控制台也能查看报告。

`check` 使用 Node 模拟客户端，不需要 Chrome。浏览器页面另用 `npm run test:ui` 检查；官方实现另用 `npm run test:official`。对 `impl=real` 运行 `check` 会明确报不支持。

## 先看结论

| 结论 | 含义 | 退出码 |
|---|---|---|
| `healthy` | 当前模式要求通过的检查都通过了 | 0 |
| `broken` | 有要求通过的检查失败 | 1 |
| `degraded` | 有要求通过的检查没能完成，需看原因 | 3 |
| `expected-broken` | 故意配错的变体复现了预期问题 | 0 |
| 没有运行中的部署 | 先执行 `up` | 2 |

`healthy` 只说明本次行为检查通过。负载样本只记录、不设性能门槛，因此它不能证明你的容量目标已经达成。

## 再看每一项

终端结果的四列分别是“状态 / 期望 / 检查项 / 说明”。

| 状态 | 怎么理解 |
|---|---|
| `PASS` | 满足当前模式的要求 |
| `FAIL` | 不满足要求，查看说明和建议 |
| `N/A` | 该模式不需要，或这次没能验证；原因写在说明中 |
| `RECORD` | 只记录观察结果或数字 |
| `EXPECTED-FAIL` | 错误变体中故意复现的失败 |

例如，同房间的两个用户分处不同节点，在 `sharded` 下本来就不应这样部署，所以“跨节点未收到消息”不作为失败；检查会要求正常入口把他们分到同一节点。`shared` 则要求跨节点消息正常，未送达就会失败。

JSON 的 `expected` 表示要求，`status` 表示本次结果。要求可能是 `pass`（必须通过）、`colocated`（必须同节点）、`not-required` / `n/a`（不适用）、`record`（仅记录）或 `not-dangerous`（不能出现误导验收的组合）。

## 十二项检查

| 检查 id | 观察什么 |
|---|---|
| `nodes.health` | 节点和负载均衡是否健康 |
| `topology.config` | 实际节点配置是否与所选模式一致 |
| `lb.distribution` | 不同连接是否能分散到多个节点 |
| `room.placement` | 同房间的客户端分别连接哪个节点 |
| `realtime.sameNode` | 同节点客户端能否及时收到修改 |
| `realtime.crossNode` | 不同节点客户端能否在限定时间内收到修改 |
| `join.consistency` | 换节点加入后，能否读取刚才的文档 |
| `store.consistency` | 各节点看到的文档版本是否一致 |
| `eventual.mask` | 是否出现“实时不通，重新加入却看起来正确”的组合 |
| `isolation.rooms` | 房间 A 的消息是否误发到房间 B |
| `ack.latency` | 写入获得服务端确认所需的时间 |
| `load.scenario` | 一小段负载下的成功数、失败数和延迟，仅记录 |

具体到各模式的期望，见 [modes.mjs](../src/lab/modes.mjs)；执行与判断逻辑在 [runner.mjs](../src/checks/runner.mjs)。

## 换成自己的场景

```sh
npm run check -- --users=50 --interval=2 --duration=10 --rooms=5
```

默认是 20 用户、每人每 2 秒编辑一次、持续 8 秒、1 个房间。`--interval` 和 `--duration` 的单位都是秒。

负载阶段默认最多生成 300 个客户端。超过上限时，报告同时记录请求人数和实际人数，模型仍根据请求场景估算；不要把模型数字当成全量实测。需要持续负载用 [bench](05-performance.md#8-用你自己的场景测)。

## 在脚本中使用

`--fail-on-degraded` 会把无法完成的必要检查也算作失败，退出码从 3 改为 1。`--out-dir=<目录>` 可调整报告位置。

需要机器可读输出时，直接调用 Node 入口，避免 npm 的脚本标题混入 stdout：

```sh
node src/cli.mjs check --json --fail-on-degraded
```

先运行 `up`，保存 `check` 的退出码，并在成功或失败时都执行 `down`。除了检查退出码，还应保留报告，确认运行的模式和场景符合预期。

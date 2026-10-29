# SpreadJS 协同架构实验室

[English](README.en.md)

两个人一起编辑表格时，一台服务器就能把修改转发给对方。如果用户变多，需要增加服务器，同一份表格上的修改还能及时同步吗？

这个项目提供三种可运行的部署方式，以及几种故意配错的例子。你可以在自己的电脑上启动它们，打开两个页面编辑，再运行检查，观察消息有没有送达、重新加入时数据是否一致。

它适合用来学习 SpreadJS 协同服务的部署方式、排查多节点同步问题，以及做初步负载实验。默认使用不需要商业授权码的 `mirror` 演示实现；官方实现需要另行配置授权。

## 先跑起来

本仓库主要展示 Windows 上的部署实验，帮助你理解架构并验证自己的场景。准备 Node.js 22 或 24 的 LTS 版本和 npm，以下命令都在工程根目录的 PowerShell 中执行。当前已在 Windows + Node.js 24 上验证；macOS / Linux 尚未验证。

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

## 想测自己的用户场景

先启动一个模式，再指定用户数、编辑间隔、持续时间和房间数。建议从小场景开始：

```sh
npm run up -- --mode=single
npm run bench -- --users=50 --interval=2 --duration=20 --rooms=1
npm run down
```

这里 `--interval=2` 表示每人每 2 秒编辑一次，`--duration=20` 表示持续 20 秒。`bench` 测试的是 `mirror` 演示实现，结果不能当成官方 SpreadJS 服务的容量结论。

同样是 1000 人在线，分散在不同文档、很少编辑，与集中在一份文档、频繁编辑，负载会相差很大。先看 [性能测试怎么做](docs/05-performance.md)，再增加人数。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run doctor` | 检查依赖、端口、Redis、浏览器与授权配置 |
| `npm run up -- --mode=single` | 启动一个部署，可选 `single` / `sharded` / `shared` |
| `npm run status` | 查看当前部署和节点健康状态 |
| `npm run web` | 单独启动控制台，然后在页面上操作 |
| `npm run check` | 检查正在运行的 mirror 部署，生成报告 |
| `npm run bench -- --users=50 --interval=2 --duration=20` | 给正在运行的 mirror 部署施加负载 |
| `npm run compare` | 依次启动并检查三种模式，生成对比报告；需要 Redis |
| `npm run down` | 停止当前部署 |
| `npm run self-test` | 运行工程自测；缺 Redis 时会跳过相关用例 |

完整参数见 [命令参考](docs/10-cli-reference.md)。`check` 不依赖浏览器；页面测试使用 `test:ui`，官方实现的测试使用 `test:official`。

## 按需要继续阅读

| 你想做什么 | 文档 |
|---|---|
| 跑通第一个例子 | [第一次运行](docs/01-quickstart.md) |
| 了解节点、房间、Redis 的作用 | [模式说明](docs/02-modes.md) |
| 为自己的场景选一种部署方式 | [选型指南](docs/03-decision-guide.md) |
| 看懂检查结果 | [检查与报告](docs/04-architecture-check.md) |
| 做负载测试、了解历史数据的范围 | [性能与容量](docs/05-performance.md) |
| 评估上线前还缺什么 | [生产部署注意事项](docs/06-production.md) |
| 使用官方实现 | [授权与官方实现](docs/07-license.md) |
| 解决启动或同步问题 | [排障](docs/08-troubleshooting.md) |
| 把节点或负载生成器放到其他电脑 | [多机操作手册](docs/09-multi-machine.md) |
| 看一个真实客户场景怎么算硬件 | [场景评估样例（SaaS 2 000 文档）](docs/12-scenario-assessment-saas-2000docs.md) |
| 修改代码、提交贡献 | [贡献指南](CONTRIBUTING.md) |

## 使用范围

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

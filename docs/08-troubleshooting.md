# 排障：先找到失败在哪一步

先运行 `npm run status`，确认是否有部署，再运行 `npm run doctor` 查看环境。节点日志在 `logs/node-<端口>.log`，入口日志在 `logs/lb.log`，控制台日志在 `logs/web.log`。

## 安装与启动

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `npm install` 失败 | 网络、Node 版本或原生模块构建问题 | 使用 Node 22 / 24 LTS，查看第一条错误；sqlite3 无可用预编译包时需本机构建工具 |
| 提示已有 stack | 上次部署仍在运行 | 先 `npm run down` |
| 3000 / 5173 / 8081 等端口占用 | 上次部署或其他程序占用 | 用 status 确认；修改 `config/lab.config.json` 或自行停止占用程序 |
| shared 找不到 Redis | 没有可用实例、本地程序或 Docker | 先用 single / sharded；为 shared 准备 Redis |
| 节点启动失败，exit 2 | Redis、授权或节点配置不满足要求 | 看节点日志的第一条错误；不会自动退回另一种实现 |
| down 返回 1 | 仍有记录的进程未能停止 | 查看输出，修复权限等原因后重试；不要先删状态文件 |

工程不包含 Redis 二进制。开发工作区可能从父目录找到 Redis 程序，但独立克隆不会有这份资源。

## 页面打不开或连不上

先确认控制台是否启动、地址和端口是否正确。`npm run web` 只启动控制台，尚未启动节点时页面会显示未运行。

| 现象 | 排查 |
|---|---|
| 控制台正常，编辑页未连接 | 先启动一种模式，查看节点是否健康 |
| `Invalid namespace` | Socket.IO 的 `path` 应放在选项中，不能拼进服务 URL |
| official 页面缺少 bundle | 运行 `npm run build:official`，并启动 real 模式 |
| 从局域网 IP 打开后授权错误 | 浏览器访问地址改变，需要核对 runtime 授权 |
| 两个标签页显示同一节点 | single / sharded 同房间时正常；shared 可用不同 `port` 参数直连诊断 |

本工程 mirror 页面每个标签页建立独立连接，普通标签页就能做双端演示。隐身窗口可用于排除你额外引入的 cookie / storage 身份冲突。

## 两个人看不到对方的修改

1. 确认两个页面都已连接，且 room 相同、label 不同。
2. 看页面显示的节点。在 sharded 下，同房间应在同节点；shared 可以不同。
3. 在运行中的 mirror 部署上执行 `npm run check`，先看 `topology.config`、`room.placement` 和 `realtime.crossNode`。
4. 如果刷新后才看到内容，重点检查 Redis 适配器。共享文档库不会替代实时消息转发。
5. 如果实时能收到、换节点重新加入却空白，重点检查文档库是否真的共享。

故意配错的 broken-* 变体中，`EXPECTED-FAIL` 是预期现象；正常模式里的 `FAIL` 需要处理。

## 检查结果不符合预期

| 现象 | 说明 |
|---|---|
| check 提示没有 stack | check 不会启动部署，先运行 up |
| single / sharded 的跨节点项是 N/A | 模式不要求这项能力，查看“期望”列 |
| 结论 degraded | 有必要检查没能完成，查看每项原因 |
| 缺 Chrome，但 check 能通过 | 正常；check 用 Node 模拟客户端，不依赖浏览器 |
| 对 real 运行 check 报不支持 | 改用 `npm run test:official` |
| 压测人数少于请求人数 | check 默认最多生成 300 个客户端；看 requestedUsers、clients 和 capped |
| healthy 但负载样本有失败 | 性能样本是 RECORD，不参与 healthy 判定；继续看失败数与延迟 |

完整状态与退出码见 [检查与报告](04-architecture-check.md)。

## 浏览器自动测试

`npm run test:ui` 需要 Chrome 或 Edge。路径找不到时，用环境变量 `SJS_BROWSER` 指向浏览器可执行文件。官方测试还需要构建页面和有效授权，见 [授权说明](07-license.md)。

这些脚本会启停自己的部署，运行前先结束交互演示。浏览器测试使用的 Node 全局 WebSocket API 在较旧 Node 版本中可能不可用，建议使用 Node 22 / 24 LTS。

## SQLite 与数据库

shared 演示同时打开本机 SQLite 文件。看到 `SQLITE_BUSY` 时，查看是否有其他实验进程还在访问同一数据库；降低并发，结束重复部署后再试。先保存日志和数据，不要靠反复删除文件掩盖问题。

历史 PostgreSQL 工程中的并发建表 `23505` 不属于当前工程自带的数据库路径。若你自行接入 PostgreSQL，需处理初始化幂等与锁竞争；当前没有可以直接启用的 PG 配置。

## 多机连不上

检查三条方向：controller 到 agent 控制端口、controller 到 agent 节点端口、agent 到 controller 的负载均衡端口。agent 的 public-host 应是 controller 能访问的地址。

真实跨机时，controller 不能只监听 127.0.0.1；同时应配置它对 agent 公布的入口地址。完整命令见 [多机手册](09-multi-machine.md)。

## 提交问题时带什么

提供操作系统、Node 版本、模式与实现、复现命令、预期和实际现象，以及相关日志片段。可附 check 的 Markdown / JSON 报告。

先脱敏授权码、管理 token、带密码的连接 URL、真实文档内容和敏感地址。命令行也可能含凭据，不要直接复制整个终端。

# 第一次运行

这一页带你启动一个节点，让两个页面互相看到编辑，再生成一份检查报告。整个过程使用默认的 `mirror` 实现，不用填写商业授权码，也不用安装 Redis。

## 1. 准备环境

本指南以 Windows + PowerShell 为主。安装 Node.js 22 或 24 的 LTS 版本（本轮验证使用 24；工程最低声明为 20，不代表所有测试在 20 上都已验证）。npm 随 Node.js 安装。用下面的命令确认可用：

```sh
node --version
npm --version
```

下载或克隆仓库后，在本工程根目录打开 PowerShell。这个目录里应有 `package.json`、`src/`、`public/` 和 `config/`。macOS / Linux 尚未验证。

通过 Git 获取工程：

```powershell
git clone https://github.com/GrapeCityXA/spreadjs-collab-arch-lab.git
cd spreadjs-collab-arch-lab
```

如果下载的是 ZIP，解压后在解压目录打开 PowerShell，再执行下面的命令。

```sh
npm ci
npm run doctor
```

`npm ci` 按锁文件安装依赖。`doctor` 会列出依赖是否可用、端口是否空闲，以及 Redis、浏览器和授权的状态。首次安装的耗时取决于网络和原生模块安装情况。

第一次只需要关注必需依赖和端口。没有 Redis 仍能跑 `single`、`sharded`；授权显示 `MISSING` 不影响默认演示。`check` 使用 Node 模拟客户端，不依赖 Chrome；浏览器自动测试才需要 Chrome 或 Edge。

## 2. 启动一个节点

```sh
npm run up -- --mode=single
```

看到“控制台”地址后，打开 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)。你应该看到单节点模式和一个健康节点。

默认端口如下。被其他程序占用时，启动会报错，不会自动换一个端口。

| 组件 | 端口 |
|---|---|
| 网页控制台 | 5173 |
| 协同节点 | 从 8081 开始 |
| 多节点入口（负载均衡） | 3000 |
| Redis，仅部分模式需要 | 6379 |

端口配置在 [config/lab.config.json](../config/lab.config.json)。

## 3. 打开两个编辑页面

分别打开 [Alice](http://127.0.0.1:5173/client/?room=arch-lab-demo&label=alice&auto=1) 和 [Bob](http://127.0.0.1:5173/client/?room=arch-lab-demo&label=bob&auto=1)。两个普通标签页即可。

1. 等待两个页面都显示已连接。
2. 在 Alice 的 A1 输入一个值，确认 Bob 的 A1 出现相同值。
3. 在 Bob 的 B1 输入另一个值，确认 Alice 也收到。

这两个链接的 `room` 相同，所以属于同一份演示文档。昵称 `label` 不同，方便在日志里区分。单节点模式下，两个页面显示同一个节点是正常的。

这里演示的是单元格值同步。真实工作簿的官方协作绑定和冲突处理，需要另走 [官方实现](07-license.md)。

## 4. 运行检查

保持服务运行，在终端执行：

```sh
npm run check
```

命令会建立少量模拟连接，检查消息送达、房间隔离等行为，再跑一段短负载。正常情况下结论是 `healthy`，报告位于 `reports/check-*.md` 和 `reports/check-*.json`。

先看结论，再看明细中标为 `FAIL` 的项。`N/A` 可能表示当前模式不需要这项能力，例如单节点没有“跨节点同步”；具体原因写在说明里。`RECORD` 只记录数字，不判断性能是否达标。完整读法见 [检查与报告](04-architecture-check.md)。

## 5. 停止服务

```sh
npm run down
npm run status
```

`status` 应显示没有运行中的部署。`down` 根据 `.lab/state.json` 停止工程记录的进程；日志和数据会保留。若提示停止失败，保留状态文件，查看原因后重试。

## 接着试多节点

先用不依赖 Redis 的 `sharded`：

```sh
npm run up -- --mode=sharded
npm run check
npm run down
```

它默认启动三个节点，同一房间的用户固定落在一个节点上。不同房间可以分散到不同节点。

`shared` 允许同一房间的用户落在不同节点。它需要 Redis 和共享文档库：

首次使用请先按下面的步骤准备 Redis，再执行：

```sh
npm run up -- --mode=shared
npm run check
npm run down
```

工程会尝试复用配置地址上的 Redis、查找 `tools/redis/` 或 `SJS_REDIS_BIN` 指定的程序，最后尝试 Docker。独立仓库不提供 Redis 程序。共享文档库由本机 SQLite 文件演示。

在 `shared` 下可观察两个页面是否落到不同节点；也可在 URL 加 `&port=8081`、`&port=8082`，分别直连指定节点，验证跨节点同步。直连绕过了负载均衡，仅用于诊断。

## 在 Windows 上准备 Redis

推荐使用 [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)。按安装向导启用 WSL 2，启动 Docker Desktop，并切换到 Linux containers。若暂时不准备 Docker，先用 single / sharded 即可。

在 PowerShell 中确认 Docker 服务可用：

```powershell
docker version
```

输出应同时包含 Client 和 Server；只有 Client 或提示连接失败时，先打开 Docker Desktop，等待引擎就绪。

下面的命令创建一个专供演示使用的 Redis 容器，只把端口开放给本机。首次运行需要联网下载镜像：

```powershell
docker run --name sjs-lab-redis -d -p 127.0.0.1:6379:6379 redis:7-alpine
docker exec sjs-lab-redis redis-cli ping
```

收到 `PONG` 后，回到工程根目录执行 `npm run doctor`，再启动 shared。以后电脑重启或手动停止容器后，用下面的命令恢复，无需重新创建：

```powershell
docker start sjs-lab-redis
docker exec sjs-lab-redis redis-cli ping
```

如果 6379 已有 Redis，直接使用已有实例，不必再创建容器。如果该端口被其他程序占用，可以换用 6380：

```powershell
docker run --name sjs-lab-redis-alt -d -p 127.0.0.1:6380:6379 redis:7-alpine
$env:SJS_LAB_REDIS_URL = 'redis://127.0.0.1:6380'
npm run doctor
npm run up -- --mode=shared
```

环境变量只对当前 PowerShell 及其子进程生效，后续 check / bench / down 也在这个窗口执行。恢复默认配置可执行 `Remove-Item Env:SJS_LAB_REDIS_URL`。

演示结束先运行 `npm run down`。手动创建的 Redis 容器不会随工程停止；暂时不用时执行 `docker stop sjs-lab-redis`，使用备用容器时将名称改为 `sjs-lab-redis-alt`。名称已存在时用 `docker ps -a` 查看，后续用 start 启动已有容器。

## 遇到问题

| 现象 | 先做什么 |
|---|---|
| 安装依赖失败 | 使用受支持的 Node LTS，查看第一条安装错误；`sqlite3` 是原生模块，可能需要构建工具 |
| 端口被占用 | `npm run status` 确认是否是上次的部署；其他程序占用时改配置或由你停止该程序 |
| 提示已有部署 | 先运行 `npm run down` |
| `shared` 缺少 Redis | 先用 `single` / `sharded`；需要时再准备 Redis 或 Docker |
| `check` 说没有部署 | 先运行 `up`，`check` 不会替你启动 |
| 两个页面不同步 | 确认 `room` 相同、`label` 不同，查看页面连接状态和消息日志 |

其他问题见 [排障](08-troubleshooting.md)。下一步可以阅读 [三种模式](02-modes.md)，或直接做一个小规模 [负载测试](05-performance.md#8-用你自己的场景测)。

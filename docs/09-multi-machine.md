# 多机操作手册

先完成 [本机演示](01-quickstart.md)。这一页说明怎样把协同节点和负载生成器分到不同进程或机器。

controller 是主控，负责启停编排和负载均衡；agent 是其他机器上的辅助程序，每个 agent 启动一个协同节点，也能生成一部分模拟用户。

## 1. 什么时候用

只想理解三种模式时，一台电脑就够了。要分担负载生成器的工作，或研究实际网络的影响，再使用 agent。

同机测试时客户端和服务器争用 CPU；拆开后可以分别观察。是否需要多台机器取决于负载与硬件，没有固定的“超过多少人必须多机”的阈值。

## 2. 当前支持范围

| 用法 | 当前范围 |
|---|---|
| sharded + agent | 已实现，现有自动验证使用同机进程模拟 |
| bench 分布式负载 | 已实现，现有自动验证使用同机进程模拟 |
| shared + 本机 loopback agent | 可以共享同一个 SQLite 文件，适合同机模拟 |
| shared + 真实远端 agent | 启动时拒绝；当前文件存储不能跨主机共享 |
| PostgreSQL 共享存储 | 当前工程未接入，需要开发 |

这里“已实现”不等于已经在真实多台机器上验证。历史官方性能工程的一次有线跨机测试，也不能代替本工程 agent 的真实网络验收。

### shared 为什么不能直接跨主机

shared 需要所有节点读写同一份文档库。当前演示用 SQLite 文件，相同路径出现在两台电脑上，仍然是两个不同文件。若允许这种部署，会变成“消息通、文档不共享”的错误配置。

本工程因此拒绝非 loopback agent 的 shared。需要真实跨机共享房间时，应先实现服务型数据库存储；目前没有改一个参数就能启用 PostgreSQL 的路径。

## 3. 先在一台电脑模拟

以下使用三个终端。先生成一个随机 token，用同一个值替换所有 TOKEN_VALUE。不要把真实值提交进仓库。

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

终端 A：

```sh
npm run agent -- --port=9100 --node-port=8091 --lb=http://127.0.0.1:3000 --token=TOKEN_VALUE --public-host=127.0.0.1
```

终端 B：

```sh
npm run agent -- --port=9101 --node-port=8092 --lb=http://127.0.0.1:3000 --token=TOKEN_VALUE --public-host=127.0.0.1
```

agent 启动时就会拉起节点，所以 agent 控制端口和 node-port 都要空闲。这里错开了主控默认的 8081 / 8082。

终端 C：

```sh
npm run up -- --mode=sharded --nodes=2 --agents=http://127.0.0.1:9100,http://127.0.0.1:9101 --agent-token=TOKEN_VALUE
npm run status
npm run check
```

此时有 4 个节点：主控启动的两个，加两个 agent 节点。`--nodes=2` 只计算主控本地节点。`up` 会把本次模式配置发给 agent；已有节点配置不一致时，agent 会重启节点再注册到入口。

主控只需要一个本地节点时可改成 `--nodes=1`，加上两个 agent 后共 3 个节点，仍会启动负载均衡并保留模式所需的适配器和存储设置。`single` 模式不接入 agent。

在同机模拟中，可以先 down，再把模式改成 shared 验证共享房间，需要 Redis。

## 4. 分布式压测

在终端 C、部署仍运行时：

```sh
npm run bench -- --users=60 --interval=2 --duration=10 --rooms=6 --distribute=local,http://127.0.0.1:9100,http://127.0.0.1:9101
```

60 是总用户数，会分配给本机和两个 agent，并非每台 60 人。`local` 表示主控也生成用户。裸参数 `--distribute` 表示本机和所有已附着 agent。

所有生成器按同一套全局用户序号分配房间，人数不能整除时按商和余数均匀分配。生成器数量不会改变目标房间数或每房间人数；请核对报告中的实际房间分布与请求是否一致。

主控等所有参与者建连并加入房间后才释放写入；先写完的参与者继续保留连接，直到全部写完再一起释放。这样目标房间成员在写入期间同时在线。开始信号经网络传输，不能保证各机同一毫秒开写；无需依赖跨机时钟同步。准备、写入或控制请求失败时会取消全部参与者。

sharded 按房间路由。即使生成器分布到三台机器，单房间仍会固定在一个节点上。验证房间分摊时，要使用多个房间。

报告会列每个参与者的用户数、操作数、失败数和延迟。聚合广播分位数取参与者中最差的一项；ACK分位数由每个参与者最多500条保留样本合并估计，均不是全部操作的真实全局分位数。投递量由房间人数和操作数推算，不能作为所有收件端都已收到消息的证明。

`connectionMs` 记录建连阶段，`writingMs` 记录写入阶段；发送/成功速率均使用写入窗口。多生成器统一以最长参与者写入窗口归一化，报告会注明统计口径。发送速率达成率只说明是否生成了配置要求的操作量，不能单独证明服务端容量；`broadcastReceived` 是客户端实际观察到的广播数，与推算投递量分别报告。旧 agent 的统计若含建连，会标为 `legacy-elapsed-fallback`，应统一版本后重测。

广播接收从本参与者ready开始，持续到所有参与者写完后释放连接，以覆盖开始信号的网络时差和较慢写入者。`receiveWindowMs`记录这段窗口，`broadcastReceivedPerSecond`按它计算；它与写入窗口不同，不能直接与推算投递率相减来判断丢消息，也不是逐条收件确认或去重校验。

ACK延迟在同一生成器内计时。广播延迟用接收端时间减发送端时间，真实跨主机时仍需要校准时钟并记录偏差；屏障本身不依赖时钟同步，不表示广播延迟也免受时钟偏差影响。

## 5. 停止

在主控运行：

```sh
npm run down -- --stop-agents
```

默认 down 只摘除远端节点，保留 agent 进程；加 stop-agents 会请求 agent 一并退出。若主控不可达，可在 agent 终端按 Ctrl+C，并确认节点端口已释放。

`.lab/state.json` 保存清理所需信息和管理凭据。不要在停止前手动删除，也不要公开上传。

## 6. 换成真实机器

每台机器使用同一份代码和匹配的依赖，先安装并运行 doctor。下面用主控 192.168.1.10、agent 192.168.1.21 举例；请换成实际地址。

端口需要双向按用途放行：

| 方向 | 端口 | 用途 |
|---|---|---|
| 主控 → agent | 9100 | 控制请求 |
| 主控 → agent | 8081 | 节点健康检查与代理 |
| agent → 主控 | 3000 | 节点注册与负载连接 |

agent 上：

```sh
npm run agent -- --port=9100 --node-port=8081 --lb=http://192.168.1.10:3000 --token=TOKEN_VALUE --public-host=192.168.1.21
```

public-host 是主控访问这个节点时使用的地址。真实远端不要填 127.0.0.1，否则主控会连接自己。

主控还要监听可被 agent 访问的地址，并公布相同入口。PowerShell 示例：

```powershell
$env:SJS_LAB_BIND_HOST = '0.0.0.0'
$env:SJS_LAB_LB_PUBLIC_URL = 'http://192.168.1.10:3000'
npm run up -- --mode=sharded --nodes=2 --agents=http://192.168.1.21:9100 --agent-token=TOKEN_VALUE
```

macOS / Linux 的环境变量写法如下，仅供参考，尚未在这些系统验证：

```sh
export SJS_LAB_BIND_HOST=0.0.0.0
export SJS_LAB_LB_PUBLIC_URL=http://192.168.1.10:3000
npm run up -- --mode=sharded --nodes=2 --agents=http://192.168.1.21:9100 --agent-token=TOKEN_VALUE
```

也可在主控的 lab.config.json 中设置 bindHost 和 lbPublicUrl。全接口监听只适合受信实验网络，应用防火墙限制访问；当前诊断面没有完整鉴权，见 [部署注意事项](06-production.md)。

命令行 token 会留在进程参数或 shell 历史里。需要避免时，agent 可用 `SJS_LB_ADMIN_TOKEN`、主控可用 `SJS_LAB_AGENT_TOKEN` 传入，随后省略各自的 token 参数。

以上是真实跨机的操作说明，仍需在你的网络中验证，不能根据同机测试宣称跨机容量达标。

## 7. 常见失败

| 现象 | 排查 |
|---|---|
| 401 / 403 | 两边 token 是否一致；管理接口是否启用 |
| agent 启动就端口冲突 | 同时检查控制端口和节点端口 |
| 节点被注册但不健康 | public-host 是否是主控可达地址，节点端口是否放行 |
| attach 时连不到负载均衡 | 主控是否仅监听 loopback，lbPublicUrl 是否正确 |
| single 不能附着 agent | 改用 sharded/shared；--nodes=1 表示一个本地节点，可以再加 agent |
| shared 被拒绝 | 看前面的 shared 限制；不要通过改写地址绕过存储检查 |
| 总人数增多但单节点仍满 | sharded 单房间固定在一个节点，先检查房间分布 |
| 延迟很高但服务端 CPU 不高 | 同时观察生成器、网络和数据库，不要只看节点 CPU |

## 8. 自动验证与验证范围

```sh
npm run test:distributed
```

它使用本机两个 agent 模拟远端，检查附着、节点注册、负载分摊和清理。无需另找两台机器。

当前结论仅覆盖本机编排机制。真实跨机网络、TLS、云防火墙、跨版本运行、数据库高可用与大规模容量都不在这条测试的保证范围内。性能测试方法见 [性能与容量](05-performance.md)。

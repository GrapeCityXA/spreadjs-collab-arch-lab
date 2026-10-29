# 授权与官方实现

默认的 `mirror` 演示不需要填写商业授权码。只有要接入官方协同实现时，才需要配置下面的授权。

MIT 许可覆盖本仓库自己的代码。通过 npm 安装的 SpreadJS 和协同包保留各自的商业许可；可下载依赖不代表已经获得生产使用权，具体以产品许可为准。

## 哪个 key 对应哪个组件

| 配置字段 | 用途 |
|---|---|
| `runtime.licenseKey` | 浏览器中的 SpreadJS 表格控件 |
| `designer.licenseKey` | Designer 组件；本工程通常不需要 |
| `server.serverLicenseKey` | 官方协同服务端，绑定机器码 |

三种 key 不能互换。本项目的本机页面可以在 localhost / 127.0.0.1 上演示；切换域名或局域网 IP 后，应按所用产品版本和访问地址确认授权要求。服务端授权仍独立需要配置。

## 配置文件

复制 [license.example.json](../config/license.example.json) 为同目录的 `license.json`，填入你有权使用的 key。`config/license.json` 已被 Git 忽略。

doctor、启动命令、控制台、节点和官方测试使用相同的读取规则：默认只读取本工程的 `config/license.json`，不会自动查找父目录。也可通过 `SJS_LICENSE_FILE` 指定另一个文件；相对路径以工程根目录为准，外部文件推荐使用绝对路径。显式指定的文件不存在或 JSON 格式错误时会报错。

以下环境变量可覆盖文件中的同类字段：

- `SJS_LICENSE_KEY`
- `SJS_DESIGNER_LICENSE_KEY`
- `SJS_SERVER_LICENSE_KEY`

不指定文件时，也可以只用环境变量配置，不强制创建授权文件。例如在 PowerShell 中使用 `$env:SJS_SERVER_LICENSE_KEY = '你的服务端授权码'`，再执行启动命令。若之前设置过 SJS_LICENSE_FILE，先确认它指向有效文件，或用 `Remove-Item Env:SJS_LICENSE_FILE` 清除它。

doctor 显示 SET 只表示读到了值；启动与浏览器运行时才由对应 SDK 检查有效期、机器码或访问地址。控制台也只显示“已配置”，不表示“授权有效”。

不要在 issue、截图、日志或报告里贴真实授权码。

## 取机器码

```sh
npm run doctor
```

在“授权”部分读取当前机器码，用它申请服务端授权。它不是 IP 或机器名。机器身份文件丢失、重新生成或主动停用授权后，机器码可能改变，申请前应在目标环境重新确认。

doctor 只显示 key 是否配置，不能证明授权有效、未过期或适用于当前机器。

## 用官方实现打开页面

先结束现有部署，配置文件并构建页面：

```sh
npm run down
npm run build:official
npm run up -- --mode=single --impl=real
```

打开 [官方客户端页面](http://127.0.0.1:5173/official/?room=official-demo&label=alice)。可另开一个 label 为 bob、room 相同的页面互相编辑。结束后运行 `npm run down`。

多节点官方实验可将模式换成 shared，需要 Redis 和本机共享 OT 存储。该路径仍是本机实验，不是跨主机 PostgreSQL 部署。

## 自动验证

官方实现需要真实浏览器：

```sh
npm run down
npm run build:official
npm run test:official
```

测试脚本会自行启停部署。验证共享模式可用 `npm run test:official -- --mode=shared`。

缺授权时脚本会说明本次未执行并退出 2，不能算通过。Chrome / Edge 不在默认路径时，用 `SJS_BROWSER` 指定可执行文件。

`npm run check` 和 `npm run bench` 仅支持 mirror；对官方实现请使用 test:official。不要将 Node 模拟客户端的授权结果当成浏览器 SDK 的结论。

## 常见问题

| 现象 | 排查方向 |
|---|---|
| real 模式提示授权文件不存在 | 确认文件位置或 `SJS_LICENSE_FILE` |
| 有 key 仍被拒绝 | 核对 key 类型、机器码、有效期和浏览器访问域名 |
| official 页面提示 bundle 缺失 | 先运行 `npm run build:official` |
| mirror 启动正常 | 只说明 mirror 可用，不代表官方授权已验证 |
| doctor 显示 SET | 只表示读到了值，不代表授权验证通过 |

不要通过伪造域名或修改 SDK 校验逻辑处理授权错误，应使用与部署环境匹配的有效授权。

# 贡献指南

欢迎提交问题、改进文档或修复代码。使用问题请附上复现步骤；涉及性能的结论，请同时说明场景和测量条件。

## 准备开发环境

在工程根目录运行：

```sh
npm ci
npm run doctor
```

主要验证环境是 Windows + PowerShell，推荐 Node.js 22 / 24 LTS，本轮使用 Node.js 24。npm ci 按锁文件安装。独立克隆需要安装自己的依赖。macOS / Linux 尚未验证，不要求贡献者完成三平台验收。维护者的嵌套工作区可能会从父目录解析依赖，但这不能代替独立安装验证。

## 按改动选择验证

测试会启停部署，运行前先停止正在手动操作的实验。

| 改动 | 建议验证 |
|---|---|
| 文档 | 运行 `npm run docs:check`，核对参数与实际命令是否一致 |
| 节点、入口、检查逻辑 | `npm run self-test`，需要 Redis 才能覆盖全部模式 |
| 控制台 / CLI JSON / 停止接口 | `npm run test:api` |
| 场景输入、结果判定、授权配置 | `npm run test:inputs`，涉及页面时再运行 `test:ui` |
| 页面 | `npm run test:ui`，需要 Chrome / Edge |
| agent / 分布式负载 | `npm run test:distributed` |
| 官方协同接入 | 构建页面后运行 `npm run test:official`，需要有效授权和浏览器 |

没有 Redis 时，self-test 会列出跳过项；提交说明中写清哪些实际运行、哪些没运行。没有授权的 official 测试跳过，也不能写成验证通过。

只验证 single / sharded 时可用：

```sh
npm run self-test -- --only=single,sharded
```

## 代码约定

- 使用 ESM、Node 内置模块的 `node:` 前缀，以及跨平台路径。
- 子进程日志写文件或继承文件描述符，避免依赖特定 shell 与管道。
- 配置无效、端口冲突、缺少 Redis 或授权时，明确失败并说明原因，不要悄悄切换实现。
- 模式与检查预期定义在 `src/lab/modes.mjs`。
- 场景模型定义在 `src/lab/scenario.mjs`；负载生成共用 `src/bench/load.mjs`。
- 远程请求应有超时、错误原因和清理路径。
- 修改用户可见行为时，同步更新文档；修复缺陷时添加能重现该行为的验证。

完整接口和报告结构见 [开发参考](docs/DEV-CONTRACT.md)。其中的模块 owner 表用于说明职责，不要求外部贡献者先获得某个内部角色。

## 修改文档

优先描述读者要完成的动作，再给必要术语。入门页使用短例子，完整参数放 [命令参考](docs/10-cli-reference.md)，避免每一页重复一张长表。

性能数字要区分本次实测、历史记录、模型估算和未验证。mirror 的测试不能证明官方 OT 行为或官方性能。同机 agent 测试也不能称为真实跨主机验收。

更改标题时检查锚点链接。命令若使用多行续行符，说明终端差异；常用示例尽量用单行，便于 PowerShell 和其他终端直接执行。

## 提交问题或改动

问题中请写：

- 操作系统、Node 版本、工程版本或 commit；
- 使用的模式、实现、复现命令；
- 预期结果、实际结果和相关报告 / 日志片段。

先移除授权码、管理 token、带密码的连接 URL 和真实文档内容。不要提交 `config/license.json`、`.lab/`、`data/`、`logs/` 或未经脱敏的报告。

改动说明应包括解决的问题、最终行为、验证结果和已知限制。添加依赖时说明用途，更新 package.json 及锁文件。已有验证结果和待处理问题见 [审查记录](docs/11-project-review.md)。

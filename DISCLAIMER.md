# 使用边界与免责声明 / Scope and disclaimer

## 中文

本项目供客户与售前、售后在目标环境中开展协同部署与负载实验、收集测量依据，以及形成待验证的容量假设与硬件候选；也可用于学习、复现和检查协同部署行为。使用时应同时阅读 [README](README.md)、[客户环境实验指南](docs/14-customer-sizing-guide.md)、[性能与容量](docs/05-performance.md)、[生产部署边界](docs/06-production.md)及所用依赖的许可条款。

### 模型、硬件样例与 AI 回答

本仓库的模型、示例配置、历史记录及据此生成的 AI 回答，不构成产品或云厂商的性能认证、采购承诺、服务等级承诺，也不保证适用于特定工作负载。文档中的候选规格只有在其输入、单位、实现版本、状态规模、保留策略和故障假设成立时才有讨论意义，不能作为采购或上线的唯一依据。

默认 `mirror` 是简化的消息转发与状态共享演示，没有实现官方 OT 算法，其结果不能用来证明官方实现的性能或复杂工作簿兼容性。广播 CPU 模型没有覆盖整套系统开销；零对端广播不等于零 CPU、内存、存储或网络需求。历史官方 19.1.4 数据也不代表当前依赖版本，原始历史产物未随仓库提供。

mirror 用于验证框架、部署与消息路径，硬件评估必须使用真实 SpreadJS 官方协同链路及业务工作簿和操作负载，并收集资源监控。不得以 mirror 吞吐、延迟或每格内存乘系数的方式替代官方实现实测。默认页面使用真实 SpreadJS 控件，也不代表其 mirror 协同路径已经具备官方容量证据。

AI 可能遗漏条件、计算错误或补造信息。回答必须保留计算依据、出处、假设和未验证项；输入缺失时先补齐需求。示例问答和有限的 AI 复读检查，不保证所有模型或业务场景都能得到正确答案。

### 报告与已验证范围

`check` 的 `healthy` 只表示本次检查覆盖的拓扑行为符合预期；`expected-broken` 表示预设错误被复现；`bench` 退出 0 表示本次有成功写入、没有报告写入失败且未取消。这些结果均不等于性能、数据可靠性、安全性或生产可用性已经验收。跳过的用例不能计作通过。

当前工程验证以 Windows、Node.js 24、mirror、本机进程及同机 agent 模拟为主。同机模拟不能证明真实跨主机网络；独立安装目录不能等同于全新操作系统。测试结论只适用于记录的代码、环境、输入和时间窗口。具体记录见 [项目审查记录](docs/11-project-review.md)，统计口径见 [性能与容量](docs/05-performance.md)。

生产决策前，应使用目标官方版本、真实工作簿、实际持久化与历史链路，在目标硬件和网络上验证容量、长时间稳定性、备份恢复及所要求的故障场景。CPU、内存、IO、带宽、延迟、正确性和故障余量需要同时满足已确认的业务目标。

### 数据、运行与许可

默认 mirror 的本地文档状态在进程退出后丢失；共享 SQLite 仅用于同机实验。本仓库没有生产 PostgreSQL 适配器，管理面也没有完整的生产鉴权。使用脱敏且有代表性的测试数据，保持管理接口在受控网络内；分享日志或报告前移除凭据和真实业务内容。具体限制与待补能力见 [生产部署边界](docs/06-production.md)。

本仓库自有代码按 [MIT 许可](LICENSE)以“按现状”方式提供，保证与责任限制以该许可及适用法律为准。MIT 不覆盖 SpreadJS 或其他商业依赖，不授予其生产使用权；依赖的使用条件以各自许可或合同为准，见 [授权说明](docs/07-license.md)。

本说明补充工程用途和证据边界，不修改 LICENSE、第三方许可或另行签订的合同，也不排除适用法律不允许排除的责任。免责声明不能代替修复已知错误、披露限制或完成实际验证。

## English

This project helps customers, presales and support teams run collaboration deployment and load experiments in their target environments, collect evidence, and develop capacity hypotheses and candidate hardware configurations. It also supports learning, reproducing and checking deployment behavior. Read the [English README](README.en.md), [customer-environment experiment guide](docs/14-customer-sizing-guide.md), [performance guide](docs/05-performance.md), [production boundaries](docs/06-production.md) and applicable dependency licenses together with this notice. The linked technical guides are in Chinese.

### Models, hardware examples and AI answers

Models, example configurations, historical records and AI answers based on this repository do not constitute product-vendor or cloud-provider performance certification, procurement commitments or service-level commitments, and do not guarantee suitability for a particular workload. Candidate specifications depend on their stated inputs, units, engine version, state size, retention policy and failure assumptions. They must not be the sole basis for purchasing or production deployment.

The default `mirror` engine simplifies message forwarding and shared state; it does not implement official OT. Its results do not establish official-engine performance or complex-workbook compatibility. The broadcast CPU model omits other system costs; zero peer broadcast does not mean zero CPU, memory, storage or network demand. Historical official 19.1.4 results do not certify the current dependencies, and the original historical artifacts are not included.

Use mirror to validate the framework, orchestration and message paths. Hardware assessment requires real SpreadJS and the official collaboration pipeline, business workbooks and operations, and resource monitoring. Scaling mirror throughput, latency or bytes per cell cannot replace official-engine measurements. The default page's use of the real SpreadJS control does not establish official-engine capacity for its mirror synchronization path.

AI can omit conditions, miscalculate or invent information. Preserve calculations, sources, assumptions and unverified items, and obtain missing requirements. Example answers and limited AI reading checks do not guarantee correct answers from every model or for every business scenario.

### Reports and verification scope

A `healthy` check means the topology behavior covered by that run met expectations; `expected-broken` means an intended failure was reproduced. A zero `bench` exit code means the run had successful writes, reported no write failures and was not cancelled. None establishes performance acceptance, data reliability, security or production readiness. Skipped cases are not passed cases.

Verification currently focuses on Windows, Node.js 24, mirror, local processes and agent simulations on one host. Such simulations do not validate real cross-host networks; a separate installation directory is not a fresh operating system. Results apply only to the recorded code, environment, inputs and measurement windows. See the [review record](docs/11-project-review.md) and [measurement definitions](docs/05-performance.md).

Before production decisions, validate the target official engine and real workbooks with the intended persistence and history pipeline, hardware and network. Test capacity, sustained operation, backup recovery and required failure scenarios. CPU, memory, IO, bandwidth, latency, correctness and failure headroom must jointly satisfy agreed business targets.

### Data, operation and licensing

Default mirror local state is lost when its process exits. Shared SQLite is for experiments on one host. This repository has no production PostgreSQL adapter or complete production management authentication. Use sanitized, representative test data, keep management interfaces within controlled networks, and remove credentials and business content before sharing logs or reports. See [production boundaries](docs/06-production.md).

The repository's own code is provided "AS IS" under the [MIT license](LICENSE); warranties and liability limitations are governed by that license and applicable law. MIT does not cover SpreadJS or other commercial dependencies or grant production-use rights to them. Their licenses or contracts apply; see the [licensing guide](docs/07-license.md).

This notice explains project scope and evidence limits. It does not amend LICENSE, third-party licenses or separate contracts, or exclude liability that applicable law does not permit excluding. A disclaimer does not replace correcting known errors, disclosing limitations or performing validation.

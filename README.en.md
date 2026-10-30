# SpreadJS collaboration architecture lab

[中文](README.md)

Run collaboration deployment and load experiments in your own environment, then use the evidence with presales and support teams to assess hardware candidates. Required resources depend on concurrent documents, users per document, editing frequency and workbook complexity.

Compare single-node, document-sharded and shared-room deployments, check synchronization, increase synthetic load and save reports. The lab also includes deliberately broken configurations for troubleshooting. See the [customer-environment experiment guide](docs/14-customer-sizing-guide.md) for the workflow (in Chinese).

## Choose the right validation path

| Purpose | Required implementation | Current entry points and capabilities |
|---|---|---|
| Validate orchestration, room routing, forwarding and reporting | `mirror` | Default startup; `check`, `bench` and `big-doc` support framework and synthetic-load experiments |
| Assess CPU, memory, disk, network and machine counts for real business use | Real SpreadJS workbooks and the official collaboration client, server and OT (`real`) | Licensed integration page and small synchronization tests exist; automated business-capacity testing remains to be added |

**Use mirror to validate the framework. Hardware assessment requires the real SpreadJS official collaboration pipeline, representative workbooks and operations, and resource monitoring.** Do not convert mirror throughput, latency or bytes per cell into official-engine hardware requirements.

Here, `mirror` names the collaboration engine. The default `/client/` page also uses the real SpreadJS control, with a custom protocol for simple cell values. The `/official/` page with `--impl=real` uses the official collaboration pipeline. The `bench` tool sends mirror operations from simulated Node clients without browser workbooks. Adding a license or selecting `real` does not turn the existing `bench` into an official-engine capacity test; see the [official-engine guide](docs/07-license.md).

See the [scope and disclaimer](DISCLAIMER.md#english) for model and example conditions, and the [verification record](docs/11-project-review.md) for completed checks.

## Validate the framework first (mirror)

Use Node.js 22 or 24 LTS and npm. Run these commands from this project's root:

```sh
git clone https://github.com/GrapeCityXA/spreadjs-collab-arch-lab.git
cd spreadjs-collab-arch-lab
npm ci
npm run doctor
npm run up -- --mode=single
```

Open the [local console](http://127.0.0.1:5173/). Then check the running deployment and stop it:

```sh
npm run check
npm run down
```

`npm ci` installs from the committed lockfile. Start with `single`: it needs neither Redis nor license configuration. Run the commands in PowerShell at the project root. Windows with Node.js 24 has been verified; macOS and Linux have not. The guides below and CLI messages are currently in Chinese.

## See synchronization

While the deployment is running, open [Alice](http://127.0.0.1:5173/client/?room=arch-lab-demo&label=alice&auto=1) and [Bob](http://127.0.0.1:5173/client/?room=arch-lab-demo&label=bob&auto=1) in separate tabs. Edit a cell in either page and check the other. Both URLs use the same `room`, meaning the same demo document; `label` identifies the user.

Each page shows its server node, document version and message log. Private browsing is optional for session isolation.

## Deployment patterns

A node is one server process. A room is a group editing the same document. By default, all nodes run on one computer.

| Mode | How users are assigned | Extra requirements |
|---|---|---|
| `single` | Everyone connects to one node | None |
| `sharded` | Everyone in one room connects to the same node; rooms can use different nodes | Routing by room |
| `shared` | Users in the same room can connect to different nodes | Redis adapter and shared document storage |

Stop the current deployment before changing modes:

```sh
npm run down
npm run up -- --mode=sharded
npm run check
```

For `shared`, provide Redis. The lab tries an existing instance, a local executable, then Docker. This repository does not bundle a Redis executable. Redis forwards live changes between nodes; shared storage supplies existing data when users join or reconnect. Both are needed.

## Reproduce a broken configuration

This example shares storage but disables live forwarding. Data may look correct after rejoining even though edits are not delivered live:

```sh
npm run down
npm run up -- --variant=broken-no-adapter
npm run check
npm run down
```

The expected summary is `expected-broken`. Other variants demonstrate missing room affinity and separate storage behind a working adapter.

## Ask AI to help size hardware

Give the following input to your AI assistant and ask it to read the [hardware consultation rules and capacity ledger](docs/13-ai-hardware-sizing.md), [performance guide](docs/05-performance.md) and [production boundaries](docs/06-production.md). The [2,000-document candidate ledger](docs/12-scenario-assessment-saas-2000docs.md) is a worked example. These Chinese-language guides help form a testable candidate; they do not certify the current official engine or your real workbooks.

```text
Use this repository's documentation to assess CPU, memory, disk, network and machine counts.
Show formulas, units and remaining capacity after the specified failure.
Separate: deterministic calculations, historical/demo measurements, engineering assumptions,
candidate hardware, and items requiring validation. List missing inputs and what can be
calculated already. Zero broadcast-model cores does not mean zero CPU or memory demand.
Use mirror results only for framework experiments, not official-engine hardware sizing.
Hardware measurements must use real SpreadJS and the official collaboration pipeline.
Versions / engine / operating system / cloud region:
Online documents, sessions (including multiple tabs), users-per-room distribution:
Effective value/formula/styled-cell distribution, images/long text/import/export, JSON/compressed size:
Per-user/per-room op frequency (average/peak), cells affected per op, average/p95/max op bytes:
Does save mean incremental op or full workbook upload? Must ACK follow durable storage?
Presence/cursor update frequency, bytes and subscriber scope:
SLO: ACK/broadcast p95/p99, first open, full reconnect window, failure rate:
History: hot retention, total archive retention, snapshot frequency, tiers and object versions:
RPO (loss of acknowledged edits), single-document / whole-database RTO:
Failure scope (process/host/AZ/region), concurrent deployment during failure, growth and budget:
Existing raw measurements: hardware, connection time, steady write window/successful ops, component metrics:
```

### Four example questions

Ask AI to read this page and the guides linked above, then copy one of the questions below. Replace the example values with your actual data and mark anything unavailable as `unknown`. Ask AI to identify missing inputs and design experiments with real SpreadJS and the official collaboration pipeline before making hardware recommendations.

<details>
<summary>1. What hardware for 1,000 users, each editing every 30 seconds?</summary>

```text
We have 1,000 users editing spreadsheets online, each making an edit about every
30 seconds. We need an initial hardware recommendation. What business inputs
are missing, and what should we clarify first? How should we design an experiment
with real SpreadJS and the official collaboration pipeline to collect the
measurements needed for a hardware decision?
```

</details>

<details>
<summary>2. How should a production SaaS with 2,000 documents and two users per document be sized?</summary>

```text
Our SaaS has 2,000 documents being edited concurrently, with two users per
document, each saving every two seconds. Effective cell counts are 10k/100k/500k,
in proportions of 60%/35%/5%. We need history recovery and production availability.
How should we design experiments with real SpreadJS, the official collaboration
pipeline and our intended storage to gather evidence for CPU, memory, disk,
network and machine counts? What must we clarify about save semantics, retention,
latency and failure targets? How should we prepare the workbooks and operations,
monitor the experiment, and record results for a hardware assessment?
```

</details>

<details>
<summary>3. Can 4 cores and 8 GB handle 1,000 users editing one document?</summary>

```text
1,000 users share one document, each editing every two seconds. Is a server with
4 cores and 8 GB enough? How can we verify this with real SpreadJS and the official
collaboration pipeline? What inputs and measurements do we need? How should we
test adding nodes and compare deployment modes to find out whether they improve
this workload? Please design the experiments and explain how to judge the results.
```

</details>

<details>
<summary>4. How should we size and scale a service with many independent documents?</summary>

```text
Our application has 1,000 users, each editing their own document with about
100,000 effective cells, once every two seconds. We expect the number of active
documents to grow. How should we measure memory and other resource requirements
with real SpreadJS, the official collaboration pipeline and our intended storage?
What else do you need to know? How should we test scaling, choose expansion
thresholds, monitor the experiments, and share the results for review?
```

</details>

## Validate framework load with your scenario (mirror)

```sh
npm run up -- --mode=single
npm run bench -- --users=50 --interval=2 --duration=20 --rooms=1
npm run down
```

`--interval` and `--duration` are in seconds; duration is the target writing window. This validates mirror framework load. Hardware assessment requires separate measurements with real SpreadJS and the official collaboration pipeline. Increase framework load gradually and watch the load generator as well as the server.

## Commands and guides

| Command | Purpose |
|---|---|
| `npm run doctor` | Inspect dependencies, ports, Redis, browser and license configuration |
| `npm run status` | Show the current deployment and node health |
| `npm run web` | Start the console independently |
| `npm run check` | Check a running mirror deployment; write JSON and Markdown reports |
| `npm run bench` | Run a mirror framework load experiment; does not assess official-engine hardware |
| `npm run compare` | Start and check all three modes in sequence; needs Redis |
| `npm run down` | Stop the deployment |
| `npm run self-test` | Run engineering self-tests; Redis-dependent cases are skipped when unavailable |

`check` does not need Chrome. Browser tests use `test:ui`; official-engine tests use `test:official`.

Read the [quickstart](docs/01-quickstart.md), [mode guide](docs/02-modes.md), [decision guide](docs/03-decision-guide.md), [report guide](docs/04-architecture-check.md), [performance guide](docs/05-performance.md), [deployment notes](docs/06-production.md), [licensing guide](docs/07-license.md), [troubleshooting](docs/08-troubleshooting.md), [multi-machine runbook](docs/09-multi-machine.md), [command reference](docs/10-cli-reference.md), [AI hardware consultation template](docs/13-ai-hardware-sizing.md) or the [worked candidate capacity ledger](docs/12-scenario-assessment-saas-2000docs.md) (SaaS, 2 000 documents).

## Scope

See the [scope and disclaimer](DISCLAIMER.md#english) for the full notice. The main technical limits are:

- Mirror checks demonstrate this lab's forwarding, room isolation and storage behavior. They do not validate official OT conflict handling, complex workbook compatibility or official-engine performance.
- Shared storage is a SQLite file on one computer. PostgreSQL integration is not implemented here; cross-host `shared` agents are rejected.
- Agent orchestration has been tested with multiple processes on one computer. Real cross-host operation still needs validation.
- Historical performance figures came from a separate official 19.1.4 benchmark project. This project declares 19.2.1-series dependencies; the original benchmark artifacts are not included.
- The console and diagnostic APIs are for controlled experiments and lack complete production authentication. See [deployment notes](docs/06-production.md).

Runtime directories `.lab/`, `data/`, `logs/` and `reports/` are ignored by Git. `.lab/state.json` includes management credentials and must remain private.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [internals](docs/DEV-CONTRACT.md), [changelog](CHANGELOG.md) and [project review](docs/11-project-review.md).

The [MIT license](LICENSE) covers this repository's own code. SpreadJS and `@grapecity-software/*` packages retain their commercial licenses. No license keys are distributed with this repository.

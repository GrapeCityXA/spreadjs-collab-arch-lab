# SpreadJS collaboration architecture lab

[中文](README.md)

Run three collaboration deployment patterns on your computer, edit a document from two pages, and check whether changes reach other users. The lab also includes deliberately broken configurations to show how synchronization can fail.

The default `mirror` engine needs no commercial license key. It is a simplified demonstration engine for studying deployment behavior. The official engine is available separately with the appropriate license.

## Start here

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

`npm ci` installs from the committed lockfile. Start with `single`: it needs neither Redis nor license configuration. This repository focuses on Windows demonstrations that help users understand deployment options and test their own scenarios. Run the commands in PowerShell at the project root. Windows with Node.js 24 has been verified; macOS and Linux have not. The guides below and CLI messages are currently in Chinese.

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

## Try a small load

```sh
npm run up -- --mode=single
npm run bench -- --users=50 --interval=2 --duration=20 --rooms=1
npm run down
```

`--interval` and `--duration` are in seconds. This measures the mirror engine, so its results do not establish official SpreadJS capacity. Increase load gradually and watch the load generator as well as the server.

## Commands and guides

| Command | Purpose |
|---|---|
| `npm run doctor` | Inspect dependencies, ports, Redis, browser and license configuration |
| `npm run status` | Show the current deployment and node health |
| `npm run web` | Start the console independently |
| `npm run check` | Check a running mirror deployment; write JSON and Markdown reports |
| `npm run bench` | Apply load to a running mirror deployment |
| `npm run compare` | Start and check all three modes in sequence; needs Redis |
| `npm run down` | Stop the deployment |
| `npm run self-test` | Run acceptance tests; Redis-dependent cases are skipped when unavailable |

`check` does not need Chrome. Browser tests use `test:ui`; official-engine tests use `test:official`.

Read the [quickstart](docs/01-quickstart.md), [mode guide](docs/02-modes.md), [decision guide](docs/03-decision-guide.md), [report guide](docs/04-architecture-check.md), [performance guide](docs/05-performance.md), [deployment notes](docs/06-production.md), [licensing guide](docs/07-license.md), [troubleshooting](docs/08-troubleshooting.md), [multi-machine runbook](docs/09-multi-machine.md), [command reference](docs/10-cli-reference.md) or the [worked scenario assessment](docs/12-scenario-assessment-saas-2000docs.md) (SaaS, 2 000 documents).

## Scope

- Mirror checks demonstrate this lab's forwarding, room isolation and storage behavior. They do not validate official OT conflict handling, complex workbook compatibility or official-engine performance.
- Shared storage is a SQLite file on one computer. PostgreSQL integration is not implemented here; cross-host `shared` agents are rejected.
- Agent orchestration has been tested with multiple processes on one computer. Real cross-host operation still needs validation.
- Historical performance figures came from a separate official 19.1.4 benchmark project. This project declares 19.2.1-series dependencies; the original benchmark artifacts are not included.
- The console and diagnostic APIs are for controlled experiments and lack complete production authentication. See [deployment notes](docs/06-production.md).

Runtime directories `.lab/`, `data/`, `logs/` and `reports/` are ignored by Git. `.lab/state.json` includes management credentials and must remain private.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [internals](docs/DEV-CONTRACT.md), [changelog](CHANGELOG.md) and [project review](docs/11-project-review.md).

The [MIT license](LICENSE) covers this repository's own code. SpreadJS and `@grapecity-software/*` packages retain their commercial licenses. No license keys are distributed with this repository.

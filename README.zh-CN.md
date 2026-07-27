[English](README.md) | 简体中文

# drfx

[![npm version](https://img.shields.io/npm/v/@xenonbyte/drfx.svg)](https://www.npmjs.com/package/@xenonbyte/drfx)
[![node](https://img.shields.io/node/v/@xenonbyte/drfx.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> 把 document 和 code review-fix routes 安装进 Claude Code、Codex、Gemini 和 opencode。

[Introduction](#introduction) · [Installation](#installation) · [Routes](#routes) · [Quick Start](#quick-start) · [Invocation Syntax](#invocation-syntax) · [Modes](#modes) · [Output](#output) · [Review Rules](#review-rules) · [Custom Rules](#custom-rules) · [State and Resume](#state-and-resume) · [Write Safety](#write-safety) · [Troubleshooting](#troubleshooting)

## Introduction

`@xenonbyte/drfx` 安装七条 review routes：四条 document routes（SPEC、PLAN、DESIGN、COMMON）、两条 code routes（`review-fix-pr` 用于 pull request diff，`review-fix-code` 用于 source scope review），以及一条 requirement-plan route（`review-fix-r2p`）。所有路由均支持 read-only review 或 review-and-fix loop。

它面向可重复、可审计的 review：每次 fix 都被限制在一个声明过的 file set 内，由 git 或 file snapshot 守卫，且 route 绝不声明它无法证明的 PASS 结果。

### Features

- **七条 routes** —— 四条 document routes（SPEC、PLAN、DESIGN、COMMON）、两条 code routes（`review-fix-pr`、`review-fix-code`），以及一条 requirement-plan route（`review-fix-r2p`）。
- **两种 modes** —— `read-only` review，或带有界修复循环的 `review-and-fix`。
- **仅限显式调用** —— route 只因你输入 `$review-fix-*` 或 `/review-fix-*` 而启动，绝不会因模型从 `fix this bug` 之类的请求中推断而触发。
- **受守卫的写入** —— `guard=git` 或 `guard=snapshot` 证明 fix 始终留在 target file set 内；否则 route 阻断而不写入。
- **分层规则** —— 内置 rubric，加上可选的 user-global 与 project-local 自定义规则。
- **安全装卸** —— manifest 支撑、owned-only；uninstall 绝不删除不属于自己的文件。

### Supported platforms

| 平台 | 安装形态 | 自动修复 |
|---|---|---|
| Claude Code | command file | 支持 |
| Codex | skill directory | 支持 |
| Gemini | TOML command | 不支持 —— 仅 advisory read-only |
| opencode | command file | 支持 |

> [!WARNING]
> Gemini 在所有 route 上都是 advisory read-only：从不编辑文件、从不运行 `review-and-fix`、也从不声称通过结果。需要自动修复请用 Claude Code、Codex 或 opencode。

## Installation

需要 Node.js 20 或更新版本，以及至少一个支持的平台（Claude Code、Codex、Gemini 或 opencode）。自动修复可使用 `guard=git` 搭配 tracked、clean、由 `HEAD` 支撑的目标文件，或使用 `guard=snapshot` 搭配 valid snapshot rollback anchor。

全局安装 package：

```bash
npm install -g @xenonbyte/drfx
```

查看版本、列出命令，并探测本地 platform capability：

```bash
drfx version
drfx help
drfx doctor
```

安装 generated routes。`--platform` 可选 —— 省略即面向全部平台（Claude、Codex、Gemini、opencode）：

```bash
drfx install                                  # 全部平台
drfx install --platform claude,codex,gemini,opencode # 显式列表
drfx install --platform claude                # 单个平台
```

`--platform` 安装到：

- `claude`: command files 到 `~/.claude/commands`。
- `codex`: generated skill directories 到 `~/.codex/skills/review-fix-*`。
- `gemini`: command TOML files 到 `~/.gemini/commands`。Gemini routes 仅支持 advisory read-only。
- `opencode`: command files 到 `~/.config/opencode/commands`。

显式调用策略保存在 generated Claude 和 Codex artifacts 中。如果这些 routes 是由旧版 drfx 安装的，请重新运行以下命令升级：

```bash
drfx install --platform codex,claude
```

> [!IMPORTANT]
> 只升级 npm package 不会改写已经安装的 artifacts。在重新运行 `drfx install` 之前，此前装好的 Claude 与 Codex routes 仍保留旧 metadata，仍可能被模型自行选中。

报告每个平台已安装的内容：

```bash
drfx status
```

卸载 package-owned generated routes（`--platform` 同样可选）：

```bash
drfx uninstall                                # 全部平台
drfx uninstall --platform claude              # 单个平台
```

如果 uninstall 发现用户修改过的 generated files 或 Codex skill directory contents，它会保留这些文件，报告 `partially uninstalled: <platform> (... manifest retained)`，并保留一个缩窄后的 manifest。恢复或删除剩余文件后，可以再次运行 uninstall 移除剩余 package-owned files。

`drfx doctor` 报告本地 platform capability status。strict verified route 需要 same-flow capability proof 时，使用 `drfx doctor --platform <platform> --json`。

## Routes

安装后的 user-facing routes：

```text
review-fix-spec   SPEC documents
review-fix-plan   PLAN documents
review-fix-design DESIGN documents
review-fix-doc    COMMON documents
review-fix-pr     PR diff (base..HEAD file set)
review-fix-code   source scope file set
review-fix-r2p    r2p requirement-plan review
```

全部七条 routes 都必须在 agent input 中显式调用：

```text
Codex:                          $review-fix-*
Claude Code / Gemini / opencode: /review-fix-*
```

开头的 `$` 是 Codex skill 的字面调用前缀，不是 shell prompt。

显式调用的强制方式因平台而异：

- `claude` 和 `codex` 的 generated metadata 会关闭模型主动选择 route 的能力（command frontmatter 中的 `disable-model-invocation: true`；`agents/openai.yaml` 中的 `policy.allow_implicit_invocation: false`）。`fix this bug` 之类的普通请求，以及常规 review 或 debugging 请求，都不会启动 drfx route。
- `gemini` 和 `opencode` 安装的是由用户调用的 custom commands，没有对应开关，因此在这两个平台上显式的 `/review-fix-*` 形式是进入 route 的唯一途径。

显式调用 route 后，其参数和默认值保持不变。尤其是，调用 `review-fix-code` 时省略 `scope=` 仍表示 review 整个项目。

路由名选择 review target。Document routes：不要传 `type=`。Code routes（`review-fix-pr`、`review-fix-code`）：不要传 `target=`、`ref=`、`strict`、`normal`、`assurance=` 或 `ledger=`。

## Quick Start

在 Codex 上 review 并自动修复 SPEC 文档（开头的 `$` 是字面 skill 前缀）：

```text
$review-fix-spec docs/spec.md
```

在 Claude Code 或 opencode 上使用 slash-command 形式：

```text
/review-fix-spec docs/spec.md
```

Gemini 也使用 `/review-fix-*`，但 routes 仅支持 advisory read-only。后续示例使用 slash-command syntax；在 Codex 上，把开头的 `/` 换成 `$`。

Bare path 是 `target=<path>` 的简写。完整形式仍支持：

```text
/review-fix-spec target=docs/spec.md
```

只 review、不编辑，可选带 reference documents：

```text
/review-fix-design docs/design.md read-only
/review-fix-plan docs/plan.md ref=docs/spec.md ref=docs/design.md
```

运行 strict review-and-fix，或一个有界修复循环：

```text
/review-fix-plan docs/plan.md review-and-fix strict guard=git
/review-fix-plan docs/plan.md rounds=3
```

Review 一个 pull request diff（仅本地 git，no fetch）：

```text
/review-fix-pr base=main
/review-fix-pr base=main read-only
/review-fix-pr base=main guard=snapshot
/review-fix-pr base=main rounds=2
/review-fix-pr base=main resume
```

Review 整个 project root（省略 `scope=` 表示全项目），或限定到一个/多个目录或文件。whole-root review 在 300 个文件或 1,500,000 字节（在全部排除生效后计数）的单遍预算内一次审完；项目更大时会作为 partitioned project review 进行审查，或用 `scope=<path>` 或项目根的 `.drfxignore` 文件让它保持单遍：

```text
/review-fix-code
/review-fix-code scope=lib scope=test
/review-fix-code scope=lib read-only
/review-fix-code scope=lib guard=snapshot
/review-fix-code scope=lib resume
```

## Invocation Syntax

以下 signatures 省略 platform invocation prefix，只展示 route arguments。在 Codex 上加 `$`，在 Claude Code、Gemini 和 opencode 上加 `/`。

### Document routes (review-fix-spec / plan / design / doc)

Supported tokens:

- Bare `<path>` 是推荐 target 形式，等同于 `target=<path>`。
- `target=<path>` 是完整 target 形式。在 `review-and-fix` mode 中，这是 route 唯一可编辑的文件。
- `ref=<path>` 添加 read-only reference document。可重复传 `ref=`。
- `read-only` 只 review 和 triage，不编辑。
- `review-and-fix` 执行 review、triage、fix、diff review 和 full re-review。
- `normal` 使用默认 strictness。
- `strict` 让 low-severity findings 阻断，除非它们被显式接受为 non-blocking。
- `assurance=practical` 使用适合 Codex、Claude Code 和 opencode 常规自动修复的 live platform checks。
- `assurance=strict-verified` 要求 same-flow `drfx doctor --platform <platform> --json` proof。

> `assurance=strict-verified` 需要一份经过验证的 `drfx doctor` 能力证明。目前没有任何适配器能给出经过验证的
> 审查者隔离或写入阻断证明,因此 strict-verified 的 PASS 在所有平台(Claude、Codex、opencode)上当前都不可达;
> `assurance=practical` 才是受支持的自动修复路径。strict-verified 的端到端链路保持完好,一旦某个适配器能提供经过
> 验证的证明即可原样启用。

- `assurance=advisory` 仅允许 read-only advisory review。
- `resume` 从 target-local state 继续。
- `reset` 归档现有 target state（移到 `.drfx/archived/`，绝不删除）并全新开始 review。`resume` 与 `reset` 互斥。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `debug` 打印 redacted workflow audit details。默认输出保持 concise。
- `root=<path>` 设置用于 containment 和 state layout 的 project root。
- `ledger=<path>` 选择 target state directory 内的 custom issue ledger path。
- `guard=git|snapshot` 选择 rollback 和 target-only guard family。`guard=git` 是默认值；Git rollback anchor 不可用时，`guard=snapshot` 使用 file snapshots。路由永远不会静默切换 guard mode。

### review-fix-pr

Syntax:

```text
review-fix-pr base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<path>] [debug]
```

- `base=<branch>` 为必填。diff 为 `base..HEAD`，使用本地 git 解析，no fetch、push 或 ref mutation。
- `read-only` 或 `review-and-fix`（Claude Code、Codex 和 opencode 默认 `review-and-fix`；Gemini 上为 advisory read-only）。
- `guard=git` 为默认值；Git rollback anchor 不可用时使用 `guard=snapshot`。路由永远不会静默切换 guard mode。
- `resume` 显式从已保存的 state 继续。拒绝 stale state，不存在静默复用。
- `reset` 归档现有 target state（移到 `.drfx/archived/`，绝不删除）并全新开始 review。当 stale state 已无法 resume 时（例如排除策略变化改变了 file set），这是显式的逃生口。`resume` 与 `reset` 互斥。
- 自动修复只改 resolved file set。如果 accepted issue 需要修改该集合之外的文件，保持该文件不变，并把该 issue 报告为 `Not fixed`，不要扩大 scope。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `root=<path>` 设置 project root。
- 不接受 `target=`、`ref=`、`strict`、`normal`、`assurance=` 或 `ledger=`。

### review-fix-code

Syntax:

```text
review-fix-code [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<path>] [debug]
```

- `scope=<path>` 指定要遍历的目录或要直接纳入的单个文件。可重复（repeatable）传入多个 `scope=`。省略 scope 表示整个 project root，在 300 个文件或 1,500,000 字节（在全部排除生效后计数）的单遍预算内一次审完；超出该预算的 whole-root file set 不再阻断，而是作为 partitioned project review ——一种确定性的、多阶段、逐单元（unit）的审查，其 project PASS 只能通过 aggregate coverage gate 赢得（绝不一次性声明整项目 PASS）——进行审查；用更窄的 `scope=<path>` 或忽略规则可让它保持单遍。显式传入非根目录/文件 `scope=` 的运行无论大小都按单遍审查；规范化到 project root 的 scope（例如 `scope=.`）仍按 whole-root 处理。
- 内置排除（固定、始终生效）：VCS 状态（`.git`、`.hg`、`.svn`）；本工具状态（`.drfx`、legacy `.docs-review-fix`）；本地 agent/tool 状态（`.claude`、`.codex`、`.codegraph`、`.gemini`、`.opencode`、`.config/opencode`、`.req-to-plan`）；依赖树与包缓存（`node_modules`、`bower_components`、`vendor`、`.pnp`、`.yarn`、`.pnpm-store`、`.gradle`、`.m2`）；构建产物（`dist`、`build`、`out`、`target`、`.next`、`.nuxt`、`.svelte-kit`、`.output`）；覆盖率与工具缓存（`coverage`、`.nyc_output`、`.cache`、`.parcel-cache`、`.turbo`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`.tox`）；临时与编辑器目录（`tmp`、`temp`、`.tmp`、`.idea`、`.vscode`）；以及 OS 杂项文件 `.DS_Store` 与 `Thumbs.db`。
- 版本忽略的文件自动排除：通过一次本地只读 git 查询（`git ls-files --others --ignored --exclude-standard`）捕获完整的 gitignore 体系——嵌套 `.gitignore`、全局 excludes 文件、`.git/info/exclude`——并沿用 git 自身语义，因此 **tracked 文件永远不会被版本忽略**。非 git 根目录下该来源自然缺位，仅内置排除与 `.drfxignore` 生效。两个忽略来源相互独立：`.drfxignore` 的 `!` 否定无法复活被版本忽略的路径——需要时请用显式 `scope=`。
- 项目根的 `.drfxignore` 文件提供用户级排除，**语法与 `.gitignore` 一致**：`#` 注释、空行、`!` 否定（后匹配规则胜出）、前导 `/` 锚定、尾随 `/` 仅匹配目录，以及 `*` / `?` / `[...]` / `**` glob。仅读取根目录这一个文件（不支持嵌套 ignore 文件），且必须是常规文件（符号链接形式的 `.drfxignore` 会被拒绝）。pattern 行（包含顺序——否定是后匹配胜出）参与 review-target 身份：修改 `.drfxignore` 即产生不同的 review target，旧状态无法跨该变更 resume——请全新开始（或 `reset`）。Raw pattern text 不会写入 workflow state；身份由有序 digest 承载，用户可见输出使用 redacted pattern text。
- 显式 `scope=` 永远优先：被 scope 指定的目录或文件即使被忽略来源覆盖也会纳入审查（覆盖会被报告，绝不静默）。scope 目录内部独立命中的忽略规则仍然生效。
- `read-only` 或 `review-and-fix`（Claude Code、Codex 和 opencode 默认 `review-and-fix`；Gemini 上为 advisory read-only）。
- `guard=git` 为默认值；Git rollback anchor 不可用时使用 `guard=snapshot`。路由永远不会静默切换 guard mode。
- `resume` 显式从已保存的 state 继续。拒绝 stale state，不存在静默复用。
- `reset` 归档现有 target state（移到 `.drfx/archived/`，绝不删除）并全新开始 review。当 stale state 已无法 resume 时（例如排除策略变化改变了 file set），这是显式的逃生口。`resume` 与 `reset` 互斥。
- 自动修复只改 resolved file set。如果 accepted issue 需要修改该集合之外的文件，保持该文件不变，并把该 issue 报告为 `Not fixed`，不要扩大 scope。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `root=<path>` 设置 project root。
- 不接受 `target=`、`ref=`、`base=`、`strict`、`normal`、`assurance=` 或 `ledger=`。

### review-fix-r2p

Syntax:

```text
review-fix-r2p workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<path>] [debug]
```

`review-fix-r2p` 审查由 `workId=<WF-...>` 指定的活跃 r2p（requirement-to-PLAN）run，该 run 位于 `<project>/.req-to-plan/WF-*` 下。它用 PLAN rubric 以 upstream docs（`03`–`06`）为依据评判 requirement plan（`07-plan.md`），但从不编辑制品：`03`–`07` 和 `run.md` 都是只读、带指纹的证据。被接受的 high/medium blocking findings 映射到所属的 upstream stage，且只能通过官方 r2p lifecycle 命令——`r2p-reopen` 或 `r2p-gap-open`——修复，绝不写文档。修复后 route 进入 checkpoint，提示你运行 `r2p-continue` 让 r2p 重新生成制品，只有 clean rerun 才能获得 workflow PASS。

- `workId=<WF-...>` 为必填；也接受单个 bare `WF-...` token 作为简写。它指向 `<project>/.req-to-plan/WF-*` 下的一个活跃 run 目录。没有 `target=`、`ref=` 或 path 形式——传 path 会以 `invalid-r2p-invocation` 被拒绝。
- `03`–`07` 和 `run.md` 是只读、带指纹的证据。drfx 从不写入、删除、重命名、还原或修补它们，并且 review set 或 `run.md` 在 run 期间发生变化会被检测到。
- 修复只走 r2p lifecycle。`record-r2p-repair-plan` 记录修复计划；`apply-r2p-repair` 调用 `r2p-reopen` 或 `r2p-gap-open`，若 review/triage state 在记录计划后发生漂移则以 `r2p-drift-detected` 拒绝，若该 run 已存在 open route 则以 `r2p-existing-route-open` 拒绝。修复后的必需下一步是 `r2p-continue`，它不是 drfx 调用的修复步骤。
- 没有面向用户的 `guard=` token；只读 drift detection 是内部的、始终开启。
- `read-only` 或 `review-and-fix`（Claude Code、Codex 和 opencode 默认 `review-and-fix`；Gemini 上为 advisory read-only）。
- 在 Gemini 上为 advisory-only：`review-and-fix` 不支持，`rounds=<n>` 不接受，workflow PASS 不可用，自动修复永远不会运行。
- `resume` 显式从已保存的 state 继续。拒绝 stale state，不存在静默复用。
- `reset` 归档现有 target state（移到 `.drfx/archived/`，绝不删除）并全新开始 review。`resume` 与 `reset` 互斥。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `root=<path>` 设置 project root。
- 不接受 `target=`、`ref=`、`base=`、`strict`、`normal`、`assurance=`、`scope=`、`ledger=` 或 `guard=`。

Parsing 是 strict 的：

- 唯一的 target 形式是 `workId=<WF-...>` 或单个 bare `WF-...` token；path-based input 会被拒绝。
- 不能同时给出 bare `WF-...` 和显式 `workId=`，且 `workId=` 不能重复；多个 unlabeled work ID 是有歧义的。
- Duplicate `root=` 会被拒绝。
- Unknown `key=value` tokens 和 unknown dash options 会被拒绝。

对 valid target invocations，Codex、Claude Code 和 opencode routes 会把缺失的 mode 默认为 `review-and-fix`，把缺失的 assurance 默认为 `practical`。对 Codex、Claude Code 和 opencode 上的 document/PR/CODE routes，显式 `assurance=advisory` 且未传 mode 时选择 `read-only`；`review-fix-r2p` 不接受 user-facing `assurance=`。Gemini routes 默认缺失 mode 为 `read-only`，缺失 assurance 为 `advisory`。

Help-style 或 invalid invocations 只解释用法，不得读取文件、运行 `drfx workflow`、创建 state、运行 probes，或声明 review results。

## Modes

`read-only`:

- 读取 target 和 references。
- 运行 semantic review 和 triage。
- 不编辑文件。
- 报告 `Clean:` 或 `Issues:`。

`review-and-fix`:

- 读取 target 和 references。
- 运行 review、triage、fix、diff review 和 full re-review。
- Document routes 只编辑 target document。
- PR/CODE routes 只编辑 resolved file set 内的文件。
- 有修改时报告 `Fixed:`。
- accepted issues 仍存在时报告 `Unfixed:`。

Gemini 支持 advisory read-only review。Gemini 不支持 `review-and-fix` 或 `assurance=strict-verified`。

Code routes（`review-fix-pr`、`review-fix-code`）在 Gemini 上为 advisory-only：`review-and-fix` 不支持，`rounds=<n>` 不接受，workflow PASS 不可用，自动修复永远不会运行。如需 code route 自动修复，请使用 Claude Code、Codex 或 opencode。

`read-only` 路径在任何平台上都不声明 PASS，也不创建 auto-fix state。

## Output

默认输出设计为简短，并且方便另一个 AI agent 使用。

Generated routes 会在自动续跑时调用带 `--json=compact` 的 `drfx workflow`。Compact JSON 是 generated-route default：它保留 status、`nextAction`、state/report/context artifact paths 和其他 continuation fields，同时省略 `contextPackSkeleton`、raw prompts、transcripts、logs、target bodies 等 debug-only bodies。面向 operator 和 debug CLI 使用时，`drfx workflow ... --json` 与 `drfx workflow ... --json=full` 输出 full JSON shape。需要更小且可安全续跑的 shape 时，可直接使用 `drfx workflow ... --json=compact`。

Full JSON 和 debug output 是诊断入口。`--json=full` 会暴露 redacted artifact paths，例如 target state directories、manifests、ledgers、reports、guard reports、locks 和 context artifacts，便于在磁盘上检查这些文件。`debug` 会打印 redacted workflow audit details、blocker codes、runtime probe status 和相关 artifact paths。两者都不应包含 raw target bodies、raw prompts、subagent transcripts、secrets 或 unredacted sensitive logs。

Clean read-only review:

```text
Clean: docs/spec.md has no blocking issues.
```

Read-only review with findings:

```text
Issues:
- Location: docs/spec.md:42
  Problem: The acceptance criteria do not define the empty-state behavior.
  Why it matters: Implementers can ship incompatible behavior.
  Suggested fix: Add explicit empty-state acceptance criteria.
Next: Apply fixes manually or rerun on Codex/Claude Code/opencode in review-and-fix mode.
```

Successful review-and-fix:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Files changed:
- docs/spec.md
```

Review-and-fix with remaining issues:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Unfixed:
- Location: docs/spec.md:88
  Problem: The rollout owner is still unspecified.
  Next: Add the accountable owner or defer with reason, owner, and next action.
Files changed:
- docs/spec.md
```

目标缺少 rollback anchor 时的 blocked run:

```text
Blocked: docs/spec.md cannot be auto-fixed because it lacks a clean rollback anchor.
Next: Commit or restore the target, rerun with read-only, or use guard=snapshot when Git rollback is unavailable.
```

其他 guard blockers 使用不同 wording：`target-only-guard-unavailable` 表示 target-only guard 不可用或无法解析；`unexpected-worktree-change` 表示 non-target worktree changes 让自动修复不安全。

`debug` 可能包含 redacted state paths、blocker codes、runtime probe status 和 workflow audit details。它不得打印 raw target bodies、raw prompts、subagent transcripts、secrets 或 unredacted sensitive logs。

## Review Rules

### Document routes

所有 document routes 先应用 COMMON rubric。Specialized routes 会额外添加一个 type-specific rubric：

- `review-fix-spec`: COMMON plus SPEC。
- `review-fix-plan`: COMMON plus PLAN。
- `review-fix-design`: COMMON plus DESIGN。
- `review-fix-doc`: COMMON only。

Built-in rubrics:

- COMMON: purpose、coherence、actionability、assumptions、constraints、risks、project alignment、terminology、placeholders 和 external facts。
- SPEC: requirements、product behavior、API behavior、scope、actors、permissions、integrations、acceptance criteria、edge cases 和 verifiability。
- PLAN: implementation steps、prerequisites、tooling、verification、rollback、failure handling、data safety、compatibility 和 handoff readiness。
- DESIGN: UX、UI、product workflows、system or architecture design、states、transitions、contracts、data flow、accessibility、responsiveness、localization、constraints 和 risks。

### Code routes

Code routes（`review-fix-pr`、`review-fix-code`）使用自包含的 rubric，没有 COMMON layer：

- `review-fix-pr`：correctness、regression、safety、tests、contracts、maintainability 和 platform。
- `review-fix-code`：correctness、architecture、state-and-io、safety、tests、contracts、maintainability 和 platform。

Code review 只对 actionable 问题报告：纯 style 偏好、无风险 refactor 和 over-abstraction 意见不属于 blocking findings。

### Reference Conformance

`ref=` documents 是 consistency sources，不是 mandatory upstream chains。

- SPEC 不要求 DESIGN reference。
- PLAN 不要求 SPEC reference。
- `Design Coverage Import` 是 optional，除非 SPEC 声称完整覆盖 reference、custom rules 要求它，或缺失会导致 SPEC 不可验证。
- `SPEC-to-task mapping` 是 optional，除非 PLAN 声称完整覆盖 reference、custom rules 要求它，或缺失会让 PLAN 不安全或不可验证。
- 缺少 trace tables、stable IDs 或 coverage tables 默认不是 blocking。

Blocking reference findings 包括 conflicts、被描述为 reference-backed 的 unsupported new requirements、target 既定目的所需但遗漏的 reference constraints，或会违反 reference 的 execution steps。

Reviewer findings 包含足够 triage 的细节：severity、location、problem、why it matters、suggested fix、confidence，以及相关 sensitive-content metadata。

## Custom Rules

Supported V3 custom rule files:

```text
~/.drfx/rules/COMMON.md
~/.drfx/rules/SPEC.md
~/.drfx/rules/PLAN.md
~/.drfx/rules/DESIGN.md
~/.drfx/rules/PR.md
~/.drfx/rules/CODE.md
.drfx/rules/COMMON.md
.drfx/rules/SPEC.md
.drfx/rules/PLAN.md
.drfx/rules/DESIGN.md
.drfx/rules/PR.md
.drfx/rules/CODE.md
```

每个 custom rule file 都是 plain Markdown fragment。不需要包一层 heading。

对 typed review，loader 只读取 user-global 和 project-local rules 中的 `COMMON.md` 加当前 document type 文件。`SPEC` review 不读取 `PLAN.md` 或 `DESIGN.md`；`PLAN` review 不读取 `SPEC.md` 或 `DESIGN.md`；`DESIGN` review 不读取 `SPEC.md` 或 `PLAN.md`；COMMON document review 只读取 `COMMON.md`。

Code routes（`review-fix-pr`、`review-fix-code`）没有 COMMON layer。`PR` review 只读取 `PR.md`；`CODE` review 只读取 `CODE.md`。Code routes 的 user-global 和 project-local rule files 遵循与 document routes 相同的两层布局。

Legacy `RULE.md` 是 stale configuration。如果存在 `~/.drfx/RULE.md` 或 `.drfx/RULE.md`，workflow start 会在写入 target state 前以 `state-validation-failed` 阻断。

Unknown Markdown files under `rules/`，例如 `Spec.md`、`SPEC-RULE.md` 或 `REQUIREMENTS.md`，会在 normal mode 下输出 warning 并继续。在 strict mode 下，它们会在 target state 写入前阻断。

Rule precedence（document routes）：

1. workflow hard constraints
2. built-in COMMON rubric
3. built-in document-type rubric
4. user-global COMMON rules
5. user-global document-type rules
6. project-local COMMON rules
7. project-local document-type rules

Rule precedence（code routes — 无 COMMON layer）：

1. workflow hard constraints
2. built-in code-route rubric（PR 或 CODE）
3. user-global PR.md 或 CODE.md rules
4. project-local PR.md 或 CODE.md rules

对于 code routes（`review-fix-pr`、`review-fix-code`），`rules/` 下的未知 Markdown 文件只产生警告、不阻塞：这两个 route 不暴露 `strict|normal` token，始终使用 normal 策略。symlink 或非常规 `.md` 条目仍会被拒绝。

Project-local rules 比 user-global rules 更具体。Custom rules 不能覆盖 workflow hard constraints。

## State and Resume

Persistent state 是 target-local：

```text
.drfx/targets/<target-key>/
```

Target key 由相对 project root 的 normalized target path 派生：一个 readable slug 加 12-character SHA-256 prefix。它基于 path，不基于 content。

Project-local layout:

```text
.drfx/
  rules/
    COMMON.md
    SPEC.md
    PLAN.md
    DESIGN.md
  index.md
  targets/
  archived/
```

`rules/` 是 shared project configuration。`index.md` 存在时是 project-level index material。`targets/<target-key>/` 是 single-target workflow state。`archived/` 由 `reset` 和成功的 `pass` / `read-only-clean` finalization 创建。`reset` 把旧的 target state 移到这里（绝不删除）；terminal finalization 会归档已完成 state，让下一次运行无需 `reset` 即可 fresh start。如果 terminal archiving 失败，finalization 会报告 `archiveWarning` 和明确的 delete/reset/retry next action，并把 state directory 留在原处。

Default target state layout:

```text
.drfx/targets/<target-key>/
  MANIFEST.md
  ISSUES.md
  CONTINUITY.md
  SUMMARY.md
  LOCK/
    lease.json
  stale-locks/
  rounds/
```

`MANIFEST.md` 记录 target path、document type、strictness、mode、target key、ledger path、status、current round、file fingerprints、references 和 timestamps。

默认 ledger 是 `.drfx/targets/<target-key>/ISSUES.md`。Custom `ledger=` path 必须留在 target directory 内，并且不能指向 reserved paths，例如 `LOCK/`、`stale-locks/`、`rounds/`、`MANIFEST.md`、`CONTINUITY.md` 或 `SUMMARY.md`。

`resume` 使用 target-local files，不使用 chat history。Resume 没有 runtime objective/session/platform memory dependency。Resume 会派生 target key，读取 `MANIFEST.md`，读取 ledger，在存在时加载 `CONTINUITY.md`，重建当前 merged rules，检查 fingerprints，并且只在 state 仍有效时继续。

## Write Safety

> [!NOTE]
> `guard=git` 是默认。每一次自动写入都必须被证明停留在 target file set 内（在当前 guard 下），否则 run 会阻断而非写入——通过结果是挣来的，绝不假定。

Reference documents 是 read-only。Document-route fixes 必须只修改 target document。PR/CODE fixes 必须只修改 resolved file set 内的文件。

Automatic target writes 要求：

- `review-and-fix` mode；
- 使用 `guard=git` 时，需要 Git worktree `HEAD` 加 tracked clean target；或使用 `guard=snapshot` 时，需要 valid snapshot rollback anchor；
- target-only guard 能证明 writes 在所选 guard mode 下保持 target-only；
- 没有 unsafe non-target changes 会让所选 guard mode 的 guard results 变得 ambiguous。

Fix 之前，route 会锁定 target state directory，并重新检查 target fingerprint。Concurrent edits、external changes、stale unsafe locks 或 possible target replacement 都会在写入被信任前停止 workflow。

> [!CAUTION]
> Sensitive values 绝不可打印或存入 ledgers、receipts、manifests、summaries、prompts 或 final responses。使用 `[REDACTED:<kind>]`，例如 `[REDACTED:api-token]`、`[REDACTED:private-key]`、`[REDACTED:cookie]` 或 `[REDACTED:credential]`。

对 sensitive findings，保存 location anchors 和 secret kind，不保存 raw values、partial prefixes、suffixes、hashes、checksums、raw logs 或 transcript excerpts。

## Troubleshooting

`Blocked: target or worktree is not write-eligible.`

Commit 或 restore target document，然后解决 unsafe non-target worktree changes。等 `git status --short` 显示 target clean，且剩余 worktree state 对 target-only guard 安全后再重跑。

Guard blocker wording:

- `rollback-unavailable`: target 缺少 clean rollback anchor。Commit 或 restore target，重跑 read-only，或在 Git rollback 不可用时使用 `guard=snapshot`。
- `target-only-guard-unavailable`: target-only guard 不可用或无法解析。恢复 guard inputs，或在 guard data 可读取后重跑。
- `unexpected-worktree-change`: non-target worktree changes 让自动修复不安全。Commit、stash 或 restore unrelated changes 后重试。

`Blocked: fix-report-mismatch.`

提交的 fix report 不符合所需 schema。当 document workflow 在 fix phase 以 blocking reason `fix-report-mismatch` 阻断时，`begin-fix` 可以执行 safe retry：它复用原先通过的 guard baseline，验证 references 和 target-only guard results，重新校验 rollback snapshot body 仍存在且与 begin-fix target 指纹一致，重新获取 lock，并返回 `nextAction: retry end-fix with a valid fix report`。这个 safe retry 只是 report-resubmission path；它不会递增 `fixAttemptCount` 或 `currentRound`，不会把 issues 标记为 fixed，并且修正后的 `end-fix` 仍然进入 diff-review，而不是 PASS。

如果 safe retry 被拒绝，请改用 recovery：解决报告的 blocker 后重试，使用 `reset` 归档 state 并重新开始，或在 target/state 需要人工修复时执行 manual recovery。`reset` 和 manual recovery 是更宽泛的 recovery tools；当现有 state 仍符合条件时，它们不是 safe retry 的替代品。

`Blocked: state-validation-failed.`

移除 stale `RULE.md` files。`.drfx/rules/` 和 `~/.drfx/rules/` 下的 unknown Markdown files 在 normal mode 下 warning，但会阻断 strict runs。

`Unsupported: review-and-fix or strict-verified is unavailable on Gemini.`

使用 Gemini 进行 advisory read-only review，或使用 Codex/Claude Code/opencode 自动修复。对于 code routes（`review-fix-pr`、`review-fix-code`），Gemini 在所有平台上均为 advisory-only：`review-and-fix` 不支持，workflow PASS 不可用，不会编辑任何文件。如需 code route 自动修复，请使用 Claude Code、Codex 或 opencode。

`Unfixed:` appears after review-and-fix.

Route 已安全修复可修复项，并正在报告仍然存在的 accepted issues。Deferrals 包含 reason、owner 和 next action。

`resume` refuses to continue.

Target state 不再匹配当前 file fingerprints、target path、references、rules 或 lock state。解决报告的 blocker 后，开始 fresh run。

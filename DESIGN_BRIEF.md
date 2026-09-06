# Grasp — Implementation Design Brief

**Read this entire document before writing any code.** It is the complete
specification for a v1 build.

Where this document says **MUST** or **NEVER**, treat it as a hard constraint.
Several encode deliberate product decisions that look like bugs or missing
features if you don't know the reasoning — the reasoning is stated inline so you
don't "fix" them. §21 lists rejected ideas explicitly.

**If something is genuinely underspecified:** choose the simpler option, keep it
consistent with §2, and leave a `// DECISION:` comment naming what you chose and
why. Do not invent new subsystems, new config surface, or new commands to
resolve an ambiguity.

---

## 1. What Grasp is

Grasp is a local-first CLI tool that watches the code you write with AI and makes
you actually understand it. When a meaningful change lands in a tracked project,
Grasp generates a comprehension question about it — and, if the concept is new to
you, teaches the concept first. You answer on your own time via `grasp review`.

### The problem

"Comprehension debt": developers increasingly ship AI-generated code they can't
explain, debug, or extend. Grasp's thesis is that the human's role in AI-assisted
development is direction and judgment, which requires understanding what the AI
built — not the ability to have written it faster than the AI could, but the
ability to explain it, spot where it goes wrong, and rebuild it if needed.

### Success criterion

A user who has answered Grasp's questions on a feature should be able to explain
how it works end to end, and plausibly rebuild it. Recognition ("I've seen this
before") is NOT the bar. Reconstruction is.

### Audience

Individual developers, as a personal-discipline tool. Not a team or compliance
product. Free, open-source, local-only, no backend, no telemetry. Model access is
the user's own: their existing Claude Code subscription by default, or their own
API key (§6.3). Grasp never resells, proxies, or holds credentials.

---

## 2. Non-negotiable design principles

When something is ambiguous, resolve it in favor of these.

1. **Grasp NEVER grades answers.** It never evaluates whether a user's answer is
   correct. It shows a sample answer to compare against, then asks the user to
   self-assess. Progression is driven entirely by self-report. A user can lie to
   themselves; that's their business. Do not add correctness detection, scoring,
   similarity matching, or LLM-based answer evaluation.

2. **Teaching is co-equal with testing.** Users often don't know the concept the
   AI just used. Quizzing someone on something they were never taught is useless.
   Teaching cards are a first-class feature, not a hint system.

3. **Universal capture.** Grasp watches the filesystem, not any specific AI tool.
   It MUST work identically whether code came from Claude Code, Codex, Cursor,
   Copilot, a desktop app, or a human typing. Do not add tool-specific hooks.

4. **Nothing runs on a schedule.** No cron, no timed review reminders, no decay
   jobs. Everything that "expires" (mastery decay, struggled synthesis
   checkpoints, stale questions) is recomputed lazily at the moment it's next
   needed, triggered by real activity. Simpler, and far less annoying.

5. **Never a dead end.** Every question can be skipped. Every stuck user gets
   escalating help. Grasp nudges; it does not coerce. (The one exception, `hard`
   gate mode, is opt-in and bypassable — §13.)

6. **Cheap before expensive.** Free local checks (path patterns, file hashes,
   syntax checks, diff size) run before any LLM call. Never spend two model calls
   where one will do.

7. **Local and inspectable.** Plain SQLite, plain JSON config. No telemetry ever.
   The only outbound network calls are the user's own model calls, made either
   through their installed Claude Code CLI or their own API key (§6.3).

8. **Never lose the user's work, never spend their budget by surprise.** Capture
   failures degrade to "try again later," never to silent data loss. Model spend
   is bounded by explicit caps (§8) — dollars on the API path, subscription rate
   limit on the Claude Code path.

---

## 3. Tech stack & repo hygiene

- **Runtime:** Node.js >= 22.13.0, TypeScript 5.5+, ESM (`"type": "module"`).
  The floor is set by `node:sqlite`, which is flag-free from v22.13.0.
- **CLI:** `commander`
- **Watching:** `chokidar` v4
- **Database:** `node:sqlite` (`DatabaseSync`; synchronous, single-user, no
  pooling, **no native module to compile**). A native addon that builds on the
  user's machine is the single most common `npm install -g` failure, so Grasp
  ships with zero compiled dependencies. Restrict usage to `DatabaseSync`,
  `StatementSync`, and `exec` — `node:sqlite` is still Stability 1.2 (release
  candidate, since v25.7.0), so avoid its session, backup, and extension APIs.
  There is no `better-sqlite3`-style `db.transaction()` helper: write explicit
  `BEGIN` / `COMMIT` / `ROLLBACK` (§5.4).
- **Git:** `simple-git`
- **Notifications:** `node-notifier` (OS-native only; NO tray icon, NO GUI)
- **LLM transport:** two interchangeable providers behind one interface (§6.3,
  §9.1) — the user's installed **Claude Code CLI** (`claude -p`, subscription
  auth, no API credits) and **`@anthropic-ai/sdk`** (API key). `@anthropic-ai/sdk`
  is the only runtime dependency of the API path; the CLI path has none.
- **Glob matching:** `picomatch` (used for all `ignorePatterns` evaluation — one
  matcher everywhere, so behavior is identical across watcher, filter, and scan)
- **Terminal UI:** `chalk` + `prompts` is sufficient. A TUI framework (ink) is
  acceptable but not required. Requirements: color, raw keypress handling,
  multi-line input.
- **Testing:** `vitest`, `@vitest/coverage-v8`
- **Lint/format:** ESLint (typescript-eslint, strict) + Prettier. `npm run lint`
  and `npm run format:check` MUST pass clean.
- **CI:** GitHub Actions matrix — `{ubuntu-latest, macos-latest, windows-latest}`
  × `{node 22, node 24, node 26}` running `lint`, `build`, `test`. Three Node
  majors because `node:sqlite` is not yet Stable and can change across them.

Eventual distribution target: `npm install -g grasp`. Until the package is
published, install from source as documented in `README.md`.

**Every module MUST be importable without side effects.** No top-level DB
connections, no top-level `process.exit`, no work at import time. This is a hard
requirement for testability — the test suite imports modules directly.

---

## 4. Architecture & data flow

### 4.1 The live-capture loop

```
file writes (from any source: AI tool, editor, human)
  → chokidar events, per registered project
  → path ignore filter (picomatch)                    [free]
  → debounce timer resets on each event               [free]
  → BATCH CLOSES when timer expires
  → syntax validity check on each changed file        [free, if parser available]
      ↳ if any file fails to parse: extend wait, re-check (max 3x)
  → diff each file vs. Grasp's snapshot checkpoint    [free]
  → meaningful-diff filter, per file                  [free]
  → authorship heuristic → confidence signal          [free]
  → rate-limit check                                  [free]
      ↳ if over cap: DO NOT advance checkpoint, roll into next batch
  → ONE generation call for the whole batch           [LLM]
      ↳ returns skip, or 1–3 questions across the batch
  → persist questions (status='pending'), advance checkpoint
  → synthesis eligibility check                       [free]
  → ONE batched OS notification
  ...later, user runs `grasp review` from any terminal...
  → teaching card (if applicable) → question → [stuck flow] → sample answer
  → self-assessment → mastery update → synthesis eligibility re-check
```

### 4.2 Batching is per-debounce-window, not per-file

A single AI turn typically writes several files. Those files are almost always
one logical change, so Grasp sends **the whole batch in one generation call** and
lets the model decide how many distinct concepts are actually present (1–3
questions max, §7.4).

This matters for three reasons: it's one API call instead of N; the model can see
cross-file relationships a per-file call would miss; and it prevents flooding the
user with five near-identical questions about one change.

The term **"turn"** throughout this document means *one closed debounce batch*.
It does not mean an AI conversation turn — Grasp has no visibility into that.

### 4.3 Two entry paths, one pipeline

Live capture (§6) and `grasp scan` (§12) differ only in what triggers generation
and what content is sent. Everything downstream — tiering, teaching cards, the
stuck flow, self-assessment, mastery, synthesis — is identical and MUST be shared
code, not duplicated.

### 4.4 Module layout

```
src/
  cli/
    index.ts                  commander wiring; the ONLY file that may process.exit
    commands/                 one file per command; each exports a pure-ish run()
  daemon/
    daemon.ts                 service install/start/stop, PID file, project fan-out
    watcher.ts                per-project watcher + pipeline orchestration
    debounce.ts               quiet-period timers
    parsers/index.ts          extension → syntax-check lookup + probe cache
    logger.ts                 rotating file logger (§16)
  capture/
    snapshot.ts               checkpoint store + diffing
    diffFilter.ts             meaningful-diff filter
    authorHeuristics.ts       burst-write + focus soft signal
    rateLimit.ts              hourly cap + rollup backpressure
  generation/
    provider.ts               askModel() — Claude Code CLI + API SDK behind one interface
    generateQuestion.ts       prompt assembly, retry, structured-output parsing/validation
    prompts/systemPrompt.ts   THE prompt — highest-leverage file in the repo
    prompts/synthesisPrompt.ts
  storage/
    db.ts                     connection, WAL, migrations
    schema.sql                canonical schema
    models/                   one file per table (incl. generationFailures.ts)
  mastery/
    tierLogic.ts              self-assessment → tier transitions
    decay.ts                  lazy read-time decay
  synthesis/
    trigger.ts                eligibility + re-surfacing
  scan/
    scanRunner.ts             static walk, sectioning, resumability
  gate/
    gateModes.ts              soft/warn/hard resolution
    gitHook.ts                pre-commit install/remove/chain + staged check
  review/
    reviewSession.ts          interactive answering flow
    stuckFlow.ts              hint → retry → explain → scaffold
    queue.ts                  ordering, staleness, scoping
  notifications/notify.ts
  config/                     defaults, load/merge/save, dot-notation set
  export/                     anki + raw
  util/paths.ts               path normalization (§16.4)
  types/index.ts
```

---

## 5. Process model, IPC, and state

This section is load-bearing. Get it wrong and nothing else works.

### 5.1 One daemon, many projects

A single background daemon process watches **all** registered projects. There is
never more than one daemon per machine.

### 5.2 Liveness: PID file

- `~/.grasp/daemon.pid` contains the daemon's PID, written on start, removed on
  graceful shutdown.
- Liveness check: read PID, call `process.kill(pid, 0)` — throws if dead.
- If the PID file exists but the process is dead (crash, hard reboot), treat as
  not-running and clean up the stale file. **Never** assume a stale PID file means
  a running daemon.
- On start, if a live daemon already exists, exit cleanly with a message. Never
  run two.

### 5.3 CLI → daemon communication: there isn't any

**Do not build a socket, named pipe, or signal-based IPC layer.** Cross-platform
IPC is the single biggest source of avoidable bugs in a tool like this.

Instead: the daemon **polls the `projects` table every 5 seconds** and reconciles
its set of active watchers against it. So:

- `grasp init` inserts a row and exits. Within 5s the daemon starts watching it.
- Un-registering works the same way in reverse.
- `grasp status` reads the PID file and the DB directly. It never talks to the
  daemon.

This costs a trivial local SQLite read every 5s and eliminates an entire class of
platform-specific failure.

### 5.4 Database concurrency

The daemon writes while `grasp review` writes. Therefore:

- Enable **WAL mode** (`PRAGMA journal_mode = WAL`) on every connection.
- Set `PRAGMA busy_timeout = 5000` on every connection.
- Set `PRAGMA foreign_keys = ON`.
- Wrap multi-statement writes in transactions.
- Never hold a transaction open across an `await` on network I/O. Generate first,
  then write.

### 5.5 Snapshot storage (concrete — do not improvise)

Grasp maintains its own content checkpoint, **completely independent of git**. It
must work in a repo with no commits, no remote, and a dirty working tree.

- Location: `~/.grasp/snapshots/<sha256(projectPath).slice(0,16)>/`
- Inside, mirror the project's relative file paths, storing the last-captured
  content of each tracked file.
- Diffing: read current file, read snapshot file, produce a **unified diff**
  (implement with a small dependency such as `diff`, or hand-roll — but the
  output format sent to the model MUST be a standard unified diff with ~3 lines
  of context, because that's what models are best at reading).
- The checkpoint advances **only after** questions are successfully persisted.
  See §8.3 for why this matters.
- On `grasp init`, populate the snapshot with the current state of all tracked
  files, so the first captured diff is real rather than "entire codebase added."

### 5.6 Daemon lifecycle

- Installed as an auto-start-on-login service (§6.2).
- On unexpected crash, the OS service manager restarts it. On restart it
  reconciles watchers from the `projects` table — no in-memory state needs to
  survive.
- In-flight debounce batches are lost on crash. That's acceptable: the snapshot
  checkpoint hasn't advanced, so the same changes are re-detected on the next
  file write, or on the next `grasp scan`. **No data loss, only delay.**

---

## 6. Setup & lifecycle

### 6.1 `grasp init` — the only command a user ever needs

Run inside a git repo. In order:

1. **Verify** the cwd is inside a git repo (walk up for `.git`). If not, error
   with a clear message and exit non-zero.
2. **Ensure the daemon exists.** If not installed (first-ever run on this
   machine): run provider resolution (§6.3), install the service (§6.2), start it.
   Report what was installed; do not prompt.
3. **Register the project** — insert into `projects` with the repo root's
   absolute path. If already registered, report and exit 0 (no duplicate, no
   error).
4. **Populate the snapshot** (§5.5) for all tracked, non-ignored source files.
5. **Offer a scan.** If the repo has substantial existing code — heuristic:
   `> 10` non-ignored source files **OR** `> 500` total non-ignored source LOC —
   prompt: `This repo has existing code. Scan it for onboarding before live
   tracking starts? [y/N]`. On yes, run `grasp scan` inline. On no, continue.
6. **Exit immediately.**

**`grasp init` MUST NOT stay resident.** The user closes the terminal; the daemon
keeps watching. This is the single most important property of the setup flow —
the previous version of Grasp required a permanently-open second terminal, and
that was its largest adoption blocker.

### 6.2 Service installation

| OS | Mechanism | Location |
|---|---|---|
| macOS | `launchd` LaunchAgent plist, `RunAtLoad` + `KeepAlive` | `~/Library/LaunchAgents/com.grasp.daemon.plist` |
| Linux | systemd **user** service, `Restart=on-failure` | `~/.config/systemd/user/grasp.service` |
| Windows | Task Scheduler task, logon trigger | task name `GraspDaemon` |

Guard all three behind a platform check with a clear error on anything else.
If service installation fails (e.g. no systemd), fall back to a detached child
process, warn the user it won't survive reboot, and continue — never hard-fail
`init` over service installation.

### 6.3 Provider resolution

Grasp's users are overwhelmingly Claude Code subscribers, not API-console
customers. Requiring a separately-funded API key would be an adoption barrier for
a free tool, so the **default path spends no API credits at all**: Grasp shells
out to the user's own Claude Code CLI, which already holds their subscription
auth.

Two providers sit behind one interface (`askModel(prompt, opts) → text`,
`generation/provider.ts`). Nothing outside that module knows which one ran.

| Provider | Transport | Auth | Setup for the user |
|---|---|---|---|
| `claude-cli` | `claude -p` subprocess | their Claude Code login | none |
| `api` | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` or `config.apiKey` | an API key |

`config.provider` is `"auto" | "claude-cli" | "api"`, default `"auto"`.
Resolution under `auto`, first hit wins:

1. **Claude Code CLI**, if the binary resolves *and* `claude auth status --json`
   reports `loggedIn: true`. This probe costs no model tokens. Probe once and
   cache for the process lifetime, as with the §7.4 parser probes.
2. **API key**, from `config.apiKey` or `ANTHROPIC_API_KEY`.
3. Otherwise a clear error naming **both** routes — "install Claude Code and run
   `claude auth login`, or set `ANTHROPIC_API_KEY`" — never just the key.

A pinned `claude-cli` or `api` that is unavailable is an error, not a silent
fallback: the user asked for that transport.

#### 6.3.1 The CLI path must be hermetic

`claude -p` is a full Claude Code session. Four things MUST be true, or
generation quality degrades in ways no test will catch:

- **Context isolation.** `claude -p` discovers `CLAUDE.md`, user memory, and
  project settings from its working directory. This is verified, not theoretical:
  run inside a repo containing a `CLAUDE.md` and the model answers from that
  project's instructions. Grasp's prompt MUST be the only instruction the model
  sees. Run from a neutral cwd (the OS temp dir), pass `--safe-mode` (disables
  `CLAUDE.md`, skills, plugins, hooks, MCP, custom agents and settings while
  leaving auth intact), `--strict-mcp-config` with no `--mcp-config`, and
  `--system-prompt`, which **replaces** the default system prompt rather than
  appending to it. Do NOT use `--bare`: it forces `ANTHROPIC_API_KEY`-only auth
  and defeats the entire point of this path.
- **No tools.** The diff is in the prompt; the model must not read the
  filesystem. `--tools ""` disables the whole built-in set.
- **Parseable output.** `--output-format json` returns an envelope
  (`{ is_error, subtype, result, usage }`). Strip that framing in the provider so
  the parser in §9.4 sees exactly the string the SDK path would have produced.
- **`execFile`, never `exec` (§7.4)**, with an explicit timeout. Prompts contain
  quotes, backticks, and newlines; pass the prompt on **stdin**, not as an argv
  element, so a large diff cannot hit the platform argument-length limit.

The child process inherits the environment unchanged. Scrubbing
`ANTHROPIC_API_KEY` to force subscription billing would break users whose Claude
Code runs against Bedrock, Vertex, or a corporate gateway; the CLI resolves its
own credentials exactly as it does interactively.

`max_tokens` has no CLI equivalent and is honored only on the API path.

#### 6.3.2 API key handling (the `api` path only)

In order, first hit wins:

1. `ANTHROPIC_API_KEY` environment variable.
2. Existing Claude Code credentials on the machine, if readable.
3. Interactive prompt (masked input). Store in `~/.grasp/config.json`.

Set `~/.grasp/config.json` to mode `0600` on write (best-effort on Windows).
**Never log the key, never include it in error messages, never write it to a
per-repo `.grasp.json`** (§18.2). Redact `sk-ant-…` from any string that reaches
a log, an error, or the DB.

Do NOT build OAuth. Do NOT build a hosted key proxy — that reintroduces a backend
and makes Grasp responsible for other people's credentials.

### 6.4 `grasp enable` / `grasp disable`

Explicit global pause/resume. NOT part of setup. `disable` stops the service and
leaves all data, registrations, and hooks intact. `enable` restarts it. These
exist so a user can silence Grasp everywhere without unregistering anything.

### 6.5 Uninstall

`grasp reset config|history` handles data. Full removal is: `grasp disable`
(removes the service), then `npm uninstall -g grasp`. Document this in the README.
Also provide `grasp uninstall-hooks` to remove Grasp's pre-commit hooks from all
registered repos and restore any chained originals (§13.2) — otherwise removing
the package leaves dead hooks behind that break commits.

---

## 7. Capture layer

### 7.1 Watcher

One `chokidar` watcher per registered project, all inside the single daemon.
Watch the project root recursively.

- `ignoreInitial: true` — startup MUST NOT fire events for existing files.
- `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }` — cheap
  first-line protection against reading a file mid-write, complementary to the
  syntax check.
- Ignore at watcher level: `.git/**`, `node_modules/**`, `~/.grasp/**`, plus all
  `config.ignorePatterns`.
- Watch only files whose extensions are plausible source (maintain a
  `SOURCE_EXTENSIONS` set). Everything else never enters the pipeline.

### 7.2 Debounce

Per-project timer, reset by any event in that project. When it expires without
new events, the batch closes. Default `debounceMs: 4000`.

Rationale: a filesystem watcher cannot know when an AI is "done" — it can only
notice writes stopping. Debounce is the primary signal; the syntax check is the
corrective one.

**Cap batch size:** if a batch exceeds `maxFilesPerBatch` (default 25) or
`maxDiffLines` (default 800), close it immediately rather than waiting for quiet.
Prevents a mass refactor or dependency install from producing one enormous call.

### 7.3 Syntax validity check

After the batch closes, verify each changed file parses.

- **Parses** → strong signal the write completed → proceed.
- **Fails** → likely mid-write (AI paused to think, editor autosaved a partial
  function). Extend by `debounceMs` and re-check. After **3 consecutive failures**,
  proceed anyway — the code may simply be broken, and Grasp is not a linter. Log
  at debug level; do not surface to the user.
- **No parser for that extension** → skip the check, proceed on debounce alone.
  Unsupported languages MUST degrade gracefully, never block capture.

If some files in a batch parse and others don't, apply the wait to the batch as a
whole (the batch is one logical change).

### 7.4 Parser lookup (`daemon/parsers/index.ts`)

Extension → `{ probe, check }`, plus in-process cases.

- **JS/TS/JSX/TSX:** parse in-process with a bundled parser. No shell-out, always
  available.
- **Everything else:** shell out to that language's own toolchain.

**Probe once, cache for the daemon's lifetime.** First time an extension is seen,
run its `probe` (e.g. `python3 --version`). Cache the boolean. Never re-probe per
file. Probe failure → mark unsupported → debounce-only fallback.

All shell-outs MUST: use `execFile` (never `exec` with string interpolation —
file paths contain spaces and shell metacharacters), pass the path as an argv
element, apply a **5s timeout**, and treat timeout as "unsupported" rather than
"invalid."

Ship with at least:

| ext | probe | check |
|---|---|---|
| `.js .jsx .ts .tsx .mjs .cjs` | — | in-process parse |
| `.py` | `python3 --version` | `python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" <file>` |
| `.go` | `gofmt --help` | `gofmt -e <file>` |
| `.rs` | `rustc --version` | `rustc --edition 2021 --emit=metadata -o <tmp> <file>` |
| `.rb` | `ruby --version` | `ruby -c <file>` |
| `.php` | `php --version` | `php -l <file>` |
| `.java` | `javac -version` | `javac -proc:only -d <tmp> <file>` |
| `.cs` | `dotnet --version` | best-effort; mark unsupported if unreliable |

Only JS/TS and Python must be **verified working** for v1. The rest ride on
probe-and-fallback: an untested entry degrades safely rather than breaking.

### 7.5 Meaningful-diff filter

Applied **per file**, before the batch goes to generation. Reject:

- Net added/modified lines below `diffSizeThreshold.minLines` (default 3).
- Whitespace/formatting-only changes (compare whitespace-normalized content).
- Files matching `ignorePatterns`.
- Import/export reordering with no other change.

If every file in a batch is rejected, the batch is dropped with no API call, and
the checkpoint advances (nothing worth asking about).

**Important:** line count is a poor proxy for importance — a 3-line function can
matter enormously. This filter exists to suppress *noise*, not to judge
*importance*. Keep the threshold low and let the generation call make the real
call (§9.2 step 1). When in doubt, pass it through.

### 7.6 Authorship heuristic (soft signal only)

Estimate AI-written vs. hand-typed from free local signals:

- **Burst-write:** large content in one or few near-instant events → AI-like.
  Incremental writes with pauses → human-like.
- **Window/process focus** at write time, where the OS makes this cheaply
  available. If it isn't, skip this signal — do not shell out repeatedly or add a
  native dependency for it.

Output a `confidence` value on the batch. **This MUST NEVER hard-suppress a
question.** Use it only to lower priority ordering in the review queue.

Rationale: the failure modes are asymmetric. A false positive (quizzing a human
on their own code) is a mild annoyance. A false negative (silently skipping real
AI-authored code) defeats the entire purpose of the tool. The heuristic must be
asymmetric too.

---

## 8. Cost control

Grasp spends something of the user's on every generation, and unbounded spend is
the fastest way to get uninstalled. **What** it spends depends on the provider
(§6.3), but the caps are identical either way and are enforced in one place:

- **`api`** — dollars, billed to the user's own key.
- **`claude-cli`** — no dollars, but every call draws down the user's Claude Code
  subscription rate limit. That budget is shared with the interactive Claude Code
  session they are actively working in, which makes an uncapped Grasp *worse*
  than an expensive one: it would throttle the tool they are using to write the
  code. The hourly cap is not optional on this path.

So the caps below apply unchanged regardless of provider. Do not special-case
either transport, and do not raise the cap because "the CLI path is free."

The one behavior that does differ: the §8.2 escape valve trades an over-cap call
for bounded rollup growth. That remains correct on both paths.

### 8.1 Hourly cap

`config.maxQuestionsPerHour`, default **12**. Counted from `questions.created_at`
over a rolling 60 minutes, across all projects.

### 8.2 Backpressure via rollup (not dropping)

When a batch would exceed the cap, **do not generate and do not advance the
snapshot checkpoint.** The un-captured changes remain in the diff and roll into
the next batch, naturally coalescing into one larger, more synthesis-worthy diff
once capacity returns.

This is better than dropping (which silently loses coverage) and better than
queueing (which just defers a flood).

**Escape valve:** if a rolled-up diff exceeds `maxDiffLines` (800), generate
anyway regardless of the hourly cap, then advance. This guarantees the rollup can
never grow without bound and no code is permanently skipped.

### 8.3 Checkpoint advance rule (one rule, applied everywhere)

> Advance the snapshot checkpoint **if and only if** the batch reached a terminal
> state: questions persisted, or explicitly filtered as not-worth-asking (§7.5 /
> §9.2 step 1).

Never advance on: API failure, rate-limit deferral, malformed model output, or
daemon crash. This single rule is what makes "no silent loss" true.

### 8.4 Scan cost

`grasp scan` is capped separately by `scanQuestionsCap` (default 15) per run.
`--full` bypasses it and MUST print an explicit cost warning plus a confirmation
prompt before proceeding.

---

## 9. Generation

### 9.1 One call per batch

Every question — live, scan, or synthesis — comes from a single model call.
**Never make a separate "is this worth asking about?" pre-check call**; fold that
judgment into the same call (§9.2 step 1).

Model: `config.model`, default `claude-sonnet-4-6`. `max_tokens: 4096`
(API path only — the CLI has no equivalent flag). Temperature: leave at default.

The call goes through `askModel(prompt, opts)` (§6.3). `generateQuestion.ts` MUST
NOT import the Anthropic SDK, spawn a subprocess, or branch on which provider is
active: prompt assembly, retry policy, parsing, and validation are identical on
both transports, and a provider-specific code path anywhere above `provider.ts`
means one of the two gets less testing than the other.

Because both providers take a single prompt string, anything that would be a
multi-turn exchange — notably the §9.6 repair retry — MUST be expressible as one
flat prompt.

### 9.2 What the system prompt must instruct (live & scan)

The model receives: the unified diff(s) or code section, file paths, the user's
current **effective** mastery tier for relevant concepts, and a list of the user's
existing concept tags (§9.3). It must:

1. **Judge worth.** Decide whether the batch contains anything worth testing —
   real logic, a meaningful design decision, non-obvious behavior. Boilerplate,
   config, trivial getters/setters, pure plumbing, dependency bumps → return
   `skip` with a one-line reason. This replaces path-pattern guessing in scan
   mode, and it's why §7.5 can afford to be permissive.
2. **Identify concepts.** Produce stable, lowercase, hyphenated tags
   (`debouncing`, `auth-flow`, `optimistic-updates`). Tags are both the mastery
   unit and the synthesis clustering key, so consistency is critical — the prompt
   MUST instruct the model to prefer an existing tag from the supplied list over
   minting a near-duplicate (`auth-flow` not `authentication-flow`).
3. **Check for a naming gap.** If mastery for a tag is `none`, consider whether
   the user likely already knows this concept under another name (memoization vs.
   caching, guard clause vs. early return). If so, set `reframe: true` and write
   the teaching card as "this is the same idea as X, applied here" rather than
   teaching from zero. Prevents condescending from-scratch explanations.
4. **Select tier** from the supplied effective mastery:
   - `none` → `trace`
   - `trace` → `predict_break`
   - `predict_break` | `reconstruct` → `reconstruct`
5. **Teaching card, only if mastery is `none`.** Rules in §10.2.
6. **Write the question** for that tier (§10.1).
7. **Sample answer.** Never shown before the user attempts. A comparison
   reference, not a grading key.
8. **Hint** — points at the reasoning without giving the answer.
9. **Scaffold:** 2–4 sub-questions decomposing the main question into smaller
   steps (§10.4). **Required for `trace` and for `reconstruct`**; optional for
   `predict_break`.

   Required at `reconstruct` because the scaffold is the deepest rung of the
   stuck flow, and `reconstruct` is where a user is most likely to be stuck with
   nothing to fall back on — the code is hidden. Observed across every early
   reconstruct run: the model omits the scaffold unless told otherwise, leaving
   `[b]` with nothing to show at the hardest tier.

   **A reconstruct scaffold decomposes the PROBLEM, never the implementation.**
   Sub-questions belong in the design space ("what shape of recursion produces a
   right-leaning tree?"), not in the code's structure ("what does the power rule
   call?"). The latter is a trace-tier scaffold: useless with the code hidden,
   and leaking by construction. The leak check (§9.6) enforces identifiers; the
   prompt must enforce the framing.
10. **Attribute files.** Each question lists which files in the batch it's about
    — this is what `question_files` stores, and what the hard gate scopes on
    (§13.3). A question generated from a 5-file batch must not be tied to all 5
    if it only concerns 2.

**Reconstruct-tier constraint (critical):** the question text MUST describe the
problem from scratch without revealing the implementation. If the question leaks
the approach, the tier is worthless. State this explicitly in the prompt.

The constraint binds the **hint and scaffold too**, not just the question. All
three are shown while `code_snippet` is withheld (§14.4), so a hint naming an
internal identifier both leaks the design and points at something the user cannot
see.

**This is enforced in the validator, not left to the prompt** (§9.6). Prompt
wording alone did not hold it: on a third-party parser, a clean question shipped
with a hint naming `parse_expr` and a scaffold naming `parse_power` and
`BinOpNode`. Keep the prompt instruction anyway — the validator is the guarantee,
the prompt is what keeps repair retries rare.

Note the interaction with §10.1's "optionally a signature": a reconstruct question
may sketch inputs and outputs, but it may NOT quote the implementation's own
declared names, because the validator cannot tell an entry point from an internal
helper. Describe the shape; do not name it.

### 9.3 Known-tags context

Pass the user's existing tags to every generation call, so tagging stays stable
over time. Selection: up to **60 tags**, ordered by most-recently-demonstrated,
as a plain comma-separated list. This bounds prompt size while keeping the
relevant ones present.

### 9.4 Structured output contract

The prompt MUST demand one JSON object and nothing else — no prose, no comments,
no trailing commas. It MUST NOT forbid markdown fences: models emit a ```json
fence on roughly half of calls regardless, the parser strips it at zero cost, and
no repair retry has ever been caused by one. A rule the model ignores and the
parser absorbs is prompt budget spent on nothing. Validate against this shape and
reject anything malformed (§9.6).

```jsonc
{
  "skip": false,                     // true = nothing worth asking; other fields omitted
  "skip_reason": null,               // one line, only when skip=true
  "questions": [                     // 1–3 items when skip=false; NEVER more than 3
    {
      "concept_tag": "debouncing",   // lowercase, hyphenated, stable
      "reframe": false,              // true = user likely knows this under another name
      "tier": "trace",               // trace | predict_break | reconstruct
      "files": ["src/hooks/useDebouncedSearch.ts"],  // subset of batch files
      "teaching_card": {             // null unless effective mastery === "none"
        "body": "...",               // ≤5 sentences, concept-first, one concrete example
        "deeper": null               // optional extra depth, shown ONLY on request
      },
      "question": "...",
      "sample_answer": "...",
      "hint": "...",
      "scaffold": ["...", "...", "..."]   // 2–4; required for trace tier
    }
  ]
}
```

### 9.5 Synthesis generation variant

Separate prompt (`synthesisPrompt.ts`). Input: the bundle of prior diffs under one
tag, not a single batch. Output: **exactly one** integration question.

```jsonc
{ "question": "...", "sample_answer": "...", "hint": "..." }
```

No teaching card, no tier, no concept tagging — a synthesis checkpoint tests
whether the user can connect pieces they've already individually demonstrated
understanding of.

### 9.6 Failure and malformed-output handling

- **Malformed JSON or schema violation:** retry the call **once** with an
  appended instruction to return valid JSON only. If it fails again, record a
  `generation_failures` row and stop. Do not advance the checkpoint (§8.3).
- **Invalid enum values** (unknown tier, >3 questions, missing required field):
  treat as schema violation. Do not attempt to coerce or guess.
- **Fields the model does not own** are a different case from a schema violation
  and MUST be corrected rather than rejected:
  - **`tier` is a locally-enforced CEILING, not a value the model owns.** The
    mastery map (§9.2 step 4) is computed locally; a returned tier above it is
    clamped down.
    Clamping down is safe — a harder question still works with the code visible —
    and it prevents the real harm: a `reconstruct` on a concept at mastery `none`
    hides the code (§10.1) from someone who has never met the idea, the same
    capstone-on-unfamiliar-material failure §11.6's mastery condition prevents
    elsewhere.
    **Never clamp up.** Observed in a real run: asked for `reconstruct`, the model
    returned a `predict_break` question that named the identifiers it asked about.
    Promoting that label would hide the code those names refer to, leaving a
    question about something the user cannot see. A tier below the ceiling is a
    missed opportunity, not a harm — keep the model's tier, warn, and let the
    prompt be the fix.
  - **Hallucinated file paths are dropped.** Keep only paths present in the batch,
    stored in the batch's own spelling (§16.4). `question_files` is what scopes
    the hard gate (§13.3), so a path the model invented would block an unrelated
    commit. If *no* valid path survives, that IS a schema violation.
  - A teaching card at non-zero mastery stays a warning: extra content, not wrong
    content.
  - **A reconstruct question that names hidden code is a violation.** Extract the
    declared function, method, and class names from the snippet the model was
    shown, and assert that `question`, `hint`, and every `scaffold` entry contain
    none of them. `sample_answer` is exempt: it is shown only after the code is
    revealed. Match whole identifiers, case-sensitively, and only ones that LOOK
    like code — snake_case, camelCase, or PascalCase. Matching every local would
    false-positive on `value` or `result`, and **length is not a usable signal**:
    an earlier cut also matched any 8+ character name, which flagged a clean
    question for the English verb "evaluate" in "should evaluate as", because the
    file declared `def evaluate`. That cost a repair retry and a tier downgrade on
    a question that leaked nothing. A lone all-lowercase word is prose. On failure: one repair retry, then **downgrade
    the tier to `predict_break` rather than discard the question**. At that tier
    the code is visible, so the identifiers are legitimate and the question
    becomes valid instead of wasted. This reuses the tier-ceiling path.
- **Provider errors** are classified by `provider.ts` and reported identically by
  both transports, so nothing above it branches on HTTP status or exit code:
  - *Retryable* (HTTP 429/5xx, transport failure, a non-zero `claude` exit): retry
    up to 3 times with exponential backoff (1s, 4s, 10s) plus jitter.
  - *Not retryable* (HTTP 401/403, `claude` not installed, `claude` not logged in):
    record the failure with a message naming the fix — "check your API key", or
    "run `claude auth login`" — and stop.
  - *CLI timeout*: record and stop rather than retry in-loop. Three more attempts
    at the CLI timeout would stall a capture batch for minutes; the checkpoint has
    not advanced, so `grasp retry` picks it up later at no cost.
- **All failures are silent to the user in the moment.** The daemon never
  interrupts to report a model or provider problem — including a missing or
  logged-out CLI. `grasp status` surfaces the failure count; `grasp retry`
  re-attempts them on demand.

### 9.7 Prompt development

`generation/prompts/systemPrompt.ts` is the highest-leverage file in the project.
Question quality **is** the product; everything else is plumbing.

Build it to be iterable in isolation: provide `scripts/dev-generate.ts` that takes
a file path or diff and prints raw model output plus parsed result, without
touching the daemon or DB. Expect this prompt to be rewritten many times against
real output. Structure it as a composed template (role framing, tier definitions,
teaching-card rules, output contract) rather than one opaque string, so
individual rules can be edited without rewriting the whole thing.

---

## 10. The question system

### 10.1 The three tiers

Tier is chosen per-concept from the user's current **effective** mastery, NOT from
per-diff difficulty. The same diff yields different questions for different users.

**Tier 1 — `trace`.** Follow the logic as written; code visible while answering.
The floor: establishes the user actually read the change.
> *"If `query` changes three times within 300ms, how many times does
> `setDebounced` actually get called, and why?"*

**Tier 2 — `predict_break`.** Reason about behavior the code doesn't spell out —
edge cases, failure modes, what breaks if something is removed. Not answerable by
pattern-matching visible code.
> *"What happens if `delay` is 0? Is this hook still doing anything meaningful?"*

**Tier 3 — `reconstruct`.** **Code hidden.** Only the problem statement (and
optionally a signature). The user describes their approach, then compares.
> *"You need a hook that returns a 'settled' version of a fast-changing value,
> only updating after it's stopped changing for a set delay. Before looking,
> describe how you'd implement it — what state do you need, and what triggers an
> update?"*

Tier 3 tests the §1 success criterion directly. The review UI MUST genuinely
withhold `code_snippet` for reconstruct questions until after the user answers or
skips.

### 10.2 Teaching cards

Shown **before** the question when effective mastery for the tag is `none`.

- **Concept-first, code-second.** Explain the idea abstractly, then one line
  connecting it to their code. A card that narrates the diff line-by-line is not
  a teaching card — it's the question in disguise.
- **≤5 sentences by default.** Express this in the prompt as a working rule ("if
  you can't explain it in ~4 sentences, you're explaining too much"), not just a
  word budget.
- **One concrete example, always.** "Debouncing delays an action until input
  stops" + "so a search box doesn't fire a request on every keystroke."
- **No jargon stacking.** If explaining A requires B, either explain the more
  foundational one or name the dependency explicitly. Never silently cascade.
- **Complex concepts layer, they don't sprawl.** If a concept genuinely can't fit
  the cap, the card holds the core idea and `deeper` holds the rest — surfaced
  only on request. The cap governs what's shown *by default*, not what exists.
- **Visually distinct.** Different color/border/prefix from question text, so it
  reads as context rather than as part of the test.

**Availability above mastery 0:** skipped by default once mastery > `none`, but
MUST stay reachable — `[e]` on every question. Default is skip; the door is never
locked.

### 10.3 Self-assessment — the only progression mechanism

After the user answers (or skips), show the sample answer, then:

```
How did that compare?   [1] Nailed it   [2] Mostly there   [3] Way off
```

**All transitions operate on the EFFECTIVE tier (post-decay), and the result is
written to the stored tier.** So a user whose `reconstruct` decayed to an
effective `predict_break`, who then self-reports `nailed_it`, returns to stored
`reconstruct` — decay is undone by demonstration, not compounded.

| Self-report | Stored tier becomes | `last_demonstrated_at` | Also |
|---|---|---|---|
| `nailed_it` | `effective + 1`, capped at `reconstruct` | now | — |
| `mostly_there` | `effective` (unchanged) | now | — |
| `way_off` | `effective − 1`; below `trace` → `none`, re-arming the teaching card | now | **auto-show the concept explanation**, overriding the mastery-based skip default |

All three reset the decay clock — engagement counts even when it goes badly.

An explicit skip (declining to answer at all) sets `status='skipped'` and changes
**nothing**: no tier change, no clock reset.

### 10.4 The stuck flow

Escalates in this order; the user can bail to skip at any point.

1. **Hint** (`Esc`) — reveals the pre-generated hint. Points at the reasoning, not
   the answer.
2. **One retry** — user attempts again with the hint in hand.
3. **Auto-explanation** — if still stuck, surface the teaching card automatically
   regardless of mastery level. A stuck user at mastery 2 is direct evidence the
   skip-by-default assumption is wrong for them right now.
4. **Break it down** (`[b]`) — the scaffold sub-questions, walking the same logic
   in smaller steps. Each is ungraded and untracked; this is pure scaffolding, not
   extra assessment. Only after this does the sample answer appear.

Record the furthest escalation reached in `questions.assistance_level`
(`none | hint | retry | scaffolded`). This is **signal, not score** — a "nailed
it" that required full scaffolding is a materially different data point from a
cold one. It MUST NOT modify tier transitions.

---

## 11. Mastery, decay, and synthesis

### 11.1 Mastery is global

One row per concept tag in `concepts`, **global across all projects** —
understanding `debouncing` transfers between repos. Stores current `tier` and
`last_demonstrated_at`.

### 11.2 Decay is computed, never stored

No decay job. `getEffectiveTier(tag)` computes at read time:

```
elapsedDays = now − last_demonstrated_at
window      = config.decayWindows[storedTier]
effective   = elapsedDays > window ? oneTierDown(storedTier) : storedTier
```

Decay drops **exactly one tier**, never resets to zero. Someone who earned
`reconstruct` six months ago gets a `predict_break` spot-check, not a
from-scratch teaching card.

Defaults (days): `trace: 90`, `predictBreak: 60`, `reconstruct: 45`. Higher tiers
decay faster because the skill is more perishable — being able to rebuild
something fades faster than being able to trace it with the code in front of you.
These are starting guesses, not research. They MUST be config-tunable.

Setting a window to `null` disables decay for that tier.

### 11.3 Decay never notifies

A decayed concept surfaces naturally the next time the user touches it in real
work. No "time to review!" notifications, no separate review scheduler. A nagging
spaced-repetition queue is a different, more annoying product.

### 11.4 Synthesis checkpoints — purpose

Per-diff questions test pieces in isolation. Replicating a *feature* requires
holding several pieces together. A synthesis checkpoint asks the user to connect
everything under one concept tag end to end.

### 11.5 Clustering comes from the model, not from timing

Diffs group by the `concept_tag` returned by the generation call — free, since
that call already read the code. **Do not infer grouping from timing proximity or
file adjacency.** Semantic tagging is both more accurate and cheaper than a
heuristic grouping layer.

### 11.6 Eligibility requires BOTH conditions

1. **Count:** questions under this tag ≥ `synthesisTrigger.minDiffCount`
   (default 3). Derive with
   `SELECT COUNT(*) FROM questions WHERE concept_tag = ? AND type != 'synthesis'`.
   **Do not maintain a stored counter** — it drifts out of sync on partial writes.
2. **Mastery:** the concept's effective tier ≥ `synthesisTrigger.minMasteryTier`
   (default `predict_break`).

Condition 2 is essential. A synthesis checkpoint is a capstone; firing it on a
concept the user just met turns the hardest question in the system into a pop quiz
on unfamiliar material.

Eligibility is evaluated after each answered question (cheap, local).

### 11.7 Scored separately, always

Synthesis outcome lives in `synthesis_clusters.status`
(`not_yet_attempted | struggled | passed`) and **MUST NEVER read or write concept
mastery tiers.** Concept mastery answers "do you understand this piece"; synthesis
answers "can you connect the pieces." Conflating them blurs what each measures.

The user still self-assesses with the same three options. Mapping: `nailed_it` →
`passed`; `mostly_there` or `way_off` → `struggled`.

### 11.8 Re-surfacing

- **`struggled`** → eligible again the next time a *new* question is created under
  that tag. No timer, no reminder — the same lazy pattern as decay. If no new work
  ever lands there, it sits pending, reachable via `grasp review --all`, and never
  nags.
- **`passed`** → stays closed until the cluster grows by another `minDiffCount`
  questions beyond the count at `last_checkpoint_at`, then a fresh checkpoint is
  generated against the now-larger system.

---

## 12. `grasp scan` — onboarding mode

### 12.1 What differs

Only the trigger and the input. No diff, no moment of creation — just existing
code. Everything downstream is the shared pipeline.

### 12.2 Behavior

- Walks tracked, non-ignored source files in the current project.
- `ignorePatterns` is the cheap first pass. Everything surviving it goes to the
  generation call, which makes the real "worth a question?" judgment (§9.2 step
  1). **Do not apply the line-count `diffSizeThreshold` here** — coverage is the
  goal in scan mode, and small files may matter.
- Files > **400 lines** split into sections. **Split at top-level declaration
  boundaries** when the file parses (function/class/export boundaries), falling
  back to a hard line split with **20 lines of overlap** for context. Never split
  mid-function when it's avoidable — a section that starts halfway through a
  function produces a bad question.
- **Resumable.** Progress per file/section in `scan_progress`. Interrupt and
  re-run picks up where it left off.
- **Hash-diffed re-scans.** Unchanged `file_hash` → generates nothing. A genuinely
  edited file re-triggers.
- **Respects global mastery.** Someone with `reconstruct` mastery of
  `auth-middleware` from another project isn't taught it again — they get a
  tier-appropriate question about *this codebase's* instance. This is where the
  §9.2-step-3 reframe check matters most: onboarding is exactly the case where a
  user knows a concept but doesn't recognize it here.
- **Capped** at `scanQuestionsCap` (default 15). `--full` bypasses with a cost
  warning + confirmation (§8.4).
- **Queue ordering:** if a synthesis checkpoint became eligible for an
  already-covered cluster, prioritize it over starting a fresh unrelated file — a
  capped run should end on a synthesis payoff rather than stranded mid-file.
- **Progress output.** Scan is long-running and interactive-blocking; print a live
  counter (`[7/15] src/auth/middleware.ts`) so it never looks hung.

### 12.3 Self-suggestion

Offered automatically at `grasp init` in repos with substantial existing code
(§6.1 step 5). Otherwise invoked manually.

---

## 13. Gate modes

Resolved per project: `projects.gate_mode` if set, else `config.gateMode`.

| Mode | Behavior |
|---|---|
| `soft` *(default)* | Notifications only. Never blocks anything. |
| `warn` | On commit, print pending-question list; commit proceeds (exit 0). |
| `hard` | On commit, print list and block (exit 1) until addressed. |

### 13.1 Mechanism

`warn` and `hard` install a local `pre-commit` hook in that repo. Switching to
`soft` removes it.

The git-commit trigger was explicitly **rejected as a capture mechanism** — it
delays quizzing past the point where it aids retention, and assumes a commit
cadence Grasp can't rely on. It is used *only* here, as an enforcement lever.

### 13.2 Hook installation & chaining

- Write to `.git/hooks/pre-commit`, mode `0755`.
- Include a marker line (`# grasp-managed-hook v1`) so Grasp can recognize its own
  hook and never clobber a foreign one.
- **If a foreign hook exists:** rename it to `pre-commit.pre-grasp`, and have
  Grasp's hook `exec` it **first**, propagating a non-zero exit immediately
  (foreign hook wins; Grasp only runs if it passed).
- **On removal:** delete Grasp's hook and restore `pre-commit.pre-grasp` if
  present. `grasp uninstall-hooks` does this across all registered repos (§6.5).
- The hook body should invoke `grasp __precommit` (a hidden command), not inline
  logic — so hook behavior updates with the package instead of going stale.

### 13.3 Scoping — staged files only

Check pending questions against `git diff --staged --name-only`, matched via
`question_files`. **Only questions tied to files in this commit count.** A stale
question about an unrelated file from three weeks ago MUST NOT block an unrelated
commit. Expired questions (§14.3) are excluded entirely.

Path matching MUST normalize both sides per §16.4 — git emits POSIX-style paths
relative to the repo root on all platforms, including Windows.

### 13.4 The blocked-commit message

A vague hook failure is how CLI tools lose trust. Name exactly what's blocking and
state the bypass plainly:

```
Grasp: commit blocked (hard gate)

2 unanswered comprehension questions on files in this commit:
  • src/auth/middleware.js — "what happens if the token has expired..."
  • src/auth/refresh.js — synthesis checkpoint: auth-flow

Run `grasp review` to answer them, then commit again.
To skip Grasp for this commit: git commit --no-verify
```

Requirements: name files and truncated question text (60 chars + ellipsis);
distinguish synthesis checkpoints from regular questions; exactly one next action;
state `--no-verify` neutrally, without shame framing.

`--no-verify` bypass is git's own behavior and is the user's prerogative. **Do not
attempt to detect, log, count, or defeat it.**

---

## 14. `grasp review` — the answering UI

### 14.1 Scoping

- **Directory-aware by default:** run inside a registered project → that project's
  queue only. `--all` → cross-project. Run outside any registered project →
  behave as `--all`.
- Works from **any** terminal, at any time. It reads the persisted queue; it has
  no connection to the daemon and requires nothing to be running.

### 14.2 Queue ordering

1. Non-expired, non-synthesis questions, **newest first**.
2. Eligible synthesis checkpoints last within a session.

Newest-first because retrieval practice works best close to exposure — a question
about code from three weeks ago has lost most of its learning value, and the user
has moved on. Synthesis last because it's a capstone; answering it before the
pieces feels arbitrary.

Within the same timestamp bucket, lower authorship `confidence` (§7.6) sorts
later — likely-human-written changes are the least valuable to quiz on.

### 14.3 Staleness

Questions older than `config.questionStaleDays` (default **14**, `null` disables)
are treated as `expired`: hidden from the default queue, excluded from the git
gate, still visible under `grasp review --all` and `grasp history`.

Computed lazily at read time, consistent with principle 4 — do not run a job to
mark them.

Rationale: an unbounded, guilt-inducing backlog is how habit tools die. Grasp
should let old debt go rather than accumulate an unpayable pile.

### 14.4 Flow, per question

Teaching card (if applicable) → question → user input → [stuck escalations on
demand] → sample answer → self-assessment.

**Reconstruct questions MUST hide `code_snippet`** until after the attempt.

Keybinds — **defaults**, all of them user-configurable (§18.1):

| Key | Action |
|---|---|
| `Ctrl+T` | Hint ("tip") |
| `Ctrl+E` | Explain concept (available at any mastery) |
| `Ctrl+R` | Deeper explanation ("read more"; only when `teaching_card_deeper` exists) |
| `Ctrl+K` | Break it down (scaffold) |
| `Ctrl+N` | Skip this question ("next") |
| `Ctrl+C` | Quit the session (remaining stay pending) |
| `Enter` | Submit the answer |
| `Alt`+`Enter` | Newline inside the answer |
| `1` `2` `3` | Self-assessment, at that prompt (§10.3) |

**RAW KEYPRESS MODE, not line mode.** Every command fires on the keypress
itself, with no Enter. A line-mode implementation cannot deliver this and is a
correctness problem, not a UX one: in line mode a command key both fires AND
lands in the line buffer, so typing an answer beginning with "s" silently
skipped the question. Own the line editing; do not delegate it to a readline
interface.

**Commands are `Ctrl`+letter; bare letters are ALWAYS text.** There is no
empty-buffer rule and no escape hatch, because none is needed — every answer is
typable as-is. Earlier designs bound bare letters (which made answers beginning
with those letters impossible) or `Esc`+letter (conventional in editors,
undiscoverable in a CLI). Show the modifier spelled out in the key hint line —
`Ctrl+E explain`, never `[e] explain` — so nothing has to be remembered.

**`Enter` submits.** One press, whatever is typed; a bare `Enter` on an empty
line does nothing. Single-Enter submit means a newline needs its own key:
`Alt`+`Enter`, named in the key hint line, because users write paragraphs.

**LETTER CHOICE IS CONSTRAINED BY THINGS OUTSIDE THIS PROGRAM.** A binding can
be stolen at three separate layers, and only the first is testable here:

*Layer 1 — the terminal.* Verify in a real PTY with raw mode on
(`script -q /dev/null node …`) before shipping a binding. These never arrive, or
arrive as something else:

| Combination | Why it is unusable |
|---|---|
| `Ctrl+H` `Ctrl+I` `Ctrl+J` `Ctrl+M` | They ARE Backspace, Tab, Enter, and Return. A terminal cannot distinguish them, so binding one also fires on the ordinary key. This is why Hint is not the mnemonic `Ctrl+H`. |
| `Ctrl+S` `Ctrl+Q` | XON/XOFF flow control. Raw mode happens to deliver them, but raw mode is only on *while prompting* — press `Ctrl+S` at any other moment and the terminal freezes. |
| `Ctrl+Z` | Suspends the process. |
| `Ctrl+[` | Is `Esc`. |
| `Ctrl+D` | Is end-of-file, and already ends the session. |

*Layer 2 — the terminal emulator and multiplexers.* `Ctrl+B` is tmux's default
prefix and `Ctrl+A` is GNU screen's; both are swallowed before the application
sees them for anyone working inside one. VS Code's integrated terminal reserves
some combinations as editor chords. A PTY test cannot see any of this, because
the interception happens upstream of the pty.

*Layer 3 — the operating system.* **A PTY test proves the terminal delivers a
key. It proves nothing about whether the key ever reaches the terminal.** This
is not hypothetical: `Ctrl+G` was a considered, PTY-verified default until macOS
began opening Gemini with it. There is no test that can rule this layer out, and
no letter that is safe on every machine.

**Which is why the bindings are configurable (§18.1) rather than fixed.** Treat
the defaults as a good starting guess, not a guarantee, and make rebinding easy
and discoverable rather than trying to find a universally-safe key that does not
exist.

**Validation.** Reject a binding that is reserved (the table above), that is not
`Ctrl`+letter, or that duplicates another action — each with a message saying
why. An explicit binding wins over a default; if it lands on another action's
default, that action is left UNBOUND and labelled `(unbound)` in the key hint
line, with a warning naming the command to fix it. Silently letting two actions
share a key would make one of them dead with nothing on screen to explain it.
`Ctrl+C` ends the session whatever the map says, so a broken configuration can
never trap someone in a prompt.

**`Ctrl+C` is the documented quit** and appears in the key hint line as the way
out; `Ctrl+D` on an empty line does the same. Raw mode delivers no SIGINT, so
this is handled explicitly. Every other control combination is ignored, never
inserted as text.

**Escalation does not repeat.** Pressing `Ctrl+G` again after the hint advances
to the next §10.4 rung — the concept card, then a pointer to `Ctrl+K`.
Reprinting the same hint is a bug.

Colors/prefixes MUST visually separate: teaching card, question, sample answer,
and scaffold sub-questions.

Quitting mid-session MUST persist everything already answered, and MUST NOT
consume anything else. A question the user opened but did not answer stays
`pending`: not answered, not skipped. Only an explicit `[s]` skip or a completed
self-assessment may change a question's status. Quitting at the self-assessment
prompt records nothing at all (§10.3). Never lose a completed answer to a
`Ctrl-C`.

---

## 15. Notifications

- OS-native via `node-notifier`. **No tray icon, no GUI, no persistent window.**
- **Batched:** default `notifications.batching = "per_turn"` — one notification
  per closed capture batch ("Grasp: 3 new questions"), never one per question.
- Respect `quietHours` and `snoozeUntil`. Suppressed notifications are dropped,
  not queued for later delivery — a burst of backlogged toasts is worse than
  silence.
- Purely informational. Clicking may open nothing; the user runs `grasp review`
  when ready. Notifications MUST NOT block, interrupt modally, or steal focus.
- Never notify about API errors, rate limiting, or daemon internals.
- If the platform notification call fails, swallow the error. A failed toast must
  never affect capture.

---

## 16. Cross-cutting concerns

### 16.1 Logging

- Rotating file log at `~/.grasp/logs/daemon.log`, 5 MB × 3 files.
- Levels: `error`, `warn`, `info`, `debug`. Default `info`; `GRASP_LOG=debug`
  raises it.
- **NEVER log:** the API key, file contents, or diff bodies. Log file *paths*,
  counts, tags, and timings only. This is a privacy guarantee, not a preference —
  a user's proprietary source must not end up in a plaintext log.
- The same guarantee constrains the `claude-cli` provider: it MUST pass
  `--no-session-persistence`, or every captured diff would be written into the
  user's own Claude Code session history as a side effect of generating a
  question. Grasp's prompts are not the user's conversations.
- CLI commands log to stderr at `warn`+ only; normal output goes to stdout.

### 16.2 Exit codes

`0` success · `1` unexpected error · `2` user/usage error (not a git repo,
unknown config key) · `3` hard gate block (from `grasp __precommit`).

### 16.3 Config errors

Corrupt or unparseable `config.json` → back it up to `config.json.bak`, write
fresh defaults, warn loudly on stderr, continue. **Never** crash the daemon over a
malformed config. Unknown keys are preserved on write (forward-compatible) but
warned about once.

### 16.4 Path normalization

- **Store** all paths in `question_files` and `scan_progress` as POSIX-style,
  relative to the project root (`src/auth/middleware.js`).
- **Store** `projects.path` as an absolute, resolved, symlink-free path.
- Normalize at every boundary: watcher events, git output, user-supplied CLI args.
- Comparisons MUST be case-sensitive on Linux and case-insensitive on
  macOS/Windows — put this in `util/paths.ts`, never inline.

### 16.5 Concurrency guards

- Only one `grasp review` session at a time: take a lock file at
  `~/.grasp/review.lock` (stale after 30 min); second invocation reports and
  exits 2.
- Only one `grasp scan` per project at a time, same mechanism.
- The daemon and CLI may write concurrently; WAL + `busy_timeout` (§5.4) covers
  it.

---

## 17. CLI reference

```
grasp init                     Register current repo. Bootstraps the daemon on first-ever
                               run. Offers a scan if the repo has existing code. Exits immediately.
grasp enable                   Resume the background daemon globally.
grasp disable                  Pause the daemon globally. Data, registrations, hooks preserved.
grasp review [--all]           Answer pending questions. Current project by default.
grasp scan [--full]            Onboarding walk of existing code. --full bypasses the cap (with warning).
grasp retry                    Re-attempt all failed/timed-out generation calls.
grasp status                   Daemon state, pending counts, projects, failures.
grasp history [--tag <t>]      Browse past answered questions.
grasp set <key> <value>        Edit config via dot-notation (e.g. decayWindows.trace 120).
grasp reset config|history     Restore default config, or wipe history.db (confirmation required).
grasp export --anki|--raw      Export question data.
grasp uninstall-hooks          Remove Grasp pre-commit hooks from all repos, restore originals.
grasp __precommit              Hidden. Invoked by the git hook.
```

`grasp status` output format:

```
Grasp — running (pid 48213, up 3h 12m)

Projects (2):
  ~/dev/my-app          soft    4 pending · 1 expired
  ~/dev/client-site     hard    0 pending

Questions: 4 pending · 87 answered · 3 generation failures (`grasp retry`)
Mastery:   23 concepts tracked · 6 at reconstruct
```

When the daemon is not running, say so on line one and suggest `grasp enable`.

---

## 18. Configuration

### 18.1 Files

- **Global:** `~/.grasp/config.json` (mode 0600)
- **Per-repo override:** `<project>/.grasp.json` — optional, any subset,
  deep-merged over global.

```jsonc
{
  "apiKey": null,
  "provider": "auto",                    // auto | claude-cli | api  (§6.3)
  "model": "claude-sonnet-4-6",
  "gateMode": "soft",                    // soft | warn | hard
  "debounceMs": 4000,
  "maxFilesPerBatch": 25,
  "maxDiffLines": 800,
  "maxQuestionsPerHour": 12,
  "questionStaleDays": 14,               // null disables staleness
  "scanQuestionsCap": 15,
  "decayWindows": { "trace": 90, "predictBreak": 60, "reconstruct": 45 },
  "synthesisTrigger": { "minDiffCount": 3, "minMasteryTier": "predict_break" },
  "notifications": {
    "batching": "per_turn",              // per_turn | per_question
    "quietHours": null,                  // e.g. ["22:00", "08:00"]
    "snoozeUntil": null
  },
  "review": {
    "keys": {                            // §14.4 — Ctrl+<letter> only
      "hint": "ctrl+t",
      "explain": "ctrl+e",
      "deeper": "ctrl+r",
      "breakdown": "ctrl+k",
      "skip": "ctrl+n",
      "quit": "ctrl+c"
    }
  },
  "ignorePatterns": [
    "**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**",
    "**/vendor/**", "**/generated/**", "**/*.min.js", "**/*.map",
    "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/*.lock",
    "**/__snapshots__/**", "**/*.generated.*"
  ],
  "diffSizeThreshold": { "minLines": 3 }
}
```

**`review.keys`** exists because keybinding collisions are machine-specific: a
terminal emulator, a multiplexer, or the OS itself may claim a combination before
Grasp ever sees it, and no default is safe everywhere (§14.4). Validate on load —
reserved combinations, malformed values, and duplicates all fall back to the
default with a warning explaining why. `grasp set review.keys.<action>` rejects
the same cases outright, so an unusable binding is never written.

### 18.2 Per-repo config security

`.grasp.json` is intended to be committable, so a team can share ignore patterns.
Therefore **`apiKey` in a per-repo config MUST be ignored** and MUST produce a
loud warning. A committed API key is a serious incident; make it structurally
impossible for Grasp to read one.

### 18.3 `grasp set`

Dot-notation keys. Validate the key exists in the schema and the value parses to
the right type. Unknown key or bad type → exit 2 with a clear message. Never write
an invalid config.

---

## 19. Data model

Canonical schema is `src/storage/schema.sql`. All timestamps are ISO-8601 UTC
strings.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  version INTEGER NOT NULL          -- bump + migrate on any schema change
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,        -- absolute, resolved, symlink-free
  registered_at TEXT NOT NULL,
  gate_mode TEXT                    -- soft|warn|hard, NULL = use global default
);

-- GLOBAL, not per-project: mastery transfers across repos.
CREATE TABLE concepts (
  tag TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'none',   -- none|trace|predict_break|reconstruct
  last_demonstrated_at TEXT,           -- drives lazy decay; NEVER store computed decay
  first_seen_at TEXT NOT NULL
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                  -- trace|predict_break|reconstruct|synthesis
  concept_tag TEXT REFERENCES concepts(tag),
  origin TEXT NOT NULL,                -- 'live' | 'scan' | 'synthesis'
  batch_id TEXT,                       -- groups questions from one generation call
  diff_hash TEXT,                      -- live dedup
  file_hash TEXT,                      -- scan dedup
  question_text TEXT NOT NULL,
  sample_answer TEXT NOT NULL,
  teaching_card_text TEXT,             -- NULL if none generated
  teaching_card_deeper TEXT,           -- optional depth, shown on request only
  hint TEXT,
  scaffold_json TEXT,                  -- JSON array of sub-questions
  code_snippet TEXT,                   -- diff/section; needed for review + anki export
  author_confidence REAL,              -- 0..1 from §7.6; ordering signal ONLY
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|answered|skipped
  self_assessment TEXT,                -- nailed_it|mostly_there|way_off|NULL
  assistance_level TEXT NOT NULL DEFAULT 'none', -- none|hint|retry|scaffolded
  user_answer TEXT,                    -- retained for `grasp history`; never evaluated
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX idx_questions_status ON questions(status, created_at);
CREATE INDEX idx_questions_tag ON questions(concept_tag);
CREATE INDEX idx_questions_project ON questions(project_id, status);

-- Join table, not a serialized array: the hard gate queries this against staged
-- filenames on every commit, so it must be indexable.
CREATE TABLE question_files (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,             -- POSIX-style, relative to project root
  PRIMARY KEY (question_id, file_path)
);
CREATE INDEX idx_question_files_path ON question_files(file_path);

-- Deliberately separate from `concepts`. NEVER joined for scoring.
CREATE TABLE synthesis_clusters (
  tag TEXT PRIMARY KEY REFERENCES concepts(tag) ON DELETE CASCADE,
  eligible INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_yet_attempted', -- not_yet_attempted|struggled|passed
  count_at_last_checkpoint INTEGER NOT NULL DEFAULT 0,
  last_checkpoint_at TEXT
  -- diff_count intentionally absent — derive it (§11.6).
);

CREATE TABLE scan_progress (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,             -- POSIX-style, relative to project root
  file_hash TEXT NOT NULL,
  sections_completed INTEGER NOT NULL DEFAULT 0,
  sections_total INTEGER NOT NULL DEFAULT 1,
  last_scanned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE TABLE generation_failures (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'live' | 'scan' | 'synthesis'
  payload_json TEXT NOT NULL,          -- full re-attemptable input (§19.1)
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  failed_at TEXT NOT NULL
);
```

### 19.1 `generation_failures.payload_json`

Must contain everything needed to re-run the call without re-deriving it:

```jsonc
{
  "kind": "live",
  "projectId": 1,
  "files": ["src/a.ts"],
  "diff": "<unified diff>",            // or "section" for scan
  "masteryContext": { "debouncing": "trace" },
  "knownTags": ["auth-flow", "debouncing"]
}
```

`grasp retry` replays these, increments `attempts`, and deletes the row on
success. Rows with `attempts >= 5` are reported but not auto-retried.

### 19.2 Migrations

`schema_meta.version` starts at 1. `db.ts` runs ordered migrations on open. Even
for v1, ship the mechanism — retrofitting migrations onto a tool with live user
data is significantly worse than having an unused migration runner.

---

## 20. Export

**`grasp export --raw`** — JSON dump of `questions` (+ joined file paths),
optionally filtered by project, tag, or date range. Debugging and portability
escape hatch.

**`grasp export --anki`** — tab-separated front/back, Anki plaintext-import
compatible.

- Include **all** statuses (`pending`, `answered`, `skipped`, expired). An
  unanswered question with a sample answer is still a valid flashcard.
- **Exclude teaching cards** — not quiz material.
- `reconstruct` and `synthesis` export as-is; they're self-contained by design.
- `trace` and `predict_break` **MUST embed `code_snippet` in the card front** —
  they're phrased against specific code behavior and are meaningless without it.
  Do not drop these tiers from the export; they're the majority.
- Escape tabs and newlines per Anki's format (`\t` → space, newlines → `<br>`).
- Write to stdout by default so it can be piped; `--out <path>` writes a file.

---

## 21. Out of scope — do not build

Considered and deliberately rejected or deferred.

- **Any AI-tool-specific integration for CAPTURE** (Claude Code hooks, Cursor
  plugins, IDE extensions, browser extensions). The filesystem watcher is the
  universal layer; tool-specific hooks were the previous version's biggest
  limitation and its main source of missed captures.
  Note the boundary: §6.3 shells out to the Claude Code CLI as a *model
  transport*, which is a different thing. Nothing about capture, filtering, or
  question flow depends on it, code written by Cursor or Copilot is captured
  identically, and a user with only an API key gets the same behavior. If the CLI
  provider ever starts influencing what gets captured, that is this rejected idea
  sneaking back in.
- **Automated answer grading**, similarity scoring, or LLM answer evaluation (§2.1).
- **Git commits/pushes as a capture trigger** (§13.1).
- **OAuth login, hosted key proxy, any backend, any telemetry, any analytics.**
- **A GUI, tray icon, menu bar app, or web dashboard.**
- **A scheduled spaced-repetition queue** with its own reminders (§11.3, §11.8).
- **Team/org features:** shared dashboards, blocking other people's PRs,
  comprehension scores as a management or hiring signal.
- **A mastery-history table** (tier changes over time). Possibly useful later; not
  v1. Current state only.
- **Multi-user support, accounts, or sync.** One machine, one user, local files.

---

## 22. Testing requirements

Test quality is a release gate, not a nicety. A capture tool that silently misses
changes or double-charges the user's API key is worse than no tool.

### 22.1 Standards

- **Framework:** `vitest`. **Coverage:** `@vitest/coverage-v8`.
- **Thresholds (CI-enforced, build fails below):** 85% line / 80% branch overall;
  **95% line** for `mastery/`, `synthesis/`, `capture/rateLimit.ts`,
  `gate/gitHook.ts`, and `generation/` output parsing. These are the modules where
  a silent bug corrupts user state or spends money.
- **No network and no subprocess in tests, ever.** BOTH providers MUST be mocked
  at the module boundary: the Anthropic SDK, and the `claude` CLI runner. A test
  that makes a real API call — or spawns a real `claude` — is a failing test.
- **Isolation:** every test gets a fresh temp `HOME` (so `~/.grasp` is sandboxed)
  and an in-memory or temp-file SQLite DB. No test may touch the developer's real
  `~/.grasp`. Enforce with a global setup file that overrides the home resolver
  and fails loudly if a real path is reached.
- **Determinism:** freeze time with `vi.setSystemTime` for anything decay- or
  staleness-related. No `sleep`-based tests except where debounce timing is the
  subject, and there use fake timers.
- **Fixtures:** keep a `test/fixtures/` set of real-world diffs (multi-file,
  single-line, formatting-only, broken-syntax, huge, binary, unicode/emoji,
  CRLF-line-ending) reused across suites.

### 22.2 Unit tests — required cases

**`mastery/decay.ts`**
- Each tier at: 1 day elapsed, exactly at the window boundary, window+1 day,
  10× window. Boundary-exact must NOT decay (`>` not `>=`).
- `null` window disables decay.
- `none` tier cannot decay further.
- `last_demonstrated_at` null (never demonstrated) → treated as `none`.

**`mastery/tierLogic.ts`**
- All three self-assessments × all four tiers = 12 transition cases.
- `nailed_it` at `reconstruct` stays `reconstruct` (no overflow).
- `way_off` at `trace` → `none` and re-arms the teaching card.
- **Transitions apply to effective, not stored, tier** — the decayed-then-nailed-it
  case (§10.3) must restore the original tier, not increment the decayed one.
- Skip changes nothing: not tier, not `last_demonstrated_at`.
- `assistance_level` never affects a transition.

**`synthesis/trigger.ts`**
- Count met, mastery not → NOT eligible.
- Mastery met, count not → NOT eligible.
- Both met → eligible.
- Count derived from a query, not a counter: insert/delete questions and assert
  eligibility tracks correctly.
- `struggled` re-surfaces on a new question under the tag; not before.
- `passed` stays closed until `minDiffCount` beyond `count_at_last_checkpoint`.
- Synthesis outcome MUST NOT mutate `concepts` — assert the row is byte-identical
  before and after.

**`capture/rateLimit.ts`**
- Under cap → generate, checkpoint advances.
- Over cap → no call, **checkpoint does not advance**, changes roll into the next
  batch.
- Rolled-up diff exceeding `maxDiffLines` → generates despite the cap.
- Rolling window: 12 questions 61 minutes ago do not count against the cap.

**`capture/diffFilter.ts`**
- Below `minLines` → rejected. At exactly `minLines` → accepted.
- Whitespace-only, indentation-only, and line-ending-only changes → rejected.
- Import reorder with no other change → rejected; import reorder plus a real
  change → accepted.
- A 3-line but semantically meaningful function → accepted (guards against
  over-filtering).

**`generation/` parsing**
- Valid payload parses.
- Fenced JSON (```json) parses after stripping.
- Malformed JSON → one retry → failure row, checkpoint not advanced.
- Unknown tier / 4+ questions / missing `sample_answer` → schema violation, no
  coercion.
- `skip: true` → no questions persisted, checkpoint DOES advance.
- Prompt assembly includes known tags, capped at 60, most-recent-first.
- **Tier clamping:** every mastery × returned-tier pair (12 cases). A returned
  `reconstruct` at mastery `none` clamps down to `trace`; a returned
  `predict_break` at mastery `predict_break` is NOT promoted to `reconstruct`.
  The stored tier is never above the mastery ceiling, and never above what the
  model wrote the question for.
- **File attribution:** a hallucinated path is dropped and the real ones kept;
  all-hallucinated → violation; platform case rules respected (§16.4).
- **Reconstruct leak check:** an identifier from the snippet in `question`,
  `hint`, or `scaffold` → violation on the first attempt, downgrade to
  `predict_break` on the last; the same identifier in `sample_answer` → allowed;
  a generic local (`value`, `result`) never fires; `parse_expr` does not match
  inside `parse_expr_list`; non-reconstruct tiers are not checked at all.
- **Scaffold requirement:** fewer than 2 steps → violation at `trace` and at
  `reconstruct`, accepted at `predict_break`. A question clamped DOWN to `trace`
  with no scaffold warns rather than failing (the clamp caused it, not the model).
- Retry policy: 429/5xx backs off 1s/4s/10s (assert the delays, with injected
  timing); 401/403 is NOT retried; the API key is redacted from failure text.

**`generation/provider.ts`**
- `auto` picks `claude-cli` when the probe reports `loggedIn: true`.
- `auto` falls back to `api` when the CLI is absent, times out, exits non-zero,
  or reports `loggedIn: false`.
- `auto` with neither available → error naming BOTH routes.
- Pinned `claude-cli`/`api` that is unavailable → error, never a silent fallback.
- The CLI invocation carries `--safe-mode`, `--strict-mcp-config`,
  `--system-prompt`, `--tools ""`, `--output-format json`, a neutral cwd, and the
  prompt on stdin rather than argv. Assert the argv — this is the isolation
  contract, and a dropped flag is silent quality loss.
- Envelope handling: `result` extracted; `is_error`/non-`success` subtype →
  provider error; unparseable stdout → provider error.
- The auth probe is cached, not re-run per call.

**`gate/gitHook.ts`**
- Pending question on a staged file → block (exit 3).
- Pending question on an unstaged file → do not block.
- Expired question on a staged file → do not block.
- Windows-style input paths match POSIX-style stored paths.
- Foreign hook present → chained, runs first, its non-zero exit short-circuits.
- Grasp's own marker recognized → not double-installed.
- Uninstall restores the foreign hook exactly.

**`util/paths.ts`**
- Absolute→relative, backslash→POSIX, symlink resolution, case sensitivity per
  platform, paths with spaces and unicode.

**`config/`**
- Deep merge of per-repo over global.
- `apiKey` in per-repo config ignored + warned (§18.2).
- Corrupt JSON → backup + defaults + warn, no throw.
- `grasp set` rejects unknown keys and wrong types.
- `review.keys`: each reserved combination rejected with its reason; a bare
  letter rejected; a duplicate rejected naming the action that holds it;
  `Ctrl+C` accepted for `quit` and refused for anything else; a hand-edited
  unusable map falls back with warnings; an explicit binding that displaces
  another action's default leaves that action `(unbound)` rather than sharing.

### 22.3 Integration tests — required scenarios

Run against a real temp git repo with simulated file writes.

1. **Happy path:** write a file → batch closes → one generation call (mocked) →
   question persisted → checkpoint advanced → notification fired once.
2. **Mid-write protection (the critical one):** write a syntactically invalid
   partial file, then complete it 1s later. Assert **exactly one** generation call,
   made against the **completed** content.
3. **Debounce coalescing:** five files written 500ms apart → one batch, one call.
4. **Batch cap:** 30 files at once → batch closes early at `maxFilesPerBatch`.
5. **API failure:** mocked 500 → retries with backoff → failure row → checkpoint
   NOT advanced → next write includes the earlier change → `grasp retry` succeeds.
6. **Crash recovery:** kill mid-batch, restart, assert no data loss and no
   duplicate question for the same diff.
7. **Dedup:** the same diff never produces two questions (`diff_hash`).
8. **Scan resumability:** interrupt at question 7 of 15, re-run, assert it resumes
   and does not re-ask the first 6.
9. **Scan re-run with no edits:** zero generation calls.
10. **Scan section splitting:** a 1000-line file splits on declaration boundaries;
    a minified 1000-line file falls back to hard split with overlap.
11. **End-to-end review:** seed questions → run a scripted review session →
    assert mastery transitions, `assistance_level`, and `answered_at` persisted.
11b. **The keyboard itself, through real pipes.** A scripted-IO double cannot see
    the terminal layer, and that blind spot shipped three bugs: the
    self-assessment prompt resolving as a quit, line mode swallowing every
    keybind, and a command key firing from the first character of an ordinary
    answer. Drive `createTerminalIo` over a pipe that reports `isTTY`, and assert:
    each `Ctrl`+letter command fires with no Enter, mid-answer included; a bare
    letter is ALWAYS text, including answers that begin with e/d/b/s/q/g/n/k;
    `Enter` submits and a bare `Enter` does not; `Alt`+`Enter` inserts a newline;
    `Ctrl+S`, `Ctrl+Q`, `Ctrl+Z`, `Ctrl+B`, and `Ctrl+A` are inert and are not
    inserted as text; `Ctrl+H` edits rather than hinting and `Ctrl+M` submits,
    proving the collision is real; `Ctrl+C` and a closed stream end the session;
    and `1`/`2`/`3` record on the keypress alone. Assert the key hint line spells
    every modifier out.
11c. **Quitting consumes nothing.** Open a session, exit without answering, and
    assert every seeded question is still `pending` — for a `[q]` quit, a closed
    stream, and a quit at the self-assessment prompt.
12. **Reconstruct hiding:** assert `code_snippet` is not emitted to stdout before
    the answer is submitted.
13. **Concurrency:** daemon writing while a review session writes → no
    `SQLITE_BUSY` surfaced to the user (WAL + busy_timeout).
14. **Review lock:** second concurrent `grasp review` exits 2.
15. **Init idempotency:** `grasp init` twice → one project row, exit 0 both times.
16. **Uninstall hooks:** across two repos, one with a foreign hook → both restored
    correctly.

### 22.4 Cross-platform

The CI matrix (§3) MUST run the full suite on Linux, macOS, and Windows. Service
installation and notification dispatch are stubbed in CI, but **path handling,
git-hook logic, and the parser probe/fallback path MUST run for real on all
three** — those are where platform bugs actually live.

### 22.5 Manual QA checklist (pre-release)

Automated tests can't cover these; document them in `CONTRIBUTING.md`:

- Install globally, `grasp init` a real repo, have a real AI tool write real code,
  confirm a question appears without any terminal left open.
- Reboot the machine; confirm the daemon auto-starts and resumes watching.
- Confirm question *quality* by hand on 20+ real diffs across at least two
  languages. This is the one thing no test suite can assert, and it's the product.
- Run `grasp scan` on a large unfamiliar open-source repo; confirm the cap,
  progress output, and resumability behave sanely.
- Verify no API key, file content, or diff body appears anywhere in
  `~/.grasp/logs/`.

---

## 23. Build order

Each stage is testable before the next exists. Do not reorder — stage 1 gates
everything.

1. **`generation/` in isolation** + `scripts/dev-generate.ts`. The prompt, the
   output contract, the parser/validator. Iterate against real diffs until
   question quality is genuinely good. **Do not proceed until it is** — everything
   downstream is plumbing, and plumbing around bad questions is a wasted build.
2. **`storage/`** — schema, connection, WAL, migrations, models. Fully specified
   in §19.
3. **`config/`** — defaults, merge, save, dot-notation `set`, security rule §18.2.
4. **`review/` + `cli/commands/review.ts`** — wire the full answering flow against
   hand-seeded DB rows. The entire user-facing experience becomes testable with no
   watcher in existence.
5. **`mastery/` + `synthesis/`** — transitions, lazy decay, eligibility,
   re-surfacing.
6. **`capture/` + `daemon/`** — snapshot/diff, filters, rate limit, debounce,
   syntax check, parsers, watcher.
7. **`cli/commands/init.ts` + `daemon/daemon.ts`** — folded setup flow, PID file,
   service installation across three platforms.
8. **`notifications/`**
9. **`gate/`** — modes, hook install/chain/remove, `__precommit`.
10. **`scan/`**
11. **`export/`, `status`, `history`, `retry`, `reset`, `uninstall-hooks`.**
12. **Docs:** README (install, quickstart, config reference, uninstall),
    CONTRIBUTING (manual QA checklist §22.5).

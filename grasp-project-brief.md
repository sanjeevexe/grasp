# Grasp — Project Brief

**Name:** Grasp
**Command:** `grasp`
**npm package name:** `grasp-cli` (bare `grasp` is already taken by an unrelated, dead package — publish under `grasp-cli`, alias the installed binary to `grasp` so the actual command stays clean)
**Type:** Open-source terminal-native CLI tool
**Status:** Ideation complete — ready for v1 build *(historical: this is the original pre-build ideation doc. The build has since diverged from it in places the team judged during implementation — notably, questions surface via on-demand `grasp review` rather than being presented synchronously before the agent's final output, as `onSessionComplete` below still describes. See [BUILD_PLAN.md](BUILD_PLAN.md) and [README.md](README.md) for the as-built architecture, and [DECISIONS.md](DECISIONS.md) for the reasoning behind each divergence.)*
**Primary goal:** Ship a genuinely useful, well-received open-source tool. Not a business.

---

## 1. The Problem

When developers delegate work to AI coding agents (Claude Code, Cursor, aider, etc.), the agent takes anywhere from 30 seconds to several hours to complete a task. During that wait, the default behavior is to pick up the phone.

This creates two compounding problems:

1. **Wasted time.** The wait is dead time by default.
2. **Wasted learning.** Because attention is elsewhere during the build *and* the output is skimmed rather than read on return, the developer never actually understands what was built. Over time this produces a codebase the "author" cannot explain, debug, or evaluate. If the agent makes a subtle mistake, it ships — because nobody was equipped to catch it.

**Problem #2 is the real one.** Problem #1 is a symptom. The root issue is not that the AI is slow — it's that the human is disengaged, and disengagement compounds into not understanding your own codebase.

**Critical framing:** the problem being solved is *user* discipline and comprehension, not *agent* efficiency. Any proposed feature that makes the agent faster/better but leaves the user free to scroll their phone has missed the point.

---

## 2. The Solution

**Grasp is a terminal-native CLI tool that intercepts the output of an AI coding agent and requires the developer to actively engage with what changed before moving on.**

Core loop:

1. Agent completes a meaningful unit of work (a diff, a file edit, a task).
2. Grasp captures the diff.
3. Grasp generates 1–3 targeted comprehension questions about that diff — see 3.2 for the concept + instance question design.
4. The user answers (typed, free-form) *before* seeing the agent's full output.
5. Answers are logged locally. The user proceeds.

The mechanism is **active recall** — the well-established finding that being forced to retrieve/articulate information produces far better retention than passively re-reading it. Grasp does not need to *grade* answers for this to work; the value is in the act of articulation. Grading is optional depth, not the core mechanic.

### Why this shape specifically

- It uses time the developer already has (the wait) for work they already owe (understanding the diff).
- It is **inherently phone-resistant** in a way a passive todo list is not: it demands typed engagement and it sits in the workflow's critical path.
- It solves the timing problem naturally: questions are about the work that *just finished*, so they're answered during the wait for the *next* task. No prediction required, no multi-agent complexity.

---

## 3. Design Decisions (Settled)

### 3.1 Gating: soft nudge by default

| Mode | Behavior | Default |
|---|---|---|
| Soft nudge | Question appears; user may skip | ✅ Yes |
| Hard gate | Next command blocked until answered | Opt-in via config |

**Rationale:** AI agents frequently introduce tools, libraries, and patterns the user has genuinely never seen. Hard-gating someone on something they *cannot yet know* converts a learning tool into a punishment tool — that's a week-one uninstall. The north star is **teach, don't punish.**

**Important nuance:** skipping must carry *slight friction* — an explicit keypress, not a silent timeout or auto-dismiss. Zero-friction skip degrades Grasp into a passive display that nobody engages with, which is the exact failure mode of the "show a todo list" idea that was rejected during ideation.

Optional (low priority): a one-line "why are you skipping?" prompt on skip. Not required, purely informational, useful signal for the user's own history.

### 3.2 Question design: concept + instance, not instance alone

**Core principle:** a question about *only* the specific diff ("why did this use a mutex here?") fails in two directions — if the user already knows the concept it's trivial, and if they don't, it's unanswerable and pushes straight to frustration. Grasp should teach the underlying concept first, *then* ask the user to apply it to their actual code. General principle → specific application, not application alone.

**Two question types, used together:**

1. **Concept question** — tests/teaches the general idea independent of this codebase. *"What's the difference between a mutex and a channel for coordinating goroutines, and when would you reach for one over the other?"*
2. **Instance question** — applies that concept to the diff that just happened. *"Given that, why did this change protect `cache` with a mutex instead of using a channel?"*

Asked together, in that order, the instance question becomes answerable *because* of the concept question — that's the actual teaching mechanism, not just two questions bolted together.

**Per-user memoization:** Grasp should not re-teach a concept the user has already demonstrated understanding of. Before including a concept question, check the local log (see 3.4) for prior tags on that concept — if it's been answered before (not skipped), ask the instance question alone. v1 needs only this simple tag-lookup, not real mastery modeling; that's a natural extension for the future dashboard (Section 4).

### 3.3 Question generation: one path, graceful skip on failure

**v1 has exactly one generation path, plus graceful degradation. No fallback tiers.**

**The path — piggyback on the agent's own session**

Use Claude Code's headless/non-interactive mode:

```bash
claude -p "<prompt>" --output-format json
```

Key properties that make this the only path worth building for v1:

- **Zero onboarding friction.** Inherits the user's already-configured auth. No API key setup, no separate signup, no "go get a key and paste it here" step during install.
- **Self-reporting cost.** The JSON output includes `total_cost_usd` per call, which makes cost *measurable and enforceable* rather than a hopeful guess.
- **Cost capping is therefore possible.** Grasp tracks cumulative spend per session and stops generating once a configurable cap is hit (suggested default: a few cents per session). Build the cap before the first real test session — it's a safety rail, not an optimization.

**The "is this worth asking about" decision is folded into the same call, not a separate one.** Rather than maintaining a static allowlist/denylist of "interesting" diff patterns, give the model the diff plus the user's concept-tag history and let it decide, in one shot: (a) is this diff worth a question at all, (b) does it need a concept question first or has the user already got it, (c) generate the question(s). The model reads the diff regardless, so this costs effectively nothing beyond straight question generation — one smarter call, not two calls. A static list can't generalize across the range of real diffs; a model reading the actual diff can.

Recommended invocation shape — keep it cheap, read-only, and bounded:

```bash
claude -p "<judge + generate prompt, diff + concept-tag history>" \
  --output-format json \
  --allowedTools "" \
  --max-turns 1
```

Constrain tools to nothing (Grasp supplies the diff in the prompt; the model should not be exploring the filesystem or making edits). Cap turns. Keep the prompt tight.

**Transparency requirement:** the docs and first-run message must state plainly that this draws from the user's existing Claude plan/usage. Subscription users are spending rate-limit headroom; API-billed users are spending real (tiny) dollars. Do not bury this.

**On failure — skip gracefully, never block on nothing**

If the headless call errors, times out, or the session cost cap has been hit, Grasp does **not** fall back to a second generation system. It:

1. Skips the question silently (or with a minimal, non-alarming notice)
2. Logs the miss locally, with the reason (error / timeout / cap reached)
3. Never gates the user on a question that doesn't exist

This is a few lines of error handling, not a subsystem. The logged misses are also useful data later: if real usage shows people frequently hitting the cap or losing questions to errors, *that's* the evidence that justifies building a fallback — and it will be evidence rather than speculation.

**Why no heuristic tier and no BYOK in v1 — see the deferred table in Section 4.** Both were designed during ideation and consciously cut. Neither is ruled out; both are gated on real demand.

**Explicitly rejected outright (not merely deferred):** a hosted backend where the maintainer eats token cost — it creates variable cost scaling with users and forces a monetization question that conflicts with the project's stated goals.

### 3.4 Interface: terminal only for v1

- Rich TUI (ratatui / ink / textual style), **not** raw `print()` to stdout. Needs scrollable content, syntax-highlighted diffs, a readable question view.
- No web app, no desktop app, no browser extension in v1.

**Rationale:** "Terminal" was never the real constraint — plain stdout was. A rich TUI delivers everything v1 needs while remaining a single `npm install -g` / `pip install` with low adoption friction, living exactly where Claude Code already lives.

**On the future app/dashboard:** during ideation, the pull toward building a separate app was traced back to "this problem feels big," not to a concrete capability the terminal lacks. That's not a sufficient reason to build a second product. The one genuine gap identified is **longitudinal learning analytics** — "what have I consistently failed to explain over the last month," topic-level weak spots, trends over time. A CLI is structurally bad at that. This is the legitimate wedge for a future second surface, **gated on real usage signal from the CLI first.**

### 3.5 Data: local-first, inspectable

- Store everything locally from day one — **even before any dashboard exists.**
- Suggested: SQLite at a documented path (e.g. `~/.grasp/history.db`), plus a documented schema.
- Plain and inspectable by design. Not obfuscated.

Log per event, roughly:

| Field | Purpose |
|---|---|
| timestamp | when |
| repo / project | scoping |
| diff hash + summary | what changed |
| question text | what was asked |
| question type | concept / instance / both |
| generation source | how it was generated (headless `claude -p` in v1; field exists so future paths can be distinguished) |
| miss reason | if no question was generated: error / timeout / cap reached — see 3.3 |
| user answer | free text |
| skipped (bool) + skip reason | engagement signal |
| concept tags | which concept(s) this touched — drives the "don't re-teach" check in 3.2 and future mastery tracking |
| cost (if LLM-generated) | spend transparency |

**Why log before the dashboard exists:** whenever the dashboard gets built, it starts with months of real history instead of a cold start. Skipping this now is the actual mistake — not skipping the dashboard UI. The concept-tag field is also what today's "have I already been taught this" check reads from — same field serves v1 and the future dashboard.

**Privacy stance (load-bearing for this product):** Grasp ships the user's code to an LLM. That makes trust a prerequisite, not a nice-to-have.

- Nothing is transmitted to the maintainer. Ever. No telemetry in v1.
- Any future dashboard stays **local** — a second program reading the same local file on the user's own machine. This requires zero data pipeline and zero trust ask.
- Cross-user aggregation (comparisons, leaderboards) would require explicit opt-in, structured metadata only (never raw code/diffs), and must remain fully optional to core functionality. Not planned.

### 3.6 Licensing: open-core

- **Core CLI: fully open source, permissive license (MIT/Apache).** Openness here is functional, not ideological — nobody security-conscious will install a closed-source tool that silently intercepts their session and ships diffs to an LLM. Open source is closer to a prerequisite than a growth tactic.
- **Any future dashboard/analytics layer:** may be closed and/or paid, if it ever gets built and if usage warrants it.

**On idea theft:** deliberately deprioritized. Ideas aren't protectable; the realistic risk is a well-resourced incumbent (GitHub, Cursor, Anthropic) shipping a first-party equivalent, and no license prevents that. Given the project's stated goals — ship something real, learn, build public credibility — being eventually outcompeted by a first-party feature does not erase the value of having shipped it.

---

## 4. Deferred / Explicitly Out of Scope for v1

Keep v1 tight. These were discussed and consciously postponed:

| Item | Why deferred |
|---|---|
| **Heuristic-only generation tier** (static diff analysis + canned concept-question glossary) | Fully designed during ideation, then cut. It's a whole second content-generation subsystem — cross-language pattern detection plus authoring real pedagogical content for the glossary — arguably more work than the LLM path itself. Its payoff (working with no LLM access at all) doesn't matter while v1 targets Claude Code only, since every Claude Code user already has headless access. **Re-entry trigger:** demand for a genuinely zero-cost mode, or an adapter for an agent with no headless self-invocation. Note this is significantly more work than BYOK, so treat it as a real project, not a quick add. |
| **BYOK (bring-your-own-API-key)** | Cheap to add later — reuses the exact same prompt/generation code path as the main path, just swapping who authenticates. Cut from v1 because the cost cap already solves most of the anxiety BYOK was meant to address, and its setup cost ("go get an API key and paste it in") reintroduces exactly the onboarding friction the piggyback approach exists to eliminate. **Re-entry trigger:** the first time a real user actually asks for spend separation. |
| **Presence-adaptive delivery** (spaced when user is active, batched when away) | Genuinely good idea — detect activity (tmux hooks, keystroke/idle polling), space questions during attended sessions, batch and gate on return for unattended ones. But it adds meaningful complexity and v1 can ship with simpler "batch and present on completion" behavior. |
| **Pre-task prediction mechanic** ("what approach do you think the agent will take?") | Interesting active-learning technique (prediction beats passive review), but it's a different feature from post-hoc explanation and would bloat v1. |
| **Longitudinal dashboard** | Gated on CLI usage signal. Data logging starts now; the UI does not. |
| **Answer grading / correctness scoring** | Active recall works without it. Adds cost, latency, and a whole "is the grade fair" problem. |
| **Spaced repetition scheduling** | Overlaps heavily with Anki/existing tools. Better solved via export than by rebuilding a scheduler. |
| **Multi-agent / cross-agent review queue** | Rejected during ideation: too niche, and it doesn't solve the user-discipline problem. |
| **Browser extension / desktop app** | Only after CLI proves out. |

---

## 5. Technical Approach

### 5.1 Hooking into the agent

**Claude Code first, ship it alone in v1** (it's the tool the problem was observed with, it exposes the cleanest integration surface, and its headless mode is the most battle-tested of the agents checked). Claude Code provides a hooks system with events including `PreToolUse`, `PostToolUse`, and `Stop` — these are the natural triggers for capturing when a meaningful change lands and when a session completes.

**Design the capture layer as an adapter interface from day one**, even though only one adapter ships in v1. This is the single most likely surface for outside contributions ("I use aider/Cursor, let me add support"), and retrofitting an abstraction later is painful.

```
AgentAdapter
  ├─ onChangeDetected(diff) -> emits question-generation event
  ├─ onSessionComplete()    -> flush queue, present before final output
  ├─ supportsHeadlessSelfInvocation: bool  -> can this agent generate questions at all
  └─ reportsCost: bool                     -> determines whether spend can be tracked/capped
```

**Cursor is the natural fast-follow, not day-one parity.** Cursor's CLI (`cursor-agent` / `agent`) also has a documented `-p` headless mode, so the core mechanism transfers. Two gaps to design around when that adapter gets built, not now: (1) Cursor's headless JSON output doesn't currently return a cost field the way Claude Code's `total_cost_usd` does — there's an open, unresolved feature request from Cursor's own community asking for it — so a Cursor adapter reports `reportsCost: false` and Grasp either estimates cost itself or ships that adapter without a hard cap; (2) there are open community bug reports of Cursor's headless mode occasionally hanging or not releasing the terminal cleanly, worth a defensive timeout in that adapter when it's built.

Fallback capture path for agent-agnostic mode: watch git working-tree state / `git diff` between checkpoints. Cruder, but works with literally any agent, including ones with no adapter at all.

### 5.2 Determining "meaningful" changes

Not every file write deserves a question. Needs filtering — this is a real design problem, not a detail:

- Ignore lockfiles, generated files, formatting-only changes, `.gitignore`d paths
- Threshold on diff size (skip trivial one-line edits; possibly skip enormous vendored dumps)
- Prefer hunks touching flagged patterns (auth, error handling, control flow, new dependencies)
- Cap questions per session so long runs don't produce an unanswerable backlog

### 5.3 Scaling content to wait length

A single 20-second question does not fill a 10-minute wait — the user is back on their phone the moment they hit enter. Question volume should scale with the amount of change captured, not be fixed at one per event.

For long unattended runs: accumulate a queue during the session, then gate on the accumulated queue when the user returns, presented **before** the full agent output.

### 5.4 Suggested stack

Not prescriptive — the build chat should pick based on comfort level:

- **Node/TypeScript** (`ink` for TUI) — best fit if targeting `npm install -g`, matches Claude Code's own ecosystem
- **Python** (`textual` for TUI) — fine, `pip install`, easy diff tooling
- **Rust** (`ratatui`) — best TUI polish and single-binary distribution, steepest curve

Given the builder is early in their programming journey, **Node/TS or Python are the pragmatic picks.** Rust is the "if you want the challenge" option.

---

## 6. Success Criteria for v1

v1 is done when:

- [ ] Installs with a single command (`grasp-cli`, aliased to `grasp`), runs with a single command
- [ ] Detects Claude Code activity and captures meaningful diffs
- [ ] Generates concept + instance questions via headless `claude -p`
- [ ] Fails gracefully — errors, timeouts, and cap-reached all skip the question and log the miss rather than blocking or crashing
- [ ] Concept-tag check correctly skips re-teaching concepts the user has already answered
- [ ] Cost tracked per session, capped, and visible to the user
- [ ] Soft-nudge gate works; hard-gate configurable; skip requires a keypress
- [ ] All events logged locally to an inspectable, documented store
- [ ] TUI is readable and doesn't feel broken
- [ ] Config file supports: gate mode, cost cap, ignore patterns, questions-per-session cap
- [ ] The builder has personally used it for a week and not disabled it

That last one matters most. If the builder turns it off during real work, that's the strongest possible signal something's wrong with the design.

---

## 7. Launch Plan (post-build)

**Sequence matters — reach should not outpace quality.**

1. **Build v1** to the criteria above.
2. **Dogfood** — builder uses it daily for at least a week on real work.
3. **Testing, two layers:**
   - *AI agents* → correctness/regression: diff parsing edge cases, headless call reliability, gate block/unblock behavior, cost math.
   - *3–4 real humans, several days* → the part agents cannot test: is the gate timing annoying in a real session, do questions feel insightful or generic, is it still enabled on day three. This layer is not optional; it tests the riskiest assumptions in the product.
4. **Polish launch materials** — this is where reach actually comes from, not platform count:
   - A README with a clear one-line pitch above the fold
   - A short demo GIF/clip showing the actual loop
   - Honest, upfront docs on what gets sent where and what it costs
5. **Coordinated launch** in a tight window (concentrated attention compounds; trickled posts don't):
   - Claude Developers Discord
   - Anthropic's community project showcase (claude.com/community — projects built with Claude can be submitted for a feature on Anthropic's channels)
   - Show HN
   - Relevant subreddit (r/programming, r/ClaudeAI)
   - Twitter/X

**Note on Anthropic's "Claude for Open Source" program:** offers free top-tier plan access to qualifying maintainers. Headline criteria are ~5,000+ GitHub stars or 1M+ monthly npm downloads with ongoing activity — not a v1 target. However, Anthropic staff have publicly said they also accept maintainers of impactful projects that don't quite hit those numbers. Worth revisiting if Grasp gets traction.

---

## 8. Guiding Principles (carry these into the build)

1. **Teach, don't punish.** Every friction decision gets checked against this.
2. **The user is the problem being solved, not the agent.** Reject features that optimize agent output without changing user behavior.
3. **Trust is load-bearing.** This tool reads code and sends it to an LLM. Local-first, open source, transparent about cost and data, no surprises.
4. **Ship the small thing well.** A polished narrow v1 beats a broad half-working one. Expansion is earned by usage signal, not enthusiasm.
5. **Never make skipping free, never make gating cruel.** The entire product lives in the tension between these two.

# Grasp — fix two real, reproducible `test:e2e` failures found on a real macOS run

You're working in the Grasp CLI codebase (`grasp-cli`), on branch `feat/pty-e2e-harness` (the PTY e2e harness built in the prior task). This is a **fix task**, not another build task — two of the harness's own scenarios fail deterministically on a real Mac even though they pass clean on this machine's own sandbox. This isn't a flake: it reproduced identically, at the same step, with near-identical timing, on two separate real runs. Read this whole prompt before making any change — the root cause for one of the two is already found below; don't skip straight to a fix without confirming you can reproduce first.

## The two failures (from a real `npm run test:e2e` run on macOS, branch `feat/pty-e2e-harness` @ `de58abf`)

```
FAIL  review: blank Enter is rejected only after a real submit attempt, never before; a real answer afterward still submits  (9387-9579ms): pty driver failed: TIMEOUT waiting for: 'type your answer, Enter to submit'

FAIL  review: Escape -> explanation -> retry -> Escape-again -> skip flow, with the hint text changing between attempts  (10761-10764ms): pty driver failed: TIMEOUT waiting for: 'Because only one goroutine may touch cache at a time.'
```

Both scenarios are in `test/e2e/scenarios/review.e2e.ts`. Both passed clean, every time, in this sandbox. Both failed, every time (2/2 real runs), on a real Mac terminal.

## Root cause found for failure #1 — confirm it, then fix it properly

`node_modules/ink-text-input/build/index.js`'s placeholder rendering fakes a text cursor by wrapping only the FIRST character of the placeholder string in `chalk.inverse(...)`, with the rest in `chalk.grey(...)`:

```js
renderedPlaceholder = chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1));
```

Whether chalk actually emits ANSI codes here depends on chalk's own runtime color-support detection of the terminal it's attached to — which differs between this sandbox (color support very likely NOT detected, so the placeholder prints as plain, unbroken text, which is why the harness's literal substring match against `"type your answer, Enter to submit"` happens to work here) and a real, color-capable terminal like macOS Terminal/iTerm (color support IS detected, so `"t"` gets wrapped in ANSI escape codes separately from the rest of the string — meaning that literal substring never appears contiguously in the raw pty byte stream `wait_for` searches, so it times out every time, deterministically, regardless of whether Grasp itself is working correctly).

This is a bug in the **harness's own assumption** — that literal generated/placeholder text always appears as one unbroken substring in the raw byte stream — not a bug in Grasp. That assumption is fragile anywhere Ink/chalk styles text at the sub-string level (this `TextInput` placeholder specifically; there may be others — check).

**First, reproduce it here**, so you're fixing a confirmed cause, not a guess: run the failing scenario with color support forced on, to simulate what a real Mac terminal's chalk detection would do (e.g. `FORCE_COLOR=1` in the environment used to spawn the pty child — check whether chalk's version in this repo respects `FORCE_COLOR`, and if some other detection signal is what actually matters here — for example, chalk also checks `TERM`/`COLORTERM`/`process.stdout.isTTY`, and this harness's pty child DOES have `isTTY` true already since it's a real pty; if forcing `FORCE_COLOR=1` alone doesn't reproduce it, dig into what chalk is actually keying off of, don't assume). Confirm you can make this scenario fail here first.

**Then fix it at the source, not by weakening the test's expectations.** The cleanest fix is almost certainly: force `NO_COLOR=1` (or `FORCE_COLOR=0`, whichever this repo's chalk version actually respects — verify, don't assume they're equivalent) in the environment every `test/e2e/` pty scenario spawns its child process with, so rendering is deterministic and plain regardless of the HOST terminal's own color-support detection. This harness exists to test Grasp's functional correctness, not its exact ANSI styling, so removing color-dependence entirely is the right fix, not a workaround — but decide where this belongs (a single shared spot in `test/e2e/lib/env.ts`'s `graspEnv()`/`isolatedHome()` helpers so every scenario gets it automatically, rather than each scenario file setting it individually) and log this as a `DECISIONS.md` entry, including why you chose to force color off globally rather than, say, teaching `wait_for`/the driver to strip ANSI codes before matching (a legitimate alternative — weigh both, pick one, explain why).

## Failure #2 — do NOT assume the same root cause, investigate separately

The text `"Because only one goroutine may touch cache at a time."` is `event.sampleAnswerInstance`, rendered via a plain `<Text>{...}</Text>` in `src/reviewApp.tsx`'s reveal-phase block (around the `phase === "concept-reveal" || phase === "instance-reveal"` branch) — not through `TextInput`, and with no chalk styling applied directly in that JSX. So the exact chalk-cursor mechanism behind failure #1 doesn't obviously apply here.

Reproduce this one the same way (forced color-support-on, matching what a real Mac terminal would do) and find its ACTUAL cause before fixing anything — possibilities worth checking, not assuming:
- Some other place in the render tree between the double-Escape retry path and the reveal phase might ALSO run text through chalk styling indirectly (e.g. a shared component, a `dimColor`/`bold` prop applied higher up that Ink implements via chalk wrapping the whole subtree rather than per-character — check whether that could still fragment a literal substring the same way).
- A genuine timing/state issue specific to the double-Escape → retry → second-Escape sequence — e.g. the second `Key.ESCAPE` in that scenario being sent before the app has finished re-rendering after the first retry's `Key.ENTER`, which could be a real, if narrow, timing assumption bug in the SCENARIO's step sequence rather than in Grasp or the driver.
- Anything else you find — the point is to know which of these it actually is before touching code, not to bundle a second fix on the assumption it's "probably the same issue."

If it turns out to be the same color-dependence class of bug, say so and fix it the same way. If it's genuinely different, fix that specific cause and explain it in its own `DECISIONS.md` entry (or fold into the same entry if it really is one root cause — your call, but justify it either way).

## Verification

- Reproduce both failures here first, with color-support forced on, before changing anything — confirm in your response that you actually saw both fail locally, not just that you read this prompt's description of them.
- After the fix, rerun `npm run test:e2e` BOTH with color forced on AND in this sandbox's normal (uninstrumented) environment — all 40 scenarios must pass clean in both conditions. This is the whole point: the fix should make the harness environment-independent, not just move the pass condition to match whichever environment you happen to be testing in.
- `npm run build` and `npm test` (the fast suite) must still pass clean.
- Skim the rest of `test/e2e/scenarios/*.e2e.ts` for any other `waitFor(...)` call matching literal text that could plausibly pass through the same `TextInput` placeholder path or similar sub-string chalk styling — if you find another latent instance of this same class of bug that just hasn't been hit yet (e.g. never gets exercised with an empty/placeholder-shown `TextInput` at the moment of the wait), note it, but only fix it if it's the SAME confirmed root cause — don't go on a broader hunting expedition beyond what directly follows from what you've now proven.

## When you're done

Commit on the same branch, `feat/pty-e2e-harness` (this is a fix to work already in progress on that branch, not a new branch). Give me a short summary: confirmed root cause for each of the two failures, what you changed, and the real (not assumed) verification results from both the color-forced and normal runs here.

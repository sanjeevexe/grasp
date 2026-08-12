# Grasp — Prompt 1 of 4: small UI/wording fixes

You're working in the Grasp CLI codebase (`grasp-cli`). This is the first of four
prompts that will be run in sequence, each on its own git branch, merged into
`main` only after its own tests pass. Read `grasp-project-brief.md`,
`BUILD_PLAN.md`, and `DECISIONS.md` before starting — they reflect the current
state of the project and take precedence over anything below if they've
changed since this prompt was written.

This prompt covers five small, self-contained fixes to `grasp review`'s TUI
(`src/reviewApp.tsx`) found during real dogfooding. None of them touch the
underlying data model, generation logic, or CLI command surface — text,
conditionals, and one small addition to what's rendered. Low risk, good first
step.

## 1. Make the Escape hint attempt-aware

In `src/reviewApp.tsx`, `escHint` is currently computed once, in
`QuestionScreen`:

```ts
const escHint = hasExplanation ? "[Esc] stuck? see explanation" : "[Esc] skip";
```

This is wrong on the retry attempt: once a phase has already used its one
explain-then-retry cycle (`conceptRetryOffered`/`instanceRetryOffered` is
`true` for the currently-active phase), pressing Escape again is the terminal
decline — it skips the question outright, it does not show the explanation
again. The hint text should say so. Right now it shows the exact same
"[Esc] stuck? see explanation" wording on both the first attempt and the
retry attempt, which is misleading — a user re-reading the hint on their
second attempt has no way to know Escape now means something different.

Fix: compute `escHint` based on which phase is active AND whether that
phase's retry has already been offered, not just `hasExplanation` alone.
Concretely:
- No explanation available for this event (`!hasExplanation`, legacy row) —
  unchanged: `"[Esc] skip"`.
- Explanation available, retry not yet offered for the active phase — current
  behavior: `"[Esc] stuck? see explanation"`.
- Explanation available, retry already offered for the active phase (i.e.
  this is the retry attempt) — new: `"[Esc] skip"` (this Escape press is the
  real, terminal decline, so say so plainly).

You'll need to know which phase is active to pick the right retry-offered
flag (`conceptRetryOffered` when `phase === "concept"`,
`instanceRetryOffered` when `phase === "instance"`). Write this as a small
helper function rather than inlining a nested ternary in the JSX — keep it
readable.

## 2. Soften the explain-screen wording

Also in `src/reviewApp.tsx`, the explain screen currently reads:

```
Press any key to try again — you get one more shot at this question.
```

Change this to just:

```
Press any key to try again.
```

The "you get one more shot" framing reads as more punitive/pressuring than
intended — Grasp's whole posture is teach-don't-punish, and this line runs
against that. The retry limit is still real and still enforced (one retry
per phase, unchanged) — this is purely about how it's communicated, not a
behavior change.

## 3. Only show the scroll hint when there's actually something to scroll

The persistent hint line at the bottom of an answering phase currently
always includes `[↑/↓] scroll diff`, regardless of whether the diff even
needs scrolling:

```tsx
<Text dimColor>
  [Enter] submit   [↑/↓] scroll diff   {escHint}   (terminal: {columns}x{rows})
</Text>
```

If the whole diff already fits on screen (`lines.length <= maxDiffRows`,
i.e. `DiffView` isn't showing a "more lines above/below" indicator either
direction), the scroll hint is just noise — there's nothing to scroll to.
Only include `[↑/↓] scroll diff` in the hint line when scrolling would
actually do something (`lines.length > maxDiffRows`). Don't touch
`DiffView`'s own "more lines above/below" indicators — those are already
conditional and correct; this fix is specifically about the hint row in
`QuestionScreen`.

## 4. Add Ctrl+C as a persistent keybinding hint

Right now, nothing on screen tells the user that quitting mid-review
(Ctrl+C) is always safe — every unanswered question just stays pending,
nothing is lost, whether they're one question in or fifty. This should be
stated as plainly as the other keybindings, not buried in documentation.

Add a third hint to the same persistent hint row from #3 above, alongside
`[Enter] submit` and the Escape hint — something like `[Ctrl+C] quit
anytime`. Keep the wording short (this is a hint row, not a paragraph) but
make sure it's unambiguous that quitting doesn't lose anything. Since Ctrl+C
is a real, always-available terminal signal (not something `useInput`
intercepts or needs to specially handle), this is purely an added label, no
new keybinding logic.

Apply the same three-part hint row (submit, conditional scroll, Escape,
Ctrl+C) consistently — don't leave an inconsistent hint row on any answering
screen.

## 5. A one-time starting banner for a `grasp review` batch

Currently `grasp review` drops the user straight into the first pending
question with no overview of what they're about to go through. Add a short,
one-time banner shown once, before the first question, summarizing the size
of what's pending — e.g. total question count and how many distinct
sessions/batches they span (the same `batchCount`/session-grouping
information `App` in `src/reviewApp.tsx` already computes per-question via
`ReviewQueueItem`). This should render once, before `QuestionScreen` for the
first item ever mounts, not repeat on every question the way the per-question
`"{index + 1} of {items.length} pending"` line already does.

Use your judgment on exact wording and where in the component tree this
belongs (likely `App`, gated on `index === 0` with some one-time-render
handling, or a dedicated small banner component rendered once ahead of the
`App`/`QuestionScreen` tree) — this is a UI-only addition with more than one
reasonable implementation, so **log your choice and reasoning to
DECISIONS.md** per this project's standing instruction (see `./CLAUDE.md`)
before moving on.

## Verification

- Run `npm run build` and `npm test` — both must pass clean.
- Manually reason through (or exercise via the existing test harness if one
  covers `reviewApp.tsx`) each of the five changes above against a real
  multi-question, multi-session pending queue, and against a single-question
  queue (make sure the banner doesn't look silly for a batch of one).
- Update `TESTING_GUIDE.md` and `README.md` where they currently describe the
  old scroll-hint-always-visible behavior, the old explain-screen wording, or
  don't yet mention the starting banner or the Ctrl+C hint.
- Append a `DECISIONS.md` entry for the starting banner's placement/wording
  choice (per #5 above). The other four fixes are wording/conditional
  corrections with one clearly-right answer each — they don't need their own
  entries.

## When you're done

Commit your work with a clear, descriptive message. Then write a file named
`.grasp-prompt-status` at the repo root containing exactly one line:

```
DONE
```

If you hit something you genuinely cannot resolve — a permissions error, an
ambiguous situation with no clearly-correct resolution, anything that would
require guessing rather than reasoning — stop, leave the repo in whatever
state it's in (no need to clean up or revert), and write
`.grasp-prompt-status` containing:

```
BLOCKED: <one clear sentence on what you were doing and exactly what stopped you>
```

Do not attempt increasingly risky workarounds on your own. A clear, honest
`BLOCKED` status is the correct outcome if you're genuinely stuck — it's
being run unattended overnight, so there's no one to ask a clarifying
question in the moment.

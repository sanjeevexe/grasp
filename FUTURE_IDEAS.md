# Grasp — Future Ideas (Not v1)

This is a running list of ideas discussed and deliberately set aside — not because
they're bad ideas, but because they don't have enough evidence of real need yet,
or the implementation cost doesn't clearly pay for itself at this stage. Same
posture the brief itself takes toward its own deferred table (§4): revisit if
real usage/dogfooding actually demands it, don't build ahead of evidence.

---

## 1. User self-grading + a mastery dashboard

A lightweight, non-AI self-rating step after answering ("did you think you got
this right?"), feeding into some kind of dashboard/summary view of mastery
across concepts over time. Would also include flagging whether a given answer
came after the user saw the concept explanation (pressed Escape once) before
finally answering — that flag was originally proposed on its own, but its real
value only shows up once there's something to consume it (a dashboard, or a
finer-grained export), so it's bundled into this same future item rather than
built in isolation now.

Why rejected: design flaw, not difficulty. Adds real, permanent friction to
every question (not just the ones someone's actually stuck on), and risks
overselling what a few self-graded answers can actually tell someone about
real mastery of a concept — misleading the user about their own
understanding is a worse outcome than not measuring it at all.

## 2. Per-question difficulty (wording/depth), separate from concept selection

`grasp set mode --easy/--hard` (being built now) only affects *which concept*
gets selected when a diff offers more than one candidate. This item is the
different, bigger idea: adjusting how deeply/rigorously the *chosen* concept's
own question is written.

Why rejected: design flaw, not difficulty. Doing this breaks a real
invariant the export feature depends on — a given concept tag's question
currently means roughly the same thing for everyone, every time, which is
what makes it sensible to export to Anki. If depth varies by mode, "mastered
X" stops meaning something consistent across people (or even for the same
person if they change their own mode over time), which undermines the
export path's value more than the difficulty feature adds.

## 3. Configurable or AI-decided question count per concept tag

Letting a concept warrant more than one concept/instance pair — either by
letting the user configure a target count (local + global, similar to
`grasp set mode`) or letting the model decide based on how complex a concept
seems the first time it's introduced.

Why rejected: implementation difficulty, not a design flaw — the idea itself
is sound. Real, substantial cost concentrated in two places — the `events`
schema would need a genuine one-to-many restructuring (a new child table,
not more flat columns), and `grasp review`'s UI state machine (currently two
hardcoded slots — concept and instance — not a loop over a list) would need
a real refactor to support N questions per event instead of a fixed two. Not
a quick add. Current mitigation: better/more specific concept-tag
granularity from the model can organically provide some of this depth over
time already, for free, without any of this cost — worth observing whether
that alone is good enough before committing to the bigger build.

## 4. Free navigation between pending questions (left/right, without resolving)

Letting a user jump to the next/previous pending question on demand, without
answering or skipping the one they're currently on.

Why rejected: design flaw, not difficulty. This would have been the one
truly zero-engagement way to bypass a question entirely — no answer, no
decline, no explanation shown, nothing recorded. That directly undermines
"never make skipping free," which every other part of the skip/decline
design (the explain-then-retry flow, the removal of a separate immediate
skip key) is built around protecting. The underlying want — moving through
a batch efficiently — is already served by the explain-then-retry decline
path, without the zero-cost loophole.

## 5. A separate, immediate skip key (bypassing the explain-then-retry flow)

A single keypress to skip a question outright, with no explanation shown
and no retry offered — restoring the pre-this-feature "one keypress skips"
behavior alongside the newer explain-then-retry flow.

Why rejected: design flaw, not difficulty. `grasp review` is opt-in to begin
with — nobody is forced into a review session, so "I don't have time for
this" is already served, for free, by just not running the command (or
quitting mid-session; nothing pending is ever lost). The remaining case —
deliberately sitting down to review, then wanting to blow past a specific
question with zero engagement — isn't a strong enough case to justify a
second, lower-friction bypass alongside the one that already exists.

## 6. Re-attempting already-answered questions (`grasp review --past`)

Letting a user pull up a question they already answered or skipped and go
through the same answer-field-then-reveal flow again, purely for their own
practice.

Why rejected: implementation difficulty, not a design flaw. A read-only
version (just browse past questions and their sample answers) would be
cheap — it doesn't touch the `answer_instance IS NULL` pending definition
at all. But keeping the real retry flow means the redo's answer needs
somewhere to live without overwriting the original stored answer, which
other things (export, this new answer-history export) read as *the*
answer for that event. That's the same one-to-many schema restructuring
already flagged and set aside in item 3 — same real cost, not a new one.

## 7. A failsafe cap on the answered-concept-tags list sent to the judge

Every background generation call includes the full list of every concept
tag ever answered, globally, with no limit — this is intentional (any
trimming risks re-asking something already mastered, since the judge only
knows what to avoid asking by seeing the complete list). The idea here
would be some automatic safeguard for a hypothetical very-heavy,
long-term user whose list grows large enough to matter — e.g. Grasp
noticing the list has crossed some size and recommending the user clear
their history, or erroring instead of sending an unreasonably large
prompt.

Why rejected: not worth building now. Even a large, multi-year list of
distinct tags is only a few thousand tokens — genuinely small for a
modern model and unlikely to meaningfully affect latency or cost on its
own. `grasp reset history` already gives a manual way out if it ever did
become a real problem. Worth revisiting only if real usage actually shows
this mattering.

---

*(Add new entries above this line as more ideas come up and get set aside.)*

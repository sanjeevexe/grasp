# Grasp — What to Test This Week

This is your personal checklist for the "actually use it for a week" step. The whole point of this step (per the original project brief) is simple: **if you turn Grasp off during real work, that's the strongest signal something's wrong with it.** So the main test isn't on this list at all — it's just using Claude Code normally and noticing whether Grasp survives contact with real work.

Everything below is there to help you notice specific things, in plain terms, without needing to know how any of it works under the hood.

---

## 0. One-time setup

- [ ] Install Grasp: `npm install`, `npm run build`, `npm link` from the project folder.
- [ ] Check `grasp --version` prints something.
- [ ] In a real repo you actually work in, run `grasp init`. Before it writes anything, it should show you exactly what it's about to add and explain — in plain language — that generating questions uses your existing Claude account (your subscription or your API billing, not some hidden third thing). **Read that message once for real.** Then say yes.
- [ ] Confirm it created a `.claude/settings.local.json` file with Grasp's entries in it, and that running `grasp init` again doesn't duplicate anything.

## 1. Does it actually notice real work?

Just use Claude Code normally for a task. Afterward:

- [ ] Did a real, meaningful change (not a one-line tweak) get turned into a question? Check by running `grasp review`.
- [ ] Did a trivial change (fixing a typo, a one-line import fix) get correctly ignored — no question generated about it?
- [ ] Did an update to `package-lock.json` or similar generated files get correctly ignored?
- [ ] If you made a purely cosmetic change (reformatting, reindenting, no logic change), was it correctly ignored?

## 2. Are the questions actually good?

This is the most important, least mechanical thing to judge — nothing below is a pass/fail script, it's your own judgment call each time.

- [ ] Read each question you get. Does the first question actually teach you something general and useful (a concept), separate from your specific code?
- [ ] Does the second question clearly build on the first one — does knowing the answer to question 1 actually help you answer question 2?
- [ ] If you already clearly know a concept, does Grasp eventually stop re-asking you about it (across different projects too, not just the one you first learned it in)? This might take a few repeats of the same concept to notice.
- [ ] Do you ever get a question about something that isn't really "AI-agent work" at all — like a question about Grasp's own settings file, or something unrelated to what Claude Code actually did? (This was a real bug found and fixed before you started — worth double-checking it stays fixed.)

## 3. Answering and skipping

- [ ] Run `grasp review`. Confirm it shows you the actual code change alongside the question, in a way you can read clearly.
- [ ] Type a real answer and press Enter. Go check — did it actually save? (You can look in the SQLite database directly if curious: `sqlite3 ~/.grasp/history.db "select answer_concept, answer_instance from events order by id desc limit 1;"`)
- [ ] Try to skip a question by doing nothing for a few seconds. Confirm nothing happens automatically — it should never disappear on its own.
- [ ] Now actually skip one on purpose (press Escape). Confirm it required you to actually press a key — it shouldn't feel accidental or free.
- [ ] If you get a batch of several questions at once (e.g. after a long task), does working through them feel coherent — like one related batch — rather than a random jumbled list?

## 4. The "nudge" vs. the "hard stop"

Grasp defaults to a gentle reminder, not a hard block. Try both:

- [ ] Leave it on default settings. After Claude Code finishes a task with a real pending question, do you see a short message telling you a question is waiting?
- [ ] Turn on hard-gate mode (edit `~/.grasp/config.json` or a repo's `.grasp.json`, set `"gateMode": "hard"`). With a question still unanswered, try to get Claude Code to do more work in that same session. Confirm it actually refuses until you go answer or skip via `grasp review`.
- [ ] After answering/skipping, confirm Claude Code is immediately un-blocked again.
- [ ] Switch back to `"soft"` and confirm the blocking goes away.
- [ ] Confirm hard-gate only ever blocks based on *today's* unanswered questions from *that specific session* — an old question from a different day or different project shouldn't reach in and block unrelated work.

## 5. Cost and spend

- [ ] After a session where at least one question was generated, look for a spend total in the message Claude Code shows you (something like "$0.0043 spent generating comprehension questions this session so far").
- [ ] Confirm you're not shown a spend message on a quiet turn where nothing was generated (e.g. Claude Code just reading files, no real question produced) — it should stay quiet rather than showing "$0.00" every time.
- [ ] Lower the cost cap way down (`"costCapUsd": 0.01` in config) and confirm that once you hit it, Grasp actually stops generating new questions for that session rather than quietly going over.
- [ ] Similarly, lower `"questionsPerSessionCap"` to something small (like 2) and confirm generation stops once you hit that many real questions in one sitting.

## 6. Ignoring stuff you don't want questions about

- [ ] Add a folder or filename to `"ignorePatterns"` in a repo's `.grasp.json` (e.g. a `scripts/` folder you don't care about). Touch a file there and confirm no question gets generated about it.
- [ ] Confirm that ignore rule only applies in that one repo, not everywhere.

## 7. What happens when things go wrong

You don't need to force these, but if any of them happen naturally during the week, take note:

- [ ] If your Claude Code session gets interrupted or you close the terminal mid-task, does Grasp recover fine afterward (no weird errors, no stuck state)?
- [ ] If a question ever fails to generate (rare, but possible — bad network, hiccup, etc.), does everything continue normally, with no crash and no confusing error message in your way?

## 8. The big-picture question

At the end of the week, answer honestly:

- [ ] Did you keep Grasp turned on the whole time, or did you disable it at some point during real work?
- [ ] If you disabled it — why? (Too naggy? Questions felt pointless? Got in the way at a bad moment? Something broke?)
- [ ] Do you feel like you understood your codebase better this week than you would have without it?
- [ ] Is there a moment you specifically remember Grasp catching something you would have otherwise skimmed past?

---

## Known limitations (so you don't mistake these for bugs)

- **Claude Code only.** No support for other AI coding tools yet.
- **`grasp review` is manual.** Nothing pops up on its own — you have to run the command yourself. (An "always watching" version may come later if this manual version proves annoying enough.)
- **No answer grading.** Grasp never tells you if your answer was "right" — the value is in making you write an answer at all, not in being scored.
- **One way to generate questions, no backup plan.** If the underlying call fails, times out, or hits your cost/question cap, Grasp just skips that one question and quietly logs why — it doesn't try a second method.
- **`cap_reached` doesn't say which cap fired.** The cost cap and the question cap both log the same `miss_reason`, so telling them apart afterward means comparing that session's own spend/question totals against its configured caps rather than reading it off in one field.

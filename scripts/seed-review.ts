/**
 * Seeds a throwaway database with hand-written questions so the review UX can be
 * driven by hand before capture exists.  GOVERNED BY: §23 stage 4
 *
 * Writes into a throwaway HOME so trying the UI cannot touch real state, and
 * prints the exact command to run against it. Redirecting HOME rather than
 * adding a database flag keeps the CLI surface exactly what §17 lists.
 *
 *   npm run seed:review
 *   HOME=<printed dir> node dist/cli/index.js review --all
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase } from "../src/storage/db.js";
import { insertProject } from "../src/storage/models/projects.js";
import { insertQuestion } from "../src/storage/models/questions.js";
import { setTier } from "../src/storage/models/concepts.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "grasp-demo-home-"));
const file = path.join(home, ".grasp", "history.db");
const db = openDatabase({ file });
const projectId = insertProject(db, process.cwd()).id;

// A brand-new concept: teaching card shows up front (§10.2).
insertQuestion(db, {
  project_id: projectId,
  type: "trace",
  concept_tag: "debouncing",
  origin: "live",
  question_text:
    "If `query` changes three times within 300ms, how many times does `setDebounced` actually get called, and why?",
  sample_answer:
    "Once. Each change clears the previous timer before starting a new one, so only the last timer survives the quiet period and fires.",
  teaching_card_text:
    "Debouncing delays an action until input stops arriving — so a search box does not fire a request on every keystroke. The timer restarts on each new input, and only a gap long enough to outlast the delay lets it run.",
  teaching_card_deeper:
    "Throttling is the neighbouring idea: it runs at most once per interval regardless of how input arrives, where debouncing runs once after input settles.",
  hint: "Look at what happens to the previous timer each time the effect re-runs.",
  scaffold: [
    "What does the cleanup function return by the effect actually do?",
    "When does React run that cleanup relative to the next effect?",
    "So how many timers are alive at any moment?",
  ],
  code_snippet: [
    "useEffect(() => {",
    "  const timer = setTimeout(() => setDebounced(query), delay);",
    "  return () => clearTimeout(timer);",
    "}, [query, delay]);",
  ].join("\n"),
  files: ["src/hooks/useDebouncedSearch.ts"],
});

// A known concept at predict_break: no card up front, still reachable with [e].
setTier(db, "cache-invalidation", "trace", new Date().toISOString());
insertQuestion(db, {
  project_id: projectId,
  type: "predict_break",
  concept_tag: "cache-invalidation",
  origin: "live",
  question_text:
    "The cache key is built from the user id alone. What breaks the first time a user switches workspace without logging out?",
  sample_answer:
    "They keep seeing the previous workspace's data: the key does not vary with workspace, so the cached entry is still considered a hit. It resolves only when the entry expires or the user signs out, which is exactly the window where the bug looks intermittent.",
  teaching_card_text:
    "A cache key has to name everything the cached value depends on. Leave one input out and you get a hit that is technically valid for the key but wrong for the request.",
  hint: "Ask what inputs the cached value actually depends on, then compare that list to what the key contains.",
  scaffold: [
    "What does the cached value depend on, beyond the user?",
    "Which of those appear in the key?",
    "What does a lookup return when a dependency changed but the key did not?",
  ],
  code_snippet: "const key = `user:${userId}`;\nconst cached = await redis.get(key);",
  files: ["src/cache/workspaceCache.ts"],
});

// Reconstruct: the code stays hidden until the answer is in (§10.1, §14.4).
setTier(db, "optimistic-updates", "predict_break", new Date().toISOString());
insertQuestion(db, {
  project_id: projectId,
  type: "reconstruct",
  concept_tag: "optimistic-updates",
  origin: "live",
  question_text:
    "The UI has to show a new comment the instant someone posts it, before the server confirms, and end up consistent whether the request succeeds or fails. Before looking at the code: describe the approach you would take, and what happens in each of those two outcomes.",
  sample_answer:
    "Append the comment to local state immediately with a temporary id, fire the request, and reconcile on the response: on success replace the temporary entry with the server's version, on failure remove it and surface the error. The state has to be able to distinguish confirmed from unconfirmed entries, or a retry duplicates the comment.",
  hint: "Think about what the UI must be able to undo, and how it tells a confirmed row from an unconfirmed one.",
  scaffold: [
    "What does the user need to see before the network call finishes?",
    "If the request fails, what has to be true about the state you already changed?",
    "How would you tell a confirmed item from one still in flight?",
  ],
  code_snippet:
    'setComments((prev) => [...prev, { ...draft, id: tempId, pending: true }]);\ntry {\n  const saved = await api.post(draft);\n  setComments((prev) => prev.map((c) => (c.id === tempId ? saved : c)));\n} catch (error) {\n  setComments((prev) => prev.filter((c) => c.id !== tempId));\n  toast.error("Could not post comment");\n}',
  files: ["src/components/CommentList.tsx"],
});

closeDatabase(db);

process.stdout.write(
  [
    "Seeded 3 questions (trace + teaching card, predict_break, reconstruct).",
    "",
    "Run the review UI against them:",
    "",
    `  HOME=${home} node dist/cli/index.js review --all`,
    "",
    "Commands are Ctrl+letter and fire on the keypress — no Enter:",
    "  Ctrl+T hint · Ctrl+E explain · Ctrl+R deeper · Ctrl+K break it down",
    "  Ctrl+N skip · Ctrl+C quit",
    "  1 / 2 / 3 at the self-assessment prompt",
    "",
    "Enter submits your answer. Alt+Enter adds a line.",
    "Bare letters are always text, so any answer types normally.",
    "If a key does nothing, something upstream claimed it — rebind with",
    "  grasp set review.keys.hint ctrl+y",
    "Nothing is graded.",
    "",
  ].join("\n"),
);

import * as React from "react";
import { loadInk } from "./inkLoader";
import { resolveRepoRoot } from "./git";
import { createReviewApp, ReviewQueueItem } from "./reviewApp";
import { EventRecord } from "./types";
import { getPendingQuestions, markConceptAnswered, markEventSkipped, markInstanceAnswered, openStore } from "./store";

/**
 * Groups pending events into batches by `session_id` — same session's
 * questions stay adjacent — while preserving each session-group's overall
 * chronological position (the earliest-timestamped question in a session
 * decides where that whole group falls relative to other sessions). Within
 * a group, order is oldest-first, inherited directly from `events` already
 * being timestamp-ASC (see `getPendingQuestions`) — no re-sort needed
 * there. Events with no `session_id` (e.g. `debug:seed` rows) each form
 * their own singleton group rather than being merged together, since they
 * have no real session relationship to one another. See DECISIONS.md's
 * "grasp review batch ordering/grouping" entry. Exported (not just used
 * internally) so `grasp scan` can reuse it unmodified for its own batch
 * presentation — a scan run's synthetic session_id groups just as correctly
 * as a real Claude Code one, since this function makes no assumption about
 * which kind of session produced a group. See DECISIONS.md's "grasp scan:
 * presentation model" entry.
 */
export function groupForBatchPresentation(events: EventRecord[]): ReviewQueueItem[] {
  const order: string[] = [];
  const groups = new Map<string, EventRecord[]>();
  for (const event of events) {
    const key = event.sessionId ?? `__no_session_${event.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(event);
  }

  const items: ReviewQueueItem[] = [];
  order.forEach((key, groupIndex) => {
    const groupEvents = groups.get(key)!;
    groupEvents.forEach((event, positionInGroup) => {
      items.push({
        event,
        sessionPosition: positionInGroup + 1,
        sessionSize: groupEvents.length,
        batchIndex: groupIndex + 1,
        batchCount: order.length,
      });
    });
  });
  return items;
}

/**
 * `grasp review` — the one place in the codebase with genuine terminal
 * access (see DECISIONS.md's TTY-access finding). Defaults to only the
 * current repo's pending questions (resolved the same way `grasp init`/the
 * hooks resolve repo root — see `resolveRepoRoot`); `--all` bypasses that
 * filter for the full cross-repo batch. See DECISIONS.md's "grasp review
 * defaults to the current repo" entry (supersedes the earlier "query scope:
 * global" entry) for why. Groups/orders whatever list it ends up with into
 * a coherent batch (Phase 8), renders them one at a time via ink, and
 * writes answers/skips straight back to the store.
 */
export async function runReview(options: { all?: boolean } = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "grasp review needs an interactive terminal (stdin is not a TTY) — run it directly in a terminal, not piped or scripted.\n"
    );
    process.exitCode = 1;
    return;
  }

  const db = openStore();
  const repoRoot = resolveRepoRoot(process.cwd());
  // Always source: "diff" — grasp scan's own questions are strictly its own
  // command's concern (see DECISIONS.md's "grasp scan: presentation model"
  // entry). The underlying storage stays fully shared; this only narrows
  // what THIS command's own query surfaces.
  const pending = options.all
    ? getPendingQuestions(db, undefined, "diff")
    : getPendingQuestions(db, repoRoot, "diff");

  if (pending.length === 0) {
    if (!options.all) {
      const elsewhereCount = getPendingQuestions(db, undefined, "diff").length;
      if (elsewhereCount > 0) {
        process.stdout.write(
          `No pending questions for this repo. ${elsewhereCount} question${elsewhereCount === 1 ? "" : "s"} pending in other repos — run \`grasp review --all\` to see them.\n`
        );
        db.close();
        return;
      }
    }
    process.stdout.write("No pending questions — you're caught up.\n");
    db.close();
    return;
  }

  const items = groupForBatchPresentation(pending);

  // Cross-hint (§5): point at `grasp scan` if it has unresolved work of its
  // own for this repo — same "one-line pointer, only when count > 0" pattern
  // as the "pending elsewhere" message above, just filtered by source
  // instead of repo. Always repo-scoped (not affected by --all) since scan
  // has no cross-repo concept to begin with.
  const scanPendingCount = getPendingQuestions(db, repoRoot, "scan").length;
  const crossSourceHint =
    scanPendingCount > 0
      ? `→ ${scanPendingCount} scan question${scanPendingCount === 1 ? "" : "s"} also pending — run \`grasp scan\` to continue.`
      : null;

  const { ink, TextInput } = await loadInk();
  const App = createReviewApp({ ink, TextInput });

  const instance = ink.render(
    React.createElement(App, {
      items,
      crossSourceHint,
      // The concept and instance phases each resolve independently now
      // (see reviewApp.tsx's "grasp review: explain-then-retry skip flow"
      // comment) — a real concept answer is persisted as soon as it's
      // known, regardless of what the instance phase goes on to do.
      // instanceAnswer === null is what makes the whole event a skip,
      // since the instance phase is always the last one.
      onResolved: (eventId: number, outcome: { conceptAnswer: string | null; instanceAnswer: string | null }) => {
        if (outcome.conceptAnswer !== null) {
          markConceptAnswered(db, eventId, outcome.conceptAnswer);
        }
        if (outcome.instanceAnswer !== null) {
          markInstanceAnswered(db, eventId, outcome.instanceAnswer);
        } else {
          markEventSkipped(db, eventId);
        }
      },
    })
  );

  await instance.waitUntilExit();
  db.close();
}

import * as React from "react";
import { loadInk } from "./inkLoader";
import { createReviewApp, ReviewQueueItem } from "./reviewApp";
import { EventRecord } from "./types";
import { getPendingQuestions, markEventAnswered, markEventSkipped, openStore } from "./store";

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
 * "grasp review batch ordering/grouping" entry.
 */
function groupForBatchPresentation(events: EventRecord[]): ReviewQueueItem[] {
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
 * access (see DECISIONS.md's TTY-access finding). Queries pending
 * questions globally across all repos (see the "grasp review query scope"
 * entry), groups/orders them into a coherent batch (Phase 8), renders them
 * one at a time via ink, and writes answers/skips straight back to the
 * store.
 */
export async function runReview(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "grasp review needs an interactive terminal (stdin is not a TTY) — run it directly in a terminal, not piped or scripted.\n"
    );
    process.exitCode = 1;
    return;
  }

  const db = openStore();
  const pending = getPendingQuestions(db);

  if (pending.length === 0) {
    process.stdout.write("No pending questions — you're caught up.\n");
    db.close();
    return;
  }

  const items = groupForBatchPresentation(pending);

  const { ink, TextInput } = await loadInk();
  const App = createReviewApp({ ink, TextInput });

  const instance = ink.render(
    React.createElement(App, {
      items,
      onAnswer: (eventId: number, answers: { answerConcept: string | null; answerInstance: string | null }) => {
        markEventAnswered(db, eventId, answers);
      },
      onSkip: (eventId: number, skipReason: string | null) => {
        markEventSkipped(db, eventId, skipReason);
      },
    })
  );

  await instance.waitUntilExit();
  db.close();
}

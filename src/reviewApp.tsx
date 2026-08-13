import * as React from "react";
import type { InkModules } from "./inkLoader";
import type { DiffFile } from "./adapters/agentAdapter";
import type { EventRecord } from "./types";

const { useState, useEffect, useCallback } = React;

/**
 * `grasp review`'s TUI, built as a factory over the dynamically-loaded ink
 * module (see inkLoader.ts) rather than importing `ink`'s components as
 * module-level values — JSX only needs `Box`/`Text`/etc. to be identifiers
 * in *scope*, not module-top-level imports, so closing over them here
 * works exactly like a normal import would from React's perspective.
 */

/**
 * The final disposition of one event's whole `grasp review` pass — both
 * fields independently null-or-real, since the concept and instance phases
 * can now each resolve on their own (see the "grasp review: explain-then-
 * retry skip flow" DECISIONS.md entry). `instanceAnswer === null` is what
 * makes the whole event a skip (instance is always the last phase); a real
 * `conceptAnswer` can still be present even then, if the concept phase was
 * separately answered for real before the instance phase was declined.
 */
export interface ReviewOutcome {
  conceptAnswer: string | null;
  instanceAnswer: string | null;
}

/**
 * One pending question plus its position within the Phase 8 batch grouping
 * (see review.ts's `groupForBatchPresentation`) — same session's questions
 * stay adjacent and this carries enough to render that context ("2 of 3 in
 * this session's batch") without the component needing to recompute
 * grouping itself.
 */
export interface ReviewQueueItem {
  event: EventRecord;
  sessionPosition: number;
  sessionSize: number;
  batchIndex: number;
  batchCount: number;
}

export interface ReviewAppProps {
  items: ReviewQueueItem[];
  /** Called exactly once per event, when its `grasp review` pass concludes — see `ReviewOutcome`'s own comment for what each field means. */
  onResolved: (eventId: number, outcome: ReviewOutcome) => void;
  /**
   * A one-line pointer to the OTHER source's command, shown on the last
   * question of this batch when there's unresolved work waiting there — e.g.
   * `grasp review`'s last question hints at `grasp scan` when scan questions
   * are pending, and vice versa. Computed once, upfront, by the caller
   * (review.ts / scan.ts already own all DB access for this flow; this
   * component has none) — null/omitted shows nothing. See DECISIONS.md's
   * "grasp scan: presentation model" entry.
   */
  crossSourceHint?: string | null;
}

export interface RenderLine {
  text: string;
  kind: "file" | "hunk" | "add" | "del" | "context";
}

/**
 * Hard-wraps `text` into chunks no longer than `width` characters. Used
 * instead of relying on ink's own `<Text wrap="wrap">` so that each wrapped
 * chunk becomes its own entry in the flattened `RenderLine[]` array — that
 * keeps the up/down scroll pagination (which counts array entries, one per
 * terminal row) accurate. See DECISIONS.md's "Review diff view: line
 * wrapping instead of truncation" entry for why this replaced
 * `wrap="truncate-end"`.
 */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0 || text.length === 0) return [text];
  if (text.length <= width) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    chunks.push(text.slice(i, i + width));
  }
  return chunks;
}

export function flattenDiffFiles(files: DiffFile[], width: number): RenderLine[] {
  const lines: RenderLine[] = [];
  const pushWrapped = (text: string, kind: RenderLine["kind"]) => {
    for (const chunk of wrapLine(text.length > 0 ? text : " ", width)) {
      lines.push({ text: chunk, kind });
    }
  };
  for (const file of files) {
    const label = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
    pushWrapped(`${file.status.toUpperCase()}  ${label}  (+${file.insertions}/-${file.deletions})`, "file");
    for (const hunk of file.hunks) {
      pushWrapped(hunk.header, "hunk");
      for (const l of hunk.lines) {
        const kind: RenderLine["kind"] = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "context";
        pushWrapped(l, kind);
      }
    }
  }
  return lines;
}

/**
 * Renders a `grasp scan` instance question's cited excerpt (§4) — a
 * DiffFile can't express "an excerpt of unchanged, existing code" (its
 * whole shape is "what changed"), so this is a small, separate sibling to
 * `flattenDiffFiles` rather than shoehorning the excerpt into that type.
 * Reuses the same `wrapLine`/`RenderLine` machinery, so it renders through
 * the identical `DiffView` component. `excerpt` is already validated/
 * clamped at generation time (`computeValidatedExcerpt`, generation.ts) —
 * this function trusts it as-is; null means "nothing to show" (a concept
 * question, or a malformed/degenerate range), not an error.
 */
export function flattenScanExcerpt(
  filePath: string,
  excerpt: { startLine: number; endLine: number; lines: string[] } | null,
  width: number
): RenderLine[] {
  if (!excerpt) return [];
  const lineNoWidth = String(excerpt.endLine).length;
  const out: RenderLine[] = [];
  const pushWrapped = (text: string, kind: RenderLine["kind"]) => {
    for (const chunk of wrapLine(text.length > 0 ? text : " ", width)) {
      out.push({ text: chunk, kind });
    }
  };
  pushWrapped(`${filePath}  (lines ${excerpt.startLine}-${excerpt.endLine})`, "file");
  excerpt.lines.forEach((line, i) => {
    const lineNo = String(excerpt.startLine + i).padStart(lineNoWidth);
    pushWrapped(`${lineNo}| ${line}`, "context");
  });
  return out;
}

const LINE_COLOR: Record<RenderLine["kind"], string | undefined> = {
  file: undefined,
  hunk: "cyan",
  add: "green",
  del: "red",
  context: undefined,
};

/**
 * Six phases, not two-plus-a-generic-skip: "concept"/"instance" are the two
 * answerable questions (unchanged in spirit from before), and each gets its
 * own dedicated "-explain" (shows the shared concept explanation, offers one
 * retry) and "-reveal" (shows that question's sample answer, reached after
 * either a real answer OR a terminal decline) state, rather than a single
 * generic "skip-reason"-style phase reused across both questions. See
 * DECISIONS.md's "grasp review: explain-then-retry skip flow" entry for why
 * per-question phase names were chosen over a shared generic name: the
 * explanation/reveal content and the "which question does Escape return the
 * user to" logic both genuinely differ by which question is active, and
 * distinct names make that visible in the state itself rather than needing
 * a separate "which question" side-variable to disambiguate a shared name.
 */
type Phase = "concept" | "concept-explain" | "concept-reveal" | "instance" | "instance-explain" | "instance-reveal";

function isDisplayOnlyPhase(phase: Phase): boolean {
  return phase === "concept-explain" || phase === "concept-reveal" || phase === "instance-explain" || phase === "instance-reveal";
}

export function createReviewApp({ ink, TextInput }: InkModules) {
  const { Box, Text, useInput, useApp } = ink;

  /** Reactive terminal size — forces a re-render on resize (React state doesn't update on its own for external events). */
  function useTerminalSize() {
    const [, forceRender] = useState(0);
    useEffect(() => {
      const onResize = () => forceRender((n) => n + 1);
      process.stdout.on("resize", onResize);
      return () => {
        process.stdout.off("resize", onResize);
      };
    }, []);
    return {
      rows: process.stdout.rows || 24,
      columns: process.stdout.columns || 80,
    };
  }

  function DiffView({ lines, scrollOffset, maxRows }: { lines: RenderLine[]; scrollOffset: number; maxRows: number }) {
    const visible = lines.slice(scrollOffset, scrollOffset + maxRows);
    const hasMoreAbove = scrollOffset > 0;
    const hasMoreBelow = scrollOffset + maxRows < lines.length;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {hasMoreAbove ? <Text dimColor>↑ ({scrollOffset} more line{scrollOffset === 1 ? "" : "s"} above)</Text> : null}
        {visible.map((line, i) => (
          <Text key={scrollOffset + i} color={LINE_COLOR[line.kind]} bold={line.kind === "file"}>
            {line.text}
          </Text>
        ))}
        {hasMoreBelow ? (
          <Text dimColor>
            ↓ ({lines.length - scrollOffset - maxRows} more line{lines.length - scrollOffset - maxRows === 1 ? "" : "s"} below — ↑/↓ to scroll)
          </Text>
        ) : null}
      </Box>
    );
  }

  function QuestionScreen({
    event,
    onDone,
  }: {
    event: EventRecord;
    onDone: (result: ReviewOutcome) => void;
  }) {
    const { rows, columns } = useTerminalSize();
    // DiffView's box spends 2 columns on its round border and 2 more on
    // paddingX={1} (1 each side) — content narrower than that is what
    // actually fits without ink's own wrapping kicking in a second time.
    const diffContentWidth = Math.max(10, columns - 4);

    const hasConceptQuestion = Boolean(event.questionConcept);
    const [phase, setPhase] = useState<Phase>(hasConceptQuestion ? "concept" : "instance");
    const isConceptPhaseGroup = phase === "concept" || phase === "concept-explain" || phase === "concept-reveal";

    // A `grasp scan` row's excerpt is instance-question-specific — concept
    // questions show no excerpt at all (§4, consistent with the existing
    // concept/instance philosophy: concept questions stand apart from any
    // specific code). A diff row's own `diffFiles` is shown throughout
    // (unchanged, pre-existing behavior) — this only branches for scan.
    const lines = React.useMemo(() => {
      if (event.source === "scan") {
        if (isConceptPhaseGroup) return [];
        const excerpt =
          event.scanExcerptStartLine !== null &&
          event.scanExcerptStartLine !== undefined &&
          event.scanExcerptEndLine !== null &&
          event.scanExcerptEndLine !== undefined &&
          event.scanExcerptLines
            ? { startLine: event.scanExcerptStartLine, endLine: event.scanExcerptEndLine, lines: event.scanExcerptLines }
            : null;
        return flattenScanExcerpt(event.diffSummary ?? "", excerpt, diffContentWidth);
      }
      return flattenDiffFiles(event.diffFiles ?? [], diffContentWidth);
    }, [event, diffContentWidth, isConceptPhaseGroup]);
    const [scrollOffset, setScrollOffset] = useState(0);
    // Null until that phase concludes with a REAL answer (first attempt or
    // retry) — stays null if the phase is ultimately declined, or never
    // applicable (no concept question at all). This one nullable field is
    // both "what gets recorded" AND "was this phase answered", so no
    // separate outcome flag is needed — see resolveConceptPhase/
    // resolveInstancePhase below.
    const [conceptAnswer, setConceptAnswer] = useState<string | null>(null);
    const [instanceAnswer, setInstanceAnswer] = useState<string | null>(null);
    const [inputValue, setInputValue] = useState("");
    // True only after a real Enter-while-blank submit attempt (not just
    // "the field happens to be empty right now") — see DECISIONS.md's
    // "grasp review: immediate focus, working scroll, no premature blank
    // warning" entry for why this is tracked separately from "is the field
    // currently empty."
    const [blankSubmitAttempted, setBlankSubmitAttempted] = useState(false);
    // Whether THIS phase has already used its one Escape -> explain -> retry
    // cycle. First Escape (per phase) shows the explanation and offers a
    // retry; a second Escape on the same phase is the terminal decline. See
    // DECISIONS.md's "grasp review: explain-then-retry skip flow" entry.
    const [conceptRetryOffered, setConceptRetryOffered] = useState(false);
    const [instanceRetryOffered, setInstanceRetryOffered] = useState(false);

    // Legacy fallback (point 5): a pre-migration event has no explanation
    // text to show at all. When that's true, Escape behaves exactly like
    // the old immediate-skip design — no explain screen, no retry offered —
    // rather than showing a blank explanation. A missing sample answer is
    // handled independently, per-phase, inside resolveConceptPhase/
    // resolveInstancePhase below (skip straight to the next phase/finish
    // instead of showing an empty reveal screen).
    const hasExplanation = Boolean(event.conceptExplanation);

    const questionText =
      phase === "concept" || phase === "concept-explain" || phase === "concept-reveal"
        ? event.questionConcept
        : event.questionInstance;

    // Reserve rows for chrome around the diff box: repo/summary line, a
    // blank line, question label + text (up to 3 lines), a blank line,
    // the input/hint line, and the diff box's own border (2 rows).
    const reservedRows = 12;
    const maxDiffRows = Math.max(3, rows - reservedRows);

    // A resize (or the width-dependent rewrap above changing how many
    // wrapped rows exist) can leave a previously-valid scrollOffset past the
    // new end of the list — clamp it back in range rather than showing a
    // blank diff box.
    useEffect(() => {
      setScrollOffset((o) => Math.min(o, Math.max(0, lines.length - maxDiffRows)));
    }, [lines, maxDiffRows]);

    // Moves into the instance phase — the only phase concept ever advances
    // to, since every real question always has an instance question (see
    // EventRecord/questionType: "instance" | "both", never concept-alone).
    const enterInstancePhase = useCallback(() => {
      setPhase("instance");
      setInputValue("");
      setBlankSubmitAttempted(false);
      setScrollOffset(0);
    }, []);

    // Concludes the concept phase, whether by a real answer or a decline.
    // Shows that question's sample answer first if one exists (point 2/3);
    // a legacy event with no sample answer skips straight to the instance
    // phase instead of showing a broken/empty reveal screen (point 5).
    const resolveConceptPhase = useCallback(
      (answer: string | null) => {
        setConceptAnswer(answer);
        if (event.sampleAnswerConcept) {
          setPhase("concept-reveal");
          setScrollOffset(0);
        } else {
          enterInstancePhase();
        }
      },
      [event.sampleAnswerConcept, enterInstancePhase]
    );

    // Concludes the instance phase (always the last phase) — finishes the
    // whole event, via a reveal screen first if a sample answer exists.
    const resolveInstancePhase = useCallback(
      (answer: string | null) => {
        setInstanceAnswer(answer);
        if (event.sampleAnswerInstance) {
          setPhase("instance-reveal");
          setScrollOffset(0);
        } else {
          onDone({ conceptAnswer, instanceAnswer: answer });
        }
      },
      [event.sampleAnswerInstance, conceptAnswer, onDone]
    );

    // Always active — the answer field (TextInput, below) is focused from
    // the moment a question renders, with no separate "viewing" mode to
    // switch out of first (see DECISIONS.md's "immediate focus, working
    // scroll, no premature blank warning" entry for why that mode was
    // removed: it was the direct cause of a real "have to press Enter once
    // before typing does anything" bug). The explain/reveal screens added
    // here are new RENDER STATES of this same always-active handler, not a
    // new mode gate on the answer field itself — TextInput is still
    // unconditionally live the instant a "concept"/"instance" phase
    // renders, exactly as before; see DECISIONS.md's "grasp review:
    // explain-then-retry skip flow" entry for why this distinction matters
    // and doesn't reintroduce the bug that fix addressed.
    //
    // Wrapped in useCallback: ink's own `useInput` re-subscribes its stdin
    // listener whenever the handler function reference changes (confirmed
    // by reading node_modules/ink/build/hooks/use-input.js — the listener
    // effect's dependency array includes the handler itself). An inline
    // arrow function here would get a new reference on every keystroke's
    // resulting re-render, tearing down and re-adding the listener each
    // time — which is exactly what was silently dropping most rapid
    // scroll keypresses before the prior fix (reproduced empirically: 5
    // down-arrow presses 150ms apart registered only 2 scroll steps).
    const handleGlobalInput = useCallback(
      (_input: string, key: { escape: boolean; upArrow: boolean; downArrow: boolean }) => {
        if (isDisplayOnlyPhase(phase)) {
          // Arrow keys still scroll the diff on explain/reveal screens —
          // deliberately NOT treated as "continue" — so a user can scroll
          // back up to re-read the diff while reading an explanation or
          // sample answer, matching how scrolling already works during the
          // answering phases. See DECISIONS.md's "grasp review: explain-
          // then-retry skip flow" entry for why this was chosen over
          // treating literally every key (including arrows) as "continue."
          if (key.downArrow) {
            setScrollOffset((o) => Math.min(o + 1, Math.max(0, lines.length - maxDiffRows)));
            return;
          }
          if (key.upArrow) {
            setScrollOffset((o) => Math.max(0, o - 1));
            return;
          }
          // Any other key — including Enter and Escape — continues past a
          // "press any key to continue" screen.
          if (phase === "concept-explain") {
            setPhase("concept");
            setInputValue("");
            setBlankSubmitAttempted(false);
            return;
          }
          if (phase === "instance-explain") {
            setPhase("instance");
            setInputValue("");
            setBlankSubmitAttempted(false);
            return;
          }
          if (phase === "concept-reveal") {
            enterInstancePhase();
            return;
          }
          // phase === "instance-reveal"
          onDone({ conceptAnswer, instanceAnswer });
          return;
        }

        // phase is "concept" or "instance" (answering).
        if (key.escape) {
          if (phase === "concept") {
            if (!hasExplanation) {
              // Legacy fallback: no explanation to show, so Escape behaves
              // exactly like the old immediate-skip design — no retry ever
              // offered for this event.
              resolveConceptPhase(null);
              return;
            }
            if (!conceptRetryOffered) {
              setConceptRetryOffered(true);
              setPhase("concept-explain");
              setScrollOffset(0);
              return;
            }
            // Already retried once and declined again — terminal decline.
            resolveConceptPhase(null);
            return;
          }
          // phase === "instance"
          if (!hasExplanation) {
            resolveInstancePhase(null);
            return;
          }
          if (!instanceRetryOffered) {
            setInstanceRetryOffered(true);
            setPhase("instance-explain");
            setScrollOffset(0);
            return;
          }
          resolveInstancePhase(null);
          return;
        }
        if (key.downArrow) {
          setScrollOffset((o) => Math.min(o + 1, Math.max(0, lines.length - maxDiffRows)));
          return;
        }
        if (key.upArrow) {
          setScrollOffset((o) => Math.max(0, o - 1));
          return;
        }
      },
      [
        phase,
        lines.length,
        maxDiffRows,
        hasExplanation,
        conceptRetryOffered,
        instanceRetryOffered,
        conceptAnswer,
        instanceAnswer,
        onDone,
        enterInstancePhase,
        resolveConceptPhase,
        resolveInstancePhase,
      ]
    );
    useInput(handleGlobalInput);

    const handleInputChange = useCallback((value: string) => {
      setInputValue(value);
      // Typing anything clears a previous rejection warning immediately —
      // it should never linger once the user has started correcting it.
      if (value.trim().length > 0) setBlankSubmitAttempted(false);
    }, []);

    const submitCurrentPhase = useCallback(
      (value: string) => {
        // A blank/whitespace-only submission is never a real answer — see
        // DECISIONS.md's "Blank-answer rejection" entry. Pressing Enter on
        // empty input simply does nothing (stays put, no state change) —
        // same behavior whether this is a first attempt or the one retry
        // attempt after an explanation.
        if (value.trim().length === 0) {
          setBlankSubmitAttempted(true);
          return;
        }
        if (phase === "concept") {
          resolveConceptPhase(value);
          return;
        }
        // phase === "instance"
        resolveInstancePhase(value);
      },
      [phase, resolveConceptPhase, resolveInstancePhase]
    );

    const isAnsweringPhase = phase === "concept" || phase === "instance";
    const showBlankWarning = isAnsweringPhase && blankSubmitAttempted && inputValue.trim().length === 0;
    // The retry-offered flag differs by active phase — see conceptRetryOffered/
    // instanceRetryOffered above. Once the active phase's retry has already been
    // offered, this Escape press is the terminal decline, not another trip to the
    // explain screen, so the hint needs to say "skip" again rather than repeating
    // the "see explanation" wording from the first attempt.
    const computeEscHint = () => {
      if (!hasExplanation) return "[Esc] skip";
      const retryOffered = phase === "concept" ? conceptRetryOffered : instanceRetryOffered;
      return retryOffered ? "[Esc] skip" : "[Esc] stuck? see explanation";
    };
    const escHint = computeEscHint();
    const showScrollHint = lines.length > maxDiffRows;

    return (
      <Box flexDirection="column">
        <Text bold>{event.repo}</Text>
        <Text dimColor>{event.diffSummary}</Text>
        {lines.length > 0 ? (
          <Box marginTop={1}>
            <DiffView lines={lines} scrollOffset={scrollOffset} maxRows={maxDiffRows} />
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text bold>
            {phase === "concept" || phase === "concept-explain" || phase === "concept-reveal" ? "Concept question:" : "Instance question:"} {questionText}
          </Text>
        </Box>
        {phase === "concept-explain" || phase === "instance-explain" ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="yellow">
              Stuck? Here's the idea behind this question:
            </Text>
            <Text>{event.conceptExplanation}</Text>
            <Box marginTop={1}>
              <Text dimColor>
                Press any key to try again.   (terminal: {columns}x{rows})
              </Text>
            </Box>
          </Box>
        ) : phase === "concept-reveal" || phase === "instance-reveal" ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="green">
              {(phase === "concept-reveal" ? conceptAnswer : instanceAnswer) !== null
                ? "Your answer was recorded. Sample answer, for comparison:"
                : "Sample answer:"}
            </Text>
            <Text>{phase === "concept-reveal" ? event.sampleAnswerConcept : event.sampleAnswerInstance}</Text>
            <Box marginTop={1}>
              <Text dimColor>Press any key to continue.   (terminal: {columns}x{rows})</Text>
            </Box>
          </Box>
        ) : (
          <Box marginTop={1} flexDirection="column">
            <TextInput
              value={inputValue}
              onChange={handleInputChange}
              onSubmit={submitCurrentPhase}
              placeholder="type your answer, Enter to submit"
            />
            {showBlankWarning ? (
              <Text color="yellow">
                A blank answer isn't accepted — type something, or press Esc {hasExplanation ? "for help" : "to skip"} instead.
              </Text>
            ) : (
              <Text dimColor>
                [Enter] submit   {showScrollHint ? "[↑/↓] scroll diff   " : ""}
                {escHint}   [Ctrl+C] quit anytime   (terminal: {columns}x{rows})
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  function StartBanner({ items }: { items: ReviewQueueItem[] }) {
    const sessionCount = new Set(items.map((item) => item.event.sessionId ?? item.batchIndex)).size;
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text bold>
          {items.length} question{items.length === 1 ? "" : "s"} pending
          {sessionCount > 1 ? ` across ${sessionCount} sessions` : ""}.
        </Text>
        <Text dimColor>Ctrl+C is always safe — anything unanswered just stays pending.</Text>
      </Box>
    );
  }

  function App({ items, onResolved, crossSourceHint }: ReviewAppProps) {
    const { exit } = useApp();
    const [index, setIndex] = useState(0);

    useEffect(() => {
      if (items.length === 0) exit();
    }, [items.length, exit]);

    const handleDone = useCallback(
      (event: EventRecord, result: ReviewOutcome) => {
        onResolved(event.id as number, result);
        setIndex((i) => {
          const next = i + 1;
          if (next >= items.length) exit();
          return next;
        });
      },
      [items.length, exit, onResolved]
    );

    if (index >= items.length) {
      return (
        <Box>
          <Text color="green">All caught up — {items.length} question{items.length === 1 ? "" : "s"} processed.</Text>
        </Box>
      );
    }

    const current = items[index];
    // Session-batch context only means anything once there's more than one
    // session in play, or more than one question within the current
    // session's own batch — a lone question from a lone session doesn't
    // need "1 of 1" noise.
    const showSessionContext = current.event.sessionId !== null && (current.sessionSize > 1 || current.batchCount > 1);
    // Shown once, alongside the LAST question in the batch (bookending
    // StartBanner's index === 0) — see ReviewAppProps.crossSourceHint's own
    // comment for why this component just displays a pre-computed string
    // rather than querying anything itself.
    const isLastQuestion = index === items.length - 1;
    return (
      <Box flexDirection="column">
        {index === 0 ? <StartBanner items={items} /> : null}
        <Text dimColor>
          {index + 1} of {items.length} pending
          {showSessionContext
            ? `  ·  session ${current.batchIndex} of ${current.batchCount} (question ${current.sessionPosition} of ${current.sessionSize} for this session)`
            : ""}
        </Text>
        {isLastQuestion && crossSourceHint ? <Text dimColor>{crossSourceHint}</Text> : null}
        <QuestionScreen
          key={current.event.id}
          event={current.event}
          onDone={(result) => handleDone(current.event, result)}
        />
      </Box>
    );
  }

  return App;
}

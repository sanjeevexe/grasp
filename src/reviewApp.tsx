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

export interface ReviewAnswers {
  answerConcept: string | null;
  answerInstance: string | null;
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
  onAnswer: (eventId: number, answers: ReviewAnswers) => void;
  onSkip: (eventId: number, skipReason: string | null) => void;
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

const LINE_COLOR: Record<RenderLine["kind"], string | undefined> = {
  file: undefined,
  hunk: "cyan",
  add: "green",
  del: "red",
  context: undefined,
};

type Phase = "concept" | "instance" | "skip-reason";

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
    onDone: (result: { type: "answered"; answers: ReviewAnswers } | { type: "skipped"; skipReason: string | null }) => void;
  }) {
    const { rows, columns } = useTerminalSize();
    // DiffView's box spends 2 columns on its round border and 2 more on
    // paddingX={1} (1 each side) — content narrower than that is what
    // actually fits without ink's own wrapping kicking in a second time.
    const diffContentWidth = Math.max(10, columns - 4);
    const lines = React.useMemo(
      () => flattenDiffFiles(event.diffFiles ?? [], diffContentWidth),
      [event, diffContentWidth]
    );
    const [scrollOffset, setScrollOffset] = useState(0);

    const hasConceptQuestion = Boolean(event.questionConcept);
    const [phase, setPhase] = useState<Phase>(hasConceptQuestion ? "concept" : "instance");
    const [conceptAnswer, setConceptAnswer] = useState("");
    const [instanceAnswer, setInstanceAnswer] = useState("");
    const [inputValue, setInputValue] = useState("");
    // True only after a real Enter-while-blank submit attempt (not just
    // "the field happens to be empty right now") — see DECISIONS.md's
    // "grasp review: immediate focus, working scroll, no premature blank
    // warning" entry for why this is tracked separately from "is the field
    // currently empty."
    const [blankSubmitAttempted, setBlankSubmitAttempted] = useState(false);

    const questionText = phase === "concept" ? event.questionConcept : phase === "instance" ? event.questionInstance : null;

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

    // Always active — the answer field (TextInput, below) is focused from
    // the moment the question renders, with no separate "viewing" mode to
    // switch out of first (see DECISIONS.md's entry for why that mode was
    // removed: it was the direct cause of a real "have to press Enter once
    // before typing does anything" bug). Up/down arrow scrolls the diff
    // concurrently with typing — safe because ink-text-input's own input
    // handling explicitly ignores up/down arrows (confirmed by reading
    // node_modules/ink-text-input/build/index.js, not assumed), so both
    // this handler and TextInput's can be active on the same keypress
    // without conflict, the same way Escape already worked below. Note
    // this means 'j'/'k' are no longer scroll shortcuts — the old
    // viewing-only mode could safely treat single letters as hotkeys since
    // no text field was ever active then, but a global handler can't
    // consume ordinary letters without breaking anyone whose answer uses
    // them.
    //
    // Wrapped in useCallback: ink's own `useInput` re-subscribes its stdin
    // listener whenever the handler function reference changes (confirmed
    // by reading node_modules/ink/build/hooks/use-input.js — the listener
    // effect's dependency array includes the handler itself). An inline
    // arrow function here would get a new reference on every keystroke's
    // resulting re-render, tearing down and re-adding the listener each
    // time — which is exactly what was silently dropping most rapid
    // scroll keypresses before this fix (reproduced empirically: 5 down-
    // arrow presses 150ms apart registered only 2 scroll steps).
    const handleGlobalInput = useCallback(
      (_input: string, key: { escape: boolean; upArrow: boolean; downArrow: boolean }) => {
        if (key.escape) {
          if (phase !== "skip-reason") {
            setPhase("skip-reason");
            setInputValue("");
            setBlankSubmitAttempted(false);
          }
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
      [phase, lines.length, maxDiffRows]
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
        // the skip-reason prompt is the one phase where blank IS a
        // legitimate submission (the reason itself is optional per brief
        // §3.1 — only the concept/instance ANSWER text must be real, not
        // the skip explanation).
        if (phase !== "skip-reason" && value.trim().length === 0) {
          setBlankSubmitAttempted(true);
          return;
        }
        if (phase === "concept") {
          setConceptAnswer(value);
          if (hasConceptQuestion && event.questionInstance) {
            setPhase("instance");
            setInputValue(instanceAnswer);
            setBlankSubmitAttempted(false);
            setScrollOffset(0);
          } else {
            onDone({ type: "answered", answers: { answerConcept: value, answerInstance: null } });
          }
          return;
        }
        if (phase === "instance") {
          onDone({
            type: "answered",
            answers: {
              answerConcept: hasConceptQuestion ? conceptAnswer : null,
              answerInstance: value,
            },
          });
          return;
        }
        // phase === "skip-reason"
        onDone({ type: "skipped", skipReason: value.trim().length > 0 ? value.trim() : null });
      },
      [phase, hasConceptQuestion, conceptAnswer, instanceAnswer, event.questionInstance, onDone]
    );

    const showBlankWarning = phase !== "skip-reason" && blankSubmitAttempted && inputValue.trim().length === 0;

    return (
      <Box flexDirection="column">
        <Text bold>{event.repo}</Text>
        <Text dimColor>{event.diffSummary}</Text>
        <Box marginTop={1}>
          <DiffView lines={lines} scrollOffset={scrollOffset} maxRows={maxDiffRows} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          {phase === "skip-reason" ? (
            <Text bold color="yellow">
              Why are you skipping? (optional)
            </Text>
          ) : (
            <Text bold>
              {phase === "concept" ? "Concept question:" : "Instance question:"} {questionText}
            </Text>
          )}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <TextInput
            value={inputValue}
            onChange={handleInputChange}
            onSubmit={submitCurrentPhase}
            placeholder={phase === "skip-reason" ? "press Enter to leave blank" : "type your answer, Enter to submit"}
          />
          {showBlankWarning ? (
            <Text color="yellow">A blank answer isn't accepted — type something, or press Esc to skip instead.</Text>
          ) : phase === "skip-reason" ? (
            <Text dimColor>[Enter] submit (blank = no reason given)   (terminal: {columns}x{rows})</Text>
          ) : (
            <Text dimColor>[Enter] submit   [↑/↓] scroll diff   [Esc] skip   (terminal: {columns}x{rows})</Text>
          )}
        </Box>
      </Box>
    );
  }

  function App({ items, onAnswer, onSkip }: ReviewAppProps) {
    const { exit } = useApp();
    const [index, setIndex] = useState(0);

    useEffect(() => {
      if (items.length === 0) exit();
    }, [items.length, exit]);

    const handleDone = useCallback(
      (
        event: EventRecord,
        result: { type: "answered"; answers: ReviewAnswers } | { type: "skipped"; skipReason: string | null }
      ) => {
        if (result.type === "answered") {
          onAnswer(event.id as number, result.answers);
        } else {
          onSkip(event.id as number, result.skipReason);
        }
        setIndex((i) => {
          const next = i + 1;
          if (next >= items.length) exit();
          return next;
        });
      },
      [items.length, exit, onAnswer, onSkip]
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
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {index + 1} of {items.length} pending
          {showSessionContext
            ? `  ·  session ${current.batchIndex} of ${current.batchCount} (question ${current.sessionPosition} of ${current.sessionSize} for this session)`
            : ""}
        </Text>
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

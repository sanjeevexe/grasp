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

interface RenderLine {
  text: string;
  kind: "file" | "hunk" | "add" | "del" | "context";
}

function flattenDiffFiles(files: DiffFile[]): RenderLine[] {
  const lines: RenderLine[] = [];
  for (const file of files) {
    const label = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
    lines.push({
      text: `${file.status.toUpperCase()}  ${label}  (+${file.insertions}/-${file.deletions})`,
      kind: "file",
    });
    for (const hunk of file.hunks) {
      lines.push({ text: hunk.header, kind: "hunk" });
      for (const l of hunk.lines) {
        const kind: RenderLine["kind"] = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "context";
        lines.push({ text: l.length > 0 ? l : " ", kind });
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
type Mode = "viewing" | "answering";

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
          <Text key={scrollOffset + i} color={LINE_COLOR[line.kind]} bold={line.kind === "file"} wrap="truncate-end">
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
    const lines = React.useMemo(() => flattenDiffFiles(event.diffFiles ?? []), [event]);
    const [scrollOffset, setScrollOffset] = useState(0);

    const hasConceptQuestion = Boolean(event.questionConcept);
    const [phase, setPhase] = useState<Phase>(hasConceptQuestion ? "concept" : "instance");
    const [mode, setMode] = useState<Mode>("viewing");
    const [conceptAnswer, setConceptAnswer] = useState("");
    const [instanceAnswer, setInstanceAnswer] = useState("");
    const [skipReasonText, setSkipReasonText] = useState("");
    const [inputValue, setInputValue] = useState("");

    const questionText = phase === "concept" ? event.questionConcept : phase === "instance" ? event.questionInstance : null;

    // Reserve rows for chrome around the diff box: repo/summary line, a
    // blank line, question label + text (up to 3 lines), a blank line,
    // the input/hint line, and the diff box's own border (2 rows).
    const reservedRows = 12;
    const maxDiffRows = Math.max(3, rows - reservedRows);

    useInput(
      (input, key) => {
        if (mode !== "viewing") return;
        if (key.escape) {
          setPhase("skip-reason");
          setMode("answering");
          setInputValue("");
          return;
        }
        if (key.return || input === "a") {
          setMode("answering");
          setInputValue(phase === "concept" ? conceptAnswer : phase === "instance" ? instanceAnswer : "");
          return;
        }
        if (key.downArrow || input === "j") {
          setScrollOffset((o) => Math.min(o + 1, Math.max(0, lines.length - maxDiffRows)));
          return;
        }
        if (key.upArrow || input === "k") {
          setScrollOffset((o) => Math.max(0, o - 1));
          return;
        }
      },
      { isActive: mode === "viewing" }
    );

    // A separate always-active listener just for Escape while answering —
    // TextInput's own input handling never consumes Escape (it's not a
    // character it inserts), so both can be active without conflict.
    useInput(
      (_input, key) => {
        if (mode === "answering" && phase !== "skip-reason" && key.escape) {
          setPhase("skip-reason");
          setInputValue("");
        }
      },
      { isActive: mode === "answering" && phase !== "skip-reason" }
    );

    const submitCurrentPhase = useCallback(
      (value: string) => {
        // A blank/whitespace-only submission is never a real answer — see
        // DECISIONS.md's "Blank-answer rejection" entry. Pressing Enter on
        // empty input during "answering" simply does nothing (stays put,
        // no state change); the skip-reason prompt is the one phase where
        // blank IS a legitimate submission (the reason itself is optional
        // per brief §3.1 — only the concept/instance ANSWER text must be
        // real, not the skip explanation).
        if (phase !== "skip-reason" && value.trim().length === 0) {
          return;
        }
        if (phase === "concept") {
          setConceptAnswer(value);
          if (hasConceptQuestion && event.questionInstance) {
            setPhase("instance");
            setMode("viewing");
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
      [phase, hasConceptQuestion, conceptAnswer, event.questionInstance, onDone]
    );

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
        <Box marginTop={1}>
          {mode === "viewing" ? (
            <Text dimColor>[Enter] or [a] to answer   [↑/↓] scroll diff   [Esc] skip</Text>
          ) : (
            <Box flexDirection="column">
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={submitCurrentPhase}
                placeholder={phase === "skip-reason" ? "press Enter to leave blank" : "type your answer, Enter to submit"}
              />
              {phase !== "skip-reason" && inputValue.trim().length === 0 ? (
                <Text color="yellow">A blank answer isn't accepted — type something, or press Esc to skip instead.</Text>
              ) : phase === "skip-reason" ? (
                <Text dimColor>[Enter] submit (blank = no reason given)   (terminal: {columns}x{rows})</Text>
              ) : (
                <Text dimColor>[Enter] submit   [Esc] skip this question   (terminal: {columns}x{rows})</Text>
              )}
            </Box>
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

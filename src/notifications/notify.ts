/**
 * OS-native notifications.  GOVERNED BY: §15, §11.3
 *
 * NO TRAY ICON, NO GUI, NO PERSISTENT WINDOW. Purely informational: clicking may
 * open nothing, and the user runs `grasp review` when they are ready.
 *
 * BATCHED per closed capture turn — "Grasp: 3 new questions", never one toast
 * per question (§15).
 *
 * SUPPRESSED NOTIFICATIONS ARE DROPPED, NOT QUEUED (§15). A burst of backlogged
 * toasts after quiet hours end is worse than silence.
 *
 * NEVER notifies about API errors, rate limiting, or daemon internals (§15), and
 * never about decay (§11.3).
 */
import path from "node:path";
import notifier from "node-notifier";

export interface NotificationSettings {
  batching: "per_turn" | "per_question";
  /** e.g. ["22:00", "08:00"], possibly spanning midnight. */
  quietHours: [string, string] | null;
  /** ISO-8601; suppress everything until then. */
  snoozeUntil: string | null;
}

export type SuppressionReason = "quiet_hours" | "snoozed" | null;

function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Handles windows that wrap past midnight, which is the common case. */
export function isWithinQuietHours(quietHours: [string, string] | null, now: Date): boolean {
  if (!quietHours) return false;
  const start = parseHhMm(quietHours[0]);
  const end = parseHhMm(quietHours[1]);
  // A malformed window must not silence Grasp forever.
  if (start === null || end === null) return false;

  const minutes = now.getHours() * 60 + now.getMinutes();
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function suppressionReason(
  settings: NotificationSettings,
  now = new Date(),
): SuppressionReason {
  if (settings.snoozeUntil) {
    const until = Date.parse(settings.snoozeUntil);
    if (!Number.isNaN(until) && now.getTime() < until) return "snoozed";
  }
  if (isWithinQuietHours(settings.quietHours, now)) return "quiet_hours";
  return null;
}

export interface Notification {
  count: number;
  projectPath: string;
}

export function renderNotification(notification: Notification): { title: string; message: string } {
  const project = path.basename(notification.projectPath);
  return {
    title:
      notification.count === 1
        ? "Grasp: 1 new question"
        : `Grasp: ${notification.count} new questions`,
    message: `in ${project} — run \`grasp review\` when you're ready`,
  };
}

export type Dispatcher = (payload: { title: string; message: string }) => void;

const defaultDispatcher: Dispatcher = (payload) => {
  notifier.notify({
    title: payload.title,
    message: payload.message,
    // Informational only: must not block, interrupt modally, or steal focus.
    sound: false,
    wait: false,
  });
};

export interface NotifyDeps {
  dispatch?: Dispatcher;
  now?: Date;
}

/**
 * Returns what happened, so the daemon can log it (§16.1) — the return value is
 * the only observable effect besides the toast itself.
 */
export function notifyNewQuestions(
  notification: Notification,
  settings: NotificationSettings,
  deps: NotifyDeps = {},
): { sent: boolean; suppressed: SuppressionReason } {
  if (notification.count <= 0) return { sent: false, suppressed: null };

  const suppressed = suppressionReason(settings, deps.now ?? new Date());
  if (suppressed) return { sent: false, suppressed };

  try {
    (deps.dispatch ?? defaultDispatcher)(renderNotification(notification));
    return { sent: true, suppressed: null };
  } catch {
    // §15 — a failed toast must NEVER affect capture. Swallow it entirely.
    return { sent: false, suppressed: null };
  }
}

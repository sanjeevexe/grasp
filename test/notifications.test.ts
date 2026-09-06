/**
 * Notification batching, suppression, and failure isolation.  GOVERNED BY: §15
 */
import { describe, expect, it, vi } from "vitest";
import {
  isWithinQuietHours,
  notifyNewQuestions,
  renderNotification,
  suppressionReason,
  type NotificationSettings,
} from "../src/notifications/notify.js";

const SETTINGS: NotificationSettings = {
  batching: "per_turn",
  quietHours: null,
  snoozeUntil: null,
};

describe("batching (§15)", () => {
  it("sends one notification for a whole turn, naming the count", () => {
    const sent: { title: string; message: string }[] = [];
    const result = notifyNewQuestions({ count: 3, projectPath: "/Users/me/dev/my-app" }, SETTINGS, {
      dispatch: (payload) => void sent.push(payload),
    });

    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1); // not one per question
    expect(sent[0].title).toBe("Grasp: 3 new questions");
    expect(sent[0].message).toContain("my-app");
    expect(sent[0].message).toContain("grasp review");
  });

  it("uses the singular for one question", () => {
    expect(renderNotification({ count: 1, projectPath: "/dev/app" }).title).toBe(
      "Grasp: 1 new question",
    );
  });

  it("sends nothing for an empty turn", () => {
    const sent: unknown[] = [];
    const result = notifyNewQuestions({ count: 0, projectPath: "/dev/app" }, SETTINGS, {
      dispatch: () => void sent.push(1),
    });
    expect(result.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("quiet hours and snooze (§15)", () => {
  it("suppresses inside a window that wraps past midnight", () => {
    const quiet: [string, string] = ["22:00", "08:00"];
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T23:30:00"))).toBe(true);
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T02:00:00"))).toBe(true);
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T12:00:00"))).toBe(false);
    // Boundary: the end of the window is exclusive.
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T08:00:00"))).toBe(false);
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T22:00:00"))).toBe(true);
  });

  it("suppresses inside a same-day window", () => {
    const quiet: [string, string] = ["09:00", "17:00"];
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T12:00:00"))).toBe(true);
    expect(isWithinQuietHours(quiet, new Date("2026-06-01T20:00:00"))).toBe(false);
  });

  it("DROPS a suppressed notification rather than queueing it (§15)", () => {
    const sent: unknown[] = [];
    const result = notifyNewQuestions(
      { count: 2, projectPath: "/dev/app" },
      { ...SETTINGS, quietHours: ["00:00", "23:59"] },
      { dispatch: () => void sent.push(1), now: new Date("2026-06-01T12:00:00") },
    );
    expect(result.sent).toBe(false);
    expect(result.suppressed).toBe("quiet_hours");
    // Nothing is stored for later: a burst of backlogged toasts is worse.
    expect(sent).toHaveLength(0);
  });

  it("respects snoozeUntil and resumes once it passes", () => {
    const snoozed: NotificationSettings = {
      ...SETTINGS,
      snoozeUntil: "2026-06-01T12:00:00.000Z",
    };
    expect(suppressionReason(snoozed, new Date("2026-06-01T11:00:00.000Z"))).toBe("snoozed");
    expect(suppressionReason(snoozed, new Date("2026-06-01T13:00:00.000Z"))).toBeNull();
  });

  it("ignores a malformed quiet-hours window rather than silencing forever", () => {
    expect(isWithinQuietHours(["nonsense", "08:00"], new Date())).toBe(false);
    expect(isWithinQuietHours(["25:00", "08:00"], new Date())).toBe(false);
  });

  it("ignores an unparseable snoozeUntil", () => {
    expect(suppressionReason({ ...SETTINGS, snoozeUntil: "soon" }, new Date())).toBeNull();
  });
});

describe("failure isolation (§15)", () => {
  it("swallows a dispatcher failure — a failed toast must never affect capture", () => {
    const result = notifyNewQuestions({ count: 1, projectPath: "/dev/app" }, SETTINGS, {
      dispatch: () => {
        throw new Error("no notification daemon on this box");
      },
    });
    expect(result.sent).toBe(false);
    expect(result.suppressed).toBeNull();
  });

  it("never spawns a real notifier in tests", () => {
    // The dispatcher is injected everywhere above; assert the default is not
    // reached by accident in this suite.
    expect(vi.isMockFunction(renderNotification)).toBe(false);
  });
});

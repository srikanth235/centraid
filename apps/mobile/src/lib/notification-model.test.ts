import { describe, expect, test } from "vitest";

import {
  COMPLETE_TASK,
  SNOOZE_TASK,
  notificationActionPlan,
  notificationContent,
} from "./notification-model";

describe("notification model", () => {
  test("builds private, actionable task and event notifications locally", () => {
    expect(
      notificationContent({
        key: "task:t-1:10",
        kind: "task",
        id: "t-1",
        title: "Call dentist",
        at: "2026-07-30T09:00:00.000Z",
        minutesBefore: 10,
      })
    ).toMatchObject({
      body: "Task reminder",
      data: { kind: "task", taskId: "t-1" },
    });
    expect(
      notificationContent({
        key: "event:e-1:15",
        kind: "event",
        id: "event id",
        title: "Standup",
        at: "2026-07-30T09:00:00.000Z",
        minutesBefore: 15,
      })
    ).toMatchObject({
      body: "Starts in 15 minutes",
      data: {
        kind: "event",
        url: "centraid://agenda/event/event%20id",
      },
    });
  });

  test("routes task completion, snooze, event, tally, and invite actions", () => {
    expect(
      notificationActionPlan(COMPLETE_TASK, {
        kind: "task",
        taskId: "task-1",
      })
    ).toStrictEqual({ kind: "complete-task", taskId: "task-1" });
    expect(notificationActionPlan(SNOOZE_TASK, {})).toStrictEqual({
      kind: "snooze",
    });
    expect(
      notificationActionPlan("OPEN_ITEM", {
        kind: "event",
        eventId: "event-1",
      })
    ).toStrictEqual({ kind: "open-event", eventId: "event-1" });
    expect(
      notificationActionPlan("SETTLE_BALANCE", { kind: "tally" })
    ).toStrictEqual({ kind: "open-app", appId: "tally" });
    expect(
      notificationActionPlan("OPEN_ITEM", { kind: "invite" })
    ).toStrictEqual({ kind: "open-home" });
  });
});

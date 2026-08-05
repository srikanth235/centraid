import { StackActions } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import React, { useEffect } from "react";

import { useReplica } from "../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../kit/replica/write-outcome";
import { rootNavigationRef } from "../navigation";
import { notificationActionPlan } from "./notification-model";
import { installNotificationCategories } from "./notifications-core";

export function NotificationCoordinator(): null {
  const { session } = useReplica();
  useEffect(() => {
    void installNotificationCategories();
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        void handleNotificationResponse(response, session);
      }
    );
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) void handleNotificationResponse(response, session);
    });
    return () => subscription.remove();
  }, [session]);
  return null;
}

async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
  session: ReturnType<typeof useReplica>["session"]
): Promise<void> {
  const action = response.actionIdentifier;
  const content = response.notification.request.content;
  const data = content.data as {
    kind?: unknown;
    taskId?: unknown;
    eventId?: unknown;
  };
  const plan = notificationActionPlan(action, data);
  try {
    if (plan.kind === "complete-task" && session) {
      const outcome = await session.write("tasks", {
        action: "set-status",
        input: { task_id: plan.taskId, status: "completed" },
      });
      surfaceWriteOutcome(outcome);
      return;
    }
    if (plan.kind === "snooze") {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: content.title ?? undefined,
          body: content.body ?? undefined,
          data: content.data,
          categoryIdentifier: content.categoryIdentifier ?? undefined,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(Date.now() + 10 * 60_000),
        },
      });
      return;
    }
    if (plan.kind === "open-event") {
      if (rootNavigationRef.isReady())
        rootNavigationRef.navigate("Agenda", {
          screen: "AgendaEvent",
          params: { eventId: plan.eventId },
        });
      return;
    }
    if (plan.kind === "open-home") {
      // `StackActions.popTo`, not `navigate`: the notification can arrive with
      // an app cover open, and React Navigation 7's `navigate` would push a
      // SECOND Home above that cover — which UIKit then presents as an inset
      // card sheet rather than returning the member to the springboard.
      if (rootNavigationRef.isReady())
        rootNavigationRef.dispatch(StackActions.popTo("Home"));
      return;
    }
    if (plan.kind === "open-notifications") {
      if (rootNavigationRef.isReady())
        rootNavigationRef.navigate("Settings", { screen: "Approvals" });
      return;
    }
    if (plan.kind === "open-app") {
      if (rootNavigationRef.isReady())
        rootNavigationRef.navigate(plan.appId === "tasks" ? "Tasks" : "Tally");
    }
  } catch (error) {
    surfaceWriteFailure(error, "Notification action failed");
  }
}

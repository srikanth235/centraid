export type SignalDetail = "phone" | "backup";

export interface SignalNotificationCopy {
  eyebrow: string;
  title: string;
  body: string;
  cause: string;
  consequence: string;
  actionLabel: string;
  detail: SignalDetail;
  destination: "PhoneStorage" | "BackupHealth";
  destinationParams: { signalCause: string };
}

export function signalNotificationCopy(
  cause: string,
  detail: SignalDetail
): SignalNotificationCopy {
  if (detail === "backup") {
    return {
      eyebrow: "Backup alert",
      title: "Your vault backup needs attention",
      body: "The latest verified copy is incomplete.",
      cause,
      consequence: "Recovery may not include the newest vault items.",
      actionLabel: "Open Backup health",
      detail,
      destination: "BackupHealth",
      destinationParams: { signalCause: cause },
    };
  }
  return {
    eyebrow: "Upload alert",
    title: "Uploads need your attention",
    body: "Some content still exists only on this phone.",
    cause,
    consequence: "Only this phone holds those pending items.",
    actionLabel: "Open On this phone",
    detail,
    destination: "PhoneStorage",
    destinationParams: { signalCause: cause },
  };
}

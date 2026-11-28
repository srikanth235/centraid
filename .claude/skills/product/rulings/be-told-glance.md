# Be told and glance

Notifications, widgets and time.

- **Time is the member's.** Civil time is the vault's zone and the device's stated zone, never the host's and never UTC by default. A date-only task or reminder stays a date and never gains an invented time. A line on a statement keeps the printed day, so a trip across time zones moves nothing between months.

- **A reminder with a time alerts at that time, by default (owner, 2026-11-18).** "Early reminder" only adds an earlier alert beside it; its "None" means the alert at the time alone, and there is no separate "At the time" choice. Both platforms schedule from the one plan Rust makes. A date-only reminder stays a date: it alerts at 09:00 only when an early reminder was set.

- **One notification rule for every dated thing, the same on both platforms; widgets and shortcuts are the same set on both.** Whatever can alert the member does it through the one notification service. An alert is an event's, a task's with a due time, a person's date (when the member asked for a reminder) or a Locker item's dated field. A person's or Locker item's date counts its lead back from 09:00 on the day.
- **A dated Locker field can notify, and the notification is masked (owner, 2026-11-26).** It reads "An item in Locker expires soon" and names no item, label or value; opening it goes behind the wall. A sealed value is never in a notification.
- **Imported dates are silent until the member asks.** A birthday that arrives with a phone contact has no reminder; following the contacts never writes one. "Remind me" on the date is the member's.
- **Every alert offers Snooze on the lock screen; a task's alert also offers Done.** Done is completing the task. On an event, a birthday or a Locker expiry "Done" would read as cancelling or deleting it, so those offer Snooze and the system's own dismiss, which writes nothing. One snooze mechanism serves every kind and moves only that alert. Editing the thing's time, its lead or its date, or finishing a task, clears its snooze.
- **A trashed or purged item's notifications go with it.** Pending alerts are cancelled and banners already delivered are removed. Widgets are rewritten at every change to what they show, so a trash or purge clears them at once.
- **A notification carries a link to the item and an action id, never a screen.** The one scheduler in core over `reminder` and `snooze`, and the per-kind action categories, live in `crates/core/src/notify/`.

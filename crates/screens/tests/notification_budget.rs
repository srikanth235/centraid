//! THE PENDING-NOTIFICATION BUDGET lives in one place (#1185). iOS keeps at most 64 pending
//! notifications for the whole app. Rust's one set (`agenda::notify`: at most `CAP` reminders and
//! events, plus the one receipt of the button just pressed) is everything the iOS shell schedules,
//! so the budget holds only while no second place schedules around it. This counts the budget and
//! fails when any other iOS source file schedules a notification of its own.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_screens::agenda::notify::{CAP, OS_PENDING_LIMIT, RECEIPTS};

fn swift_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            swift_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "swift") {
            out.push(path);
        }
    }
}

// The budget as a compile-time fact: raising CAP past what iOS keeps fails the build.
const _: () = assert!(CAP + RECEIPTS <= OS_PENDING_LIMIT);

#[test]
fn only_the_one_set_applier_schedules_a_notification_on_ios() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mobile/iosApp");
    let mut files = Vec::new();
    swift_files(&root, &mut files);
    assert!(
        !files.is_empty(),
        "no Swift sources under {}: the budget check would prove nothing",
        root.display()
    );
    let mut places = Vec::new();
    for path in files {
        let text = fs::read_to_string(&path).unwrap_or_default();
        let schedules = text.contains("UNNotificationRequest(")
            || text.contains("UNCalendarNotificationTrigger(")
            || text.contains("UNTimeIntervalNotificationTrigger(")
            || text.contains("UNLocationNotificationTrigger(");
        if schedules {
            places.push(
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_owned(),
            );
        }
    }
    assert_eq!(
        places,
        ["Notifications.swift"],
        "a second place schedules notifications outside the budget of the one set"
    );
}

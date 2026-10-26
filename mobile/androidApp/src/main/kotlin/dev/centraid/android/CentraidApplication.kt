package dev.centraid.android

import android.app.Application

/**
 * THE APPLICATION OPENS NOTHING (#1020, R-1020-24; #1135).
 *
 * An `Application.onCreate` that opened the core would make every Share, Autofill and Widget
 * process — which share this class — an opener. The process's one session
 * (`session/AppSession.kt`) is opened by whoever first needs it: the activity, or a background
 * window the operating system granted with no activity at all (`backup/PassWork.kt`'s
 * `CentraidSyncWorker`), and the passes themselves are Rust's (`crates/screens/src/passes`).
 */
public class CentraidApplication : Application()

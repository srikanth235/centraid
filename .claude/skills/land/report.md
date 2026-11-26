# Reporting

Say what the evidence is, not what you hope.

- List each command actually run and whether it passed. Paste the failing line, not a summary.
- List what was running or unfinished when you stopped.
- Name every layer not run, with the exact command and the platform or device it needs (simulator, emulator, device, snapshots, Compose, SwiftUI).
- Say what only CI or a device can verify. Never call an unrun layer verified.
- Physical-device performance evidence names the reference device; an emulator or simulator number is not one.
- A claim you did not run is listed as unverified.
- Plain words: what landed, what it changes for a member, what is owed.
- Where a layer has no command, say "no check exists yet", not "passed".
- Say what is target and what is built.
- For a visual or UX change, give the paths of the screenshots you looked at: the boards and the app screens, light and dark, before and after.

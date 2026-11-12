# The promises

What every app owes a member, and the one rule each follows. A promise kept in some apps and broken in others is a broken promise: the same behaviour and words in every app, on both platforms. Where an app is an exception, it is named and held to that.

`cargo xtask rules` prints the register in [`crates/xtask/src/promises.rs`](../../../crates/xtask/src/promises.rs): which app keeps which promise, the file that proves it, and what is still missing. Read it there; this file states the rules only.

| Promise | The rule every app follows |
| --- | --- |
| **Keep** | Everything is one kind of record, offline, the member's. |
| **Arrive** | Every item records how it arrived (typed, followed from the phone, imported from a file), and its detail screen says so in one quiet line. |
| **Change safely** | Every item can go to trash, be restored and be deleted forever; every trash can be emptied. Every action is undoable from the status line, or is confirmed first because it cannot be. Every record keeps its earlier values, listed on one screen with Restore. A save checks what it is replacing and says when it was stale. |
| **Connect** | Every item can be linked to any other kind of item but a Locker item, through one picker. |
| **When** | One timeline, with repeats from one engine. |
| **How much** | Every number is a quantity with its unit, worded through the member's one units choice. |
| **Attach** | Every item can hold a file or a photograph. A Locker item holds none. |
| **Find** | Every field a member typed is searchable. |
| **See truthfully** | Every screen uses one set of states: loading, empty, failed, refused, partial, not checked. |
| **Protect** | Sealed values stay out of search, links and Ask. |
| **Confirm it's me** | One rule: the owner check is asked before anything leaves the phone in the clear and before a restore; not on open, and not on an import. |
| **Back up** | The gateway copy keeps catching up; "backed up" says only what a gateway acknowledged. |
| **Recover** | The 24 words bring everything back. |
| **Pair** | The member connects their own machine. |
| **Take out** | Every app exports its data to an open format; every primary item can be handed to the OS as a copy; one "Export everything" covers the vault. |
| **Be told** | Every dated thing follows one notification rule, identically on both platforms, through the one notification service. |
| **Glance** | Widgets and shortcuts are the same set on both platforms. |
| **Start** | Every permission is asked the same way at the moment of need, and a refusal reads the same way. |
| **Home** | Nine apps, one product. |

Both platforms: the same behaviour, words and conditions on iOS and Android.

Rulings behind these are in [rulings/](rulings/). To make an app keep one, see [keep a promise](../change/keep-a-promise.md).

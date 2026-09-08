# Trap: a virtualized list that anchors by default

## What goes wrong

A row arrives from another device — a document uploaded from the desktop, a note written on the gateway — and the phone **never shows it**. The replica has it, the read returns it, React re-renders with it, and the screen does not move. Leave the route and come back, or pull to refresh, and it is there.

The row was never missing. FlashList v2 sets `maintainVisibleContentPosition` **on by default**, and every seat here sorts newest first, so an inserted row lands at the top — where the anchor's whole job is to keep the reader's rows where they were. It does that by scrolling the new row out of sight above the fold.

Three symptoms, one cause:

| What you see | What happened |
| --- | --- |
| New rows never appear | Inserted above the viewport; scroll up and they are there |
| A renamed row **disappears** | It re-sorted to the top, i.e. out of view — reads as data loss |
| Footer count disagrees with the rows | The count is plain text off the same array, and is right |

## Why it is expensive to diagnose

Every layer below the list is innocent and says so. The feed delivers, `session.subscribe` filters correctly, `useReplicaQuery` re-reads, the component re-renders with the correct, correctly-sorted array. Instrumenting the data path proves each stage green and points nowhere. The screen is not frozen either — navigation, taps and other views on the same screen all work, and a non-virtualized sibling view (Notebooks) shows the fresh data.

Upgrading FlashList does not help, because this is documented default behaviour, not a bug. Neither does `extraData`.

## The invariant

> Every `FlashList` states its scroll anchoring at the call site. Anchoring is never inherited by default.

`NEWEST_FIRST_ANCHORING` (`apps/mobile/src/kit/components/list-anchoring.ts`) is the shared answer for a newest-first seat: follow the top while the reader is at it, hold position once they have scrolled in, where an unrequested jump would be worse. A list that wants something else says so in place.

`bun run lint:list-anchoring` enforces it across the mobile seat.

## What does not catch it

The component tests stub FlashList (`apps/mobile/src/test/react-native-stub.tsx`), so no vitest run can see this. No lane in the repo owns "a change made elsewhere lands while a list is open" — the blueprint `states.test.tsx` files draw a state they are handed, and `tests/integration-mobile/` asks what the session reports, never what the screen shows. It reached a device because a person made a write on a gateway and watched a phone.

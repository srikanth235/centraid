---
name: change
description: >-
  How does this kind of change travel through the layers? Use to add or change a screen, a vault kind, table, column, command or read, the Rust/shell C ABI or its protobuf requests, a followed phone store, or to make an app keep a member promise (trash, earlier versions, export, share, undo).
---

# Change

A change touches several layers that must agree; tests and gates fail until they do. Rust decides, the shells draw.

| If you are doing | Read |
| --- | --- |
| A read, an action, a screen, a block or canvas, a gesture, a notification or a device-store key; who owns what | [app-plane.md](app-plane.md) |
| A vault kind, table, column, edge, command or read | [vault-model.md](vault-model.md) |
| The C ABI, a protobuf request, a binding | [ffi.md](ffi.md), then [ffi-bindings.md](ffi-bindings.md) |
| An ABI check or a failure to diagnose | [ffi-diagnostics.md](ffi-diagnostics.md) |
| A followed phone store | [following.md](following.md) |
| Making a kind keep trash, earlier versions, export, share or Undo | [app-plane.md](app-plane.md#8-the-kind-registry-and-the-promise-charter) |
| SQL craft | [stack/sqlite](../stack/sqlite/centraid.md) |
| Proving it and shipping | [land](../land/SKILL.md) |

A change to a tool's arguments or results, or to the kinds, fields or verbs the assistant can use, also changes what the fine-tune data should contain: read the assistant skill's [data page](../assistant/data.md) and run `datagen drift` before merge.

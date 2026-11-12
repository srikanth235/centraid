---
name: design
description: >-
  What does it look like and say? Use for any visual or UX change, a mockup, a design token or icon, a screen's behaviour (rooms, app roots, status line, search, controls, colour, accessibility), or any word a member reads (strings, the copy check).
---

# Design

Every visual or UX change starts in `design/mockups/`. Values live in the mockups and `design/tokens.toml`; behaviour and words live here. Both shells follow the same behaviour, words and selector ids, never the same pixels.

| If you are doing | Read |
| --- | --- |
| Changing a board, a token or an icon; running `cargo xtask design` | [mockups.md](mockups.md) |
| Deciding how a screen behaves: rooms, header, band, status line, search, controls, colour, accessibility | [behaviour.md](behaviour.md) |
| Writing or changing a string, or the copy check | [wording.md](wording.md) |
| Building the screen in Rust and both shells | [change/screen.md](../change/screen.md) |
| Deciding what the product should do | [product](../product/SKILL.md) |

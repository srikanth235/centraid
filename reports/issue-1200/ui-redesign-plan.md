# Shared UI redesign — #1200

The owner confirmed that the redesign covers both the native app across all nine apps and the docs. It follows the current logo's liveliness. All work stays in draft PR #1201. This changes presentation and clarity, without adding product functionality or reducing any app's depth.

## Direction

- Keep the canonical four-quarter mark intact. Saturated quarter geometry frames illustrated product content on docs; never layer shapes through the mark’s open centre. Native headers retain the active vault’s own initial, hue and name.
- Use shell colour for the shell, established app accents for app identity, and state colours for actual state. Brand illustration can carry the four logo colours.
- Use bundled Instrument Sans and existing type roles. Open invitations carry solid app glyph blocks; populated widgets stay paper; directories flow through grouped rows. Card radius stays16. The accepted Home invitation glyph size36 is recorded as a generated geometry role.
- Preserve the seven rooms, current navigation, search/theme access, vault identity, all nine destinations, existing actions and selector IDs.
- Show only state the current model supplies. Empty, failed, unchecked and unacknowledged remain distinct.
- Keep movement restrained and honour reduced motion. Colour is accompanied by labels and recognisable glyphs.

## Delegated slices

| Slice | Owned work | Root acceptance |
| --- | --- | --- |
| Docs mockups | Authored light landing, guide, apps, data, system and reference boards | Stronger brand identity, concise copy, correct diagrams, reachable navigation, responsive layouts |
| Native mockups | Authored light empty/populated Home and a coherent app root/detail/editor set | Current runtime anatomy, truthful content, nine destinations, large-text reflow, recognisable app identities |
| Tokens and generation | Exact aliases/values and their dark counterparts, generator changes only where required | One shared language, contrast floors, no hand-edited generated output |
| Docs implementation | Shared site components/styles and all existing docs templates | All 12 routes/fragments, search, disclosures, menu and theme continue working |
| Native implementation | Shared iOS/Android kit and Home styling, using current state/context | Same behaviour and selectors, platform-native chrome, no new business rules in views |

The owner rejected the earlier preview as bland and too dependent on old pieces, and requested Sol for design. Sol supplied the new visual direction and representative light boards for both app and docs. Root reviewed the rendered boards, then resumed Luna's native implementation against that handoff. The new composition keeps the canonical logo, current product facts and existing behavior.

Root accepted Sol’s saturated editorial landing, open native invitations, flowing People directory, inline person detail and full-screen editor after light/dark renders. The other five docs boards use a field guide, app atlas, exploded record/original, phone-boundary system diagram and directional record spread. Their required corrections pair active navigation ink, give diagram labels a paper ground and separate recovery prerequisites from the downward arrow.

The accepted docs design is implemented in source, retaining existing section IDs, substantial guidance, behavior and structured metadata. Legal text and the ontology schema remain intact. Product views are labeled illustrations, not matching-build native captures; fictional examples are excluded from search. Root reviewed the working desktop/mobile site, light/dark, navigation, search, disclosures and setup order. The latest bundle and smoke checks pass all 12 routes and fragments. Native implementation uses [the component handoff](native-design-handoff.md); matching artifact observations and remaining findings are recorded in [redesign verification](redesign-verification.md). Root owns generation, bundles, visual review, checks and the single draft PR. This local checkpoint is not final CI acceptance.

## Verification and delivery

1. Review representative light boards at phone and desktop widths; correct anatomy and diagram meaning before extending the style.
2. Update authored tokens/boards, then run guarded design generation. Review generated dark boards, native tables and both sites' sheets together.
3. Run design drift/contrast checks, applicable focused tests, docs bundle/smoke/link checks and `bun run check`.
4. Rebuild matching native artifacts where affected; verify Home, all app roots and representative detail/editor states, light/dark and large text. Record unrun layers honestly.
5. Batch reviewed changes and the report-link CI correction into the existing PR. Read CI on its final head; keep the draft open while required proof is missing.

Every local build/test/generator uses the reviewed disk guard. One compiler/build runs at a time. Native virtual devices now run one at a time on this 16 GiB host; the earlier concurrent-device snapshot used about 10 GiB swap. Preserve source, final binaries and evidence when reclaiming task caches. No thresholds or count/size checks are weakened.

## Existing verification checkpoint

The published `d12fedf55` CI passed its workspace tests and all other gate lanes except one report hyperlink to an ignored local JNI binary. Root reviewed the correction and independently reran `doc-links`: zero findings. That correction is still local; this is not a final-head CI pass.

Both platforms have reviewed onboarding/Home/task/person Trash/Undo evidence. Real notification permission prompts and delivery were observed; cold action callbacks, receipt Undo and vault isolation remain unverified. The earlier injected source seed reaches the intended unsettled-seed restore gate, so it is not a completed independent recovery drill. These limitations are preserved while the visual work proceeds.

<!-- STEERING.md — append-only human-steering ledger -->
<!-- governance: allow-plan-captured -->

# STEERING.md

Append-only ledger of human-steering events for agent-authored commits. Rows are
keyed by `steer-key`; the row → commit join uses the `commit |` column so the
ledger survives squash merges that strip the original commit history. Each
commit's summary trailers (`Steer-Count`, `Steer-Types`, `Steer-Tiers`) tally
the rows it adds.

**Do not** rewrite or reorder rows. This file is the durable record that the
`agent-steering-accounting` governance directive validates.

`type` ∈ `interrupt` | `correction` ·
`tier` ∈ `structural` | `classifier` | `lexical` (the lexical tier is a
silent fallback for when the runtime CLI is unreachable).

## Ledger

| steer-key | session | issue | type | tier | user-reason | commit |
| --- | --- | --- | --- | --- | --- | --- |
| steer-46305f58707-1778569590-1 | 46305f58-7075-4b6d-903b-9ecd33d41985 | #16 | correction | classifier | Questioned modifying pack-owned check.sh file | chore(governance): bootstrap governance-kit/core via init (#16) |
| steer-46305f58707-1778569590-2 | 46305f58-7075-4b6d-903b-9ecd33d41985 | #16 | correction | classifier | Asked to revert patch and use directive instead | chore(governance): bootstrap governance-kit/core via init (#16) |
| steer-8c0d92ed5ba-1778586498-1 | 8c0d92ed-5bad-4504-8478-2400eebdca56 | #17 | correction | classifier | rejected mock gateway; use real local gateway instead | test(agent-e2e): scaffold agent-driven e2e harness + root test orchestration (#… |
| steer-175b1014652-1778601831-1 | 175b1014-652d-492d-9f12-bdab3af9560f | #22 | correction | classifier | Pushed back on overly dark theme background, asked to soften it | feat(desktop): soften dark theme + drop hero "New app" button (#22) |
| steer-83b94449006-1778664748-1 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-2 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | correction | lexical | wait this is what I'm seeing | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-3 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-4 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-5 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778665787-1 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-2275b5eac39-1778670468-1 | 2275b5ea-c39c-4f61-9eb3-40adfb0097a8 | #29 | correction | classifier | user flags the last commit broke CI and demands a fix | style(desktop): wrap long linear-gradient line per oxfmt (#29) |
| steer-70619dd81af-1778678345-1 | 70619dd8-1af1-4399-a121-9385d8c297f9 | #30 | correction | classifier | shipped UI does not match the original mockup | feat(desktop): close mockup gaps - drop divider, fuse subtitle into version+t… |
| steer-70619dd81af-1778678345-2 | 70619dd8-1af1-4399-a121-9385d8c297f9 | #30 | correction | classifier | shipped UI does not match the original mockup | feat(desktop): close mockup gaps - drop divider, fuse subtitle into version+t… |
| steer-70619dd81af-1778678345-3 | 70619dd8-1af1-4399-a121-9385d8c297f9 | #30 | interrupt | structural |  | feat(desktop): close mockup gaps - drop divider, fuse subtitle into version+t… |
| steer-70619dd81af-1778678345-4 | 70619dd8-1af1-4399-a121-9385d8c297f9 | #30 | correction | classifier | mockup changes not fully implemented | feat(desktop): close mockup gaps - drop divider, fuse subtitle into version+t… |
| steer-70619dd81af-1778678345-5 | 70619dd8-1af1-4399-a121-9385d8c297f9 | #30 | correction | classifier | wants full mockup implemented, deferring only agent turns | feat(desktop): close mockup gaps - drop divider, fuse subtitle into version+t… |
| steer-165e8a66254-1778679479-1 | 165e8a66-254f-414a-9e5d-cf7f07aec752 |  | correction | classifier | Settings page not scrollable — fix scroll behavior | feat(desktop): model Settings as a page in the main panel |
| steer-165e8a66254-1778679479-2 | 165e8a66-254f-414a-9e5d-cf7f07aec752 |  | interrupt | structural |  | feat(desktop): model Settings as a page in the main panel |
| steer-165e8a66254-1778679479-3 | 165e8a66-254f-414a-9e5d-cf7f07aec752 |  | interrupt | structural |  | feat(desktop): model Settings as a page in the main panel |
| steer-165e8a66254-1778679479-4 | 165e8a66-254f-414a-9e5d-cf7f07aec752 |  | correction | classifier | Halt further testing/actions | feat(desktop): model Settings as a page in the main panel |
| steer-70619dd81af-1778679881-1 | 70619dd8-1af1-4399-a121-9385d8c297f9 | #30 | interrupt | structural |  | feat(desktop): finish v2 mockup port - in-pane header, author chip, version sta… |
| steer-d102b4b97bc-1778681033-1 | d102b4b9-7bcf-4464-9fd4-2836b15a24bf | #30 | correction | classifier | user rejected the redesigned button group as still looking ugly | feat(desktop): unify right-pane toolbar segmented controls, drop preview URL ba… |
| steer-d102b4b97bc-1778681033-2 | d102b4b9-7bcf-4464-9fd4-2836b15a24bf | #30 | correction | classifier | user wants the address bar removed entirely | feat(desktop): unify right-pane toolbar segmented controls, drop preview URL ba… |
| steer-da1d0b3ae48-1778691275-1 | da1d0b3a-e481-42ff-9ece-87b2af58dbac |  | correction | classifier | User clarified intent; rejected misinterpretation of the change | fix(desktop): default Dark shade slider to 10 |
| steer-059727b5462-1778746997-1 | 059727b5-4622-46d7-8388-6f07d56d077d |  | interrupt | structural |  | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-2 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | told agent to pause before next test step | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-3 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | rejected current dark palette; asked for Notion/Linear-style rework | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-4 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | asked for mockup before implementing changes | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-5 | 059727b5-4622-46d7-8388-6f07d56d077d |  | interrupt | structural |  | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-6 | 059727b5-4622-46d7-8388-6f07d56d077d |  | interrupt | structural |  | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-7 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | sidebar dark mode too dull, asked to rethink | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-8 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | app view not using dark shade like home page | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-9 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | app still in mobile mode and shows redundant title | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-10 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | rejected device pill; app should fill main pane without clipping | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-11 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | dark shade in app view no longer matches home page | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-12 | 059727b5-4622-46d7-8388-6f07d56d077d |  | interrupt | structural |  | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-13 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | reported uneven shading split across the canvas | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-14 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | asked to remove distracting grid pattern | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-15 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | asked to also remove grid pattern from home page | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-16 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | topbar should match main pane with vertical separator only | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-17 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | separator not visible after change | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-18 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | hide sidebar separator and thicken main separator | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-19 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | builder preview ignores theme and sidebar missing apps | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-20 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | light theme is broken, needs fixing | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-21 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | light theme colors too jarring vs Notion/Linear | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-22 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | no visible distinction between sidebar and main pane | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-059727b5462-1778746997-23 | 059727b5-4622-46d7-8388-6f07d56d077d |  | correction | classifier | tiles don't stand out and separator should be thinner | feat(desktop): theme-aware iframes, full-bleed app view, Notion/Linear light th… |
| steer-79037b2cb28-1778754659-1 | 79037b2c-b28b-4cf8-9053-508990c1338d |  | interrupt | structural |  | feat(runtime): extract runtime-core; embed runtime in desktop for local mode |
| steer-79037b2cb28-1778754659-2 | 79037b2c-b28b-4cf8-9053-508990c1338d |  | correction | classifier | rejected local-only framing; wants runtime decoupled and remotely hostable | feat(runtime): extract runtime-core; embed runtime in desktop for local mode |
| steer-79037b2cb28-1778754659-3 | 79037b2c-b28b-4cf8-9053-508990c1338d |  | correction | classifier | pivots to OpenClaw SDK compatibility and multi-provider support | feat(runtime): extract runtime-core; embed runtime in desktop for local mode |
| steer-79037b2cb28-1778754659-4 | 79037b2c-b28b-4cf8-9053-508990c1338d |  | correction | classifier | pulls cron out of scope and asks to surface concerns instead | feat(runtime): extract runtime-core; embed runtime in desktop for local mode |
| steer-79037b2cb28-1778754659-5 | 79037b2c-b28b-4cf8-9053-508990c1338d |  | correction | classifier | reframes goal as local OpenClaw-equivalent implementing SDK interface | feat(runtime): extract runtime-core; embed runtime in desktop for local mode |

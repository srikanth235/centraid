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
| steer-dcde0561d40-1778780780-1 | dcde0561-d40f-4896-9fc0-7d09adbb16a6 |  | interrupt | structural |  | feat(desktop,plugin): Copilot-style chat history + draft sidebar fixes |
| steer-dcde0561d40-1778781923-1 | dcde0561-d40f-4896-9fc0-7d09adbb16a6 | #51 | correction | classifier | Flagged bug: cloned drafts missing from builder sidebar; asks for fix | fix(desktop): builder sidebar shows freshly-cloned draft immediately (#51) |
| steer-f7a791c9daf-1778787576-1 | f7a791c9-daf7-43ae-8a7a-702b18834172 | #54 | interrupt | structural |  | feat(governance): add query-handlers-read-only - forbid stmt.run / db.e… |
| steer-f7a791c9daf-1778787576-2 | f7a791c9-daf7-43ae-8a7a-702b18834172 | #54 | interrupt | structural |  | feat(governance): add query-handlers-read-only - forbid stmt.run / db.e… |
| steer-f7a791c9daf-1778787576-3 | f7a791c9-daf7-43ae-8a7a-702b18834172 | #54 | correction | lexical | hold on this...this doesn't make any sense...by default, openclaw tools should be registered..o/w how will opencalw crons will be able to access this data....in chat-harness tools,you should actually mimic those tools...do sqlite provides m | feat(governance): add query-handlers-read-only - forbid stmt.run / db.e… |
| steer-b5994de6c42-1778787861-1 | b5994de6-c421-46bc-b87b-366137b1238c | #53 | interrupt | structural |  | feat(desktop): Notion-style action menus for apps and templates (#53) |
| steer-b5994de6c42-1778787861-2 | b5994de6-c421-46bc-b87b-366137b1238c | #53 | correction | classifier | User expanded scope: sidebar also needs Notion-style actions, not just dots | feat(desktop): Notion-style action menus for apps and templates (#53) |
| steer-f7a791c9daf-1778820466-1 | f7a791c9-daf7-43ae-8a7a-702b18834172 | #54 | interrupt | structural |  | feat(governance): add query-handlers-read-only - forbid stmt.run / db.exec in q… |
| steer-f421eab36b0-1778833041-1 | f421eab3-6b05-45a1-be7a-20c1f9fdd695 | #63 | correction | lexical | wait | refactor(design-tokens,desktop): extract --bg-wall token, lighten home main pan… |
| steer-9fc87005699-1778840715-1 | 9fc87005-6992-4f6f-ba26-5951fd092da4 | #63 | interrupt | structural |  | fix(runtime,plugin): scope chat sessions to UserStore identity (#63) |
| steer-9fc87005699-1778840715-2 | 9fc87005-6992-4f6f-ba26-5951fd092da4 | #63 | correction | classifier | pushed to consolidate migrations into one global migration instead of separate | fix(runtime,plugin): scope chat sessions to UserStore identity (#63) |
| steer-9fc87005699-1778842413-1 | 9fc87005-6992-4f6f-ba26-5951fd092da4 | #63 | correction | classifier | pushed back on separate DB files, wanted justification | refactor(runtime,plugin,desktop): single gateway sqlite + real FKs (#63) |
| steer-6a1faa59b3c-1778863483-1 | 6a1faa59-b3ce-4df5-bd63-370c71c237ee |  | interrupt | structural |  | feat(desktop,templates,runtime): per-app settings popover + Home redesign |
| steer-6a1faa59b3c-1778863483-2 | 6a1faa59-b3ce-4df5-bd63-370c71c237ee |  | interrupt | structural |  | feat(desktop,templates,runtime): per-app settings popover + Home redesign |
| steer-7a0284c3256-1779099410-1 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | feat(local-chat-runner): replace MCP plumbing with a small centraid CLI (#71) |
| steer-7a0284c3256-1779099410-2 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | scope narrowed to codex only; stop wiring claude | feat(local-chat-runner): replace MCP plumbing with a small centraid CLI (#71) |
| steer-7a0284c3256-1779099410-3 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | feat(local-chat-runner): replace MCP plumbing with a small centraid CLI (#71) |
| steer-7a0284c3256-1779099410-4 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider MCP approach; suggested codex plugins instead | feat(local-chat-runner): replace MCP plumbing with a small centraid CLI (#71) |
| steer-7a0284c3256-1779099410-5 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | feat(local-chat-runner): replace MCP plumbing with a small centraid CLI (#71) |
| steer-7a0284c3256-1779099410-6 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider approach; prefer CLI-in-prompt over MCP/plugins | feat(local-chat-runner): replace MCP plumbing with a small centraid CLI (#71) |
| steer-7a0284c3256-1779101981-1 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Pushed back on using computer-use; asked why not Electron CDP debugging tools | fix(desktop): bump Electron to 37 + runtime-mode badge (#71) |
| steer-7a0284c3256-1779105983-1 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-2 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | scope narrowed to codex only; stop wiring claude | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-3 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-4 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider MCP approach; suggested codex plugins instead | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-5 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-6 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider approach; prefer CLI-in-prompt over MCP/plugins | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-7 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-8 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | pause current path; investigate openclaw SDK for remote builder first | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-9 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | corrected assumption that chat is battle-tested; it's v0, just landed | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779105983-10 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reuse existing issue instead of opening a new one | refactor(local-chat-runner): mode-agnostic CLI primitives + preview snapshot su… |
| steer-7a0284c3256-1779107600-1 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(local-chat-runner): swap to codex app-server + Claude SDK backends (#7… |
| steer-7a0284c3256-1779107600-2 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Wrong implementation path; user wants Claude SDK + codex app-server | refactor(local-chat-runner): swap to codex app-server + Claude SDK backends (#7… |
| steer-7a0284c3256-1779107600-3 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Reframes scope: unify chat+builder harnesses, remote gateway already done | refactor(local-chat-runner): swap to codex app-server + Claude SDK backends (#7… |
| steer-7a0284c3256-1779110609-1 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-2 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | scope narrowed to codex only; stop wiring claude | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-3 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-4 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider MCP approach; suggested codex plugins instead | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-5 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-6 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider approach; prefer CLI-in-prompt over MCP/plugins | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-7 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Pushed back on using computer-use; asked why not Electron CDP debugging tools | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-8 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-9 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | scope narrowed to codex only; stop wiring claude | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-10 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-11 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider MCP approach; suggested codex plugins instead | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-12 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-13 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reconsider approach; prefer CLI-in-prompt over MCP/plugins | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-14 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Pushed back on using computer-use; asked why not Electron CDP debugging tools | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-15 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-16 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | pause current path; investigate openclaw SDK for remote builder first | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-17 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | corrected assumption that chat is battle-tested; it's v0, just landed | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-18 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | reuse existing issue instead of opening a new one | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-19 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | interrupt | structural |  | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-20 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Wrong implementation path; user wants Claude SDK + codex app-server | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-7a0284c3256-1779110609-21 | 7a0284c3-256e-4ea2-9f9d-ee59d85c0465 | #71 | correction | classifier | Reframes scope: unify chat+builder harnesses, remote gateway already done | refactor(runtime,desktop,agent-runtime,builder-harness): review fixes + naming cleanup (#71) |
| steer-59e380359eb-1779119130-1 | 59e38035-9eb9-467d-8160-aaabcbf1a892 |  | interrupt | structural |  | fix(chat,reactivity): chat path correctness + auto-react to SQLite writes |
| steer-59e380359eb-1779119130-2 | 59e38035-9eb9-467d-8160-aaabcbf1a892 |  | correction | lexical | wait, do all of them | fix(chat,reactivity): chat path correctness + auto-react to SQLite writes |
| steer-59e380359eb-1779119130-3 | 59e38035-9eb9-467d-8160-aaabcbf1a892 |  | interrupt | structural |  | fix(chat,reactivity): chat path correctness + auto-react to SQLite writes |
| steer-59e380359eb-1779119130-4 | 59e38035-9eb9-467d-8160-aaabcbf1a892 |  | interrupt | structural |  | fix(chat,reactivity): chat path correctness + auto-react to SQLite writes |
| steer-59e380359eb-1779119130-5 | 59e38035-9eb9-467d-8160-aaabcbf1a892 |  | interrupt | structural |  | fix(chat,reactivity): chat path correctness + auto-react to SQLite writes |
| steer-59e380359eb-1779119130-6 | 59e38035-9eb9-467d-8160-aaabcbf1a892 |  | interrupt | structural |  | fix(chat,reactivity): chat path correctness + auto-react to SQLite writes |
| steer-14a8bef42c3-1779184388-1 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | correction | classifier | harness scaffold missing automations folder; should create it | fix(builder-harness): ensure automations/ folder lands on both scaffold and clo… |
| steer-14a8bef42c3-1779187772-1 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | correction | classifier | pushed back on missing automations UI/deployment story in app view | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-14a8bef42c3-1779187772-2 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | interrupt | structural |  | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-14a8bef42c3-1779187772-3 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | correction | classifier | demanded enable/disable controls beyond what was proposed | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-14a8bef42c3-1779187772-4 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | correction | classifier | challenged placement under frontend and missing template seeds | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-14a8bef42c3-1779187772-5 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | correction | classifier | rejected putting automations under Cloud tab; wants in-app UX | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-14a8bef42c3-1779187772-6 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | interrupt | structural |  | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-14a8bef42c3-1779187772-7 | 14a8bef4-2c30-4aad-83f3-80f59429ed53 | #70 | interrupt | structural |  | feat(runtime-core,desktop,app-templates): deploy + manage automations from publ… |
| steer-ab0a32ba9bf-1779199560-1 | ab0a32ba-9bfc-440d-8677-b8d6a864a43a |  | correction | lexical | wait....if toggle state is a problem, can't it be part of data sqlite file | feat(automations): AutomationHost interface + per-app toggle SoT |
| steer-ab0a32ba9bf-1779199560-2 | ab0a32ba-9bfc-440d-8677-b8d6a864a43a |  | interrupt | structural |  | feat(automations): AutomationHost interface + per-app toggle SoT |
| steer-ab0a32ba9bf-1779199560-3 | ab0a32ba-9bfc-440d-8677-b8d6a864a43a |  | correction | lexical | wait....you raise a vaid point....now we need to tweak lcoal gateway to match the behavior of openclaw cron..openclaw provides mechanism for registering, deregistering crons...we need to implement it in our local gateway...now, in app-setti | feat(automations): AutomationHost interface + per-app toggle SoT |
| steer-906f928532b-1779274149-1 | 906f9285-32b8-465e-b3a8-7145639b16cf |  | interrupt | structural |  | feat(design-tokens): add refined-screen icons, fix Send glyph |
| steer-906f928532b-1779277637-1 | 906f9285-32b8-465e-b3a8-7145639b16cf | #82 | correction | classifier | rejected deferring work; demanded all items be completed | feat(desktop): Builder pane toolbar - URL pill + device + tabs (#82) |
| steer-906f928532b-1779277637-2 | 906f9285-32b8-465e-b3a8-7145639b16cf | #82 | interrupt | structural |  | feat(desktop): Builder pane toolbar - URL pill + device + tabs (#82) |
| steer-906f928532b-1779286484-1 | 906f9285-32b8-465e-b3a8-7145639b16cf | #82 | correction | classifier | pushed back on accepting structural-only deviations; demanded closer match | feat(desktop): pixel-match Home screens to refined proposal (#82) |
| steer-906f928532b-1779286484-2 | 906f9285-32b8-465e-b3a8-7145639b16cf | #82 | interrupt | structural |  | feat(desktop): pixel-match Home screens to refined proposal (#82) |
| steer-906f928532b-1779286484-3 | 906f9285-32b8-465e-b3a8-7145639b16cf | #82 | correction | classifier | rejected structural-only audit; demanded pixel-by-pixel match | feat(desktop): pixel-match Home screens to refined proposal (#82) |
| steer-906f928532b-1779292687-1 | 906f9285-32b8-465e-b3a8-7145639b16cf | #82 | correction | classifier | User flagged inconsistencies in builder view vs expected design | fix(desktop): relocate Builder identity to titlebar, refine toolbar + skeleton … |

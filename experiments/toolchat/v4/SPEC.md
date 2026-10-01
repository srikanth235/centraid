# v4 shared spec (read by every agent; do not change without the lead)

## 1. Relative-date terminals (grammar change)

Syntax, added to the canonical grammar:

```
RelDate := RelDay [ "at" Time ]
RelDay  := Weekday | "next" Weekday | "last" Weekday
         | "today" | "tomorrow" | "yesterday"
         | "the" Ordinal                      -- the 21st
         | "in" Num "days"
Weekday := "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
Time    := HH ":" MM                          -- 24h, e.g. 14:00
```

Where it is legal:

- ArgVal: anywhere a Date/DateTime literal is legal (`due_at: thursday`, `to: friday at 14:00`, `since: today`).
- Pred operand: `Field Cmp RelDate` (`due_at < friday`).
- Window: `Weekday`, `next Weekday`, `last Weekday`, `the Ordinal`, `in Num days` (no `at Time` in a window). `today`/`tomorrow`/`yesterday` stay the existing window PHRASES there.

Resolution (executor, against the session's `today`, never the model):

- `Weekday` = the next occurrence strictly after today (1..7 days ahead; today's own weekday = +7).
- `next Weekday` = that weekday in the Monday-start week after the current one.
- `last Weekday` = the most recent occurrence strictly before today.
- `today`/`tomorrow`/`yesterday` = today, +1, -1.
- `the Nth` = day N of the current month if N >= today's day, else day N of the next month.
- `in N days` = today + N.
- `at HH:MM` makes it a datetime; without it a date (the executor's existing default-time rules still apply, e.g. add_task due 09:00). Absolute ISO dates stay legal and are what the model writes when the user states an explicit date.

## 2. Chat format (training AND inference, byte-identical)

One session = one chat, rendered with Granite's own chat template (`tokenizer.apply_chat_template`), roles:

- `system`: exactly `today: <Weekday> <YYYY-MM-DD>` (e.g. `today: Monday 2026-06-15`). Nothing else.
- `user`: the person's words, verbatim.
- `assistant`: exactly one canonical line, nothing else. Loss on every assistant message. At inference the whole session so far is sent (llama-server `/v1/chat/completions`, `cache_prompt: true`), capped at the last 4 user/assistant pairs plus the system message; the reply is constrained by the GBNF grammar (gbnf.py) with the string-literal rule of section 3.

Session file row (jsonl): `{"id": "...", "today": "YYYY-MM-DD", "messages": [...], "template_id": "..."}`.

## 3. Literal constraint at decode

A quoted string the model writes must be one of: a contiguous word span of ANY user message in the session so far (as typed, lowercased, or with its first letter capitalised); or an enum/check value from `crates/evalsuite/grammar/derive/derived.json` `predicates[*][*].checkValues`; or a fixed small set of defaults (`"password"`, `"login"`, `"phone"`, `"email"`, `"call"`, `"visit"`, `"message"`, `"coffee"`, `"completed"`, `"Birthday"`, `"note"`, `"wifi"`, `"card"`). This is built per turn into the GBNF `string` rule.

## 4. Conventions the data must follow (the dev-90 failure groups)

- A: `called "X"`: X is the distinctive words the user said (drop articles, possessives, the kind noun): "the trip group" -> `groups called "trip"`. Never a title the user did not say. The executor matches case-insensitively by substring or all-words.
- C: the model never emits `clarify` (the executor clarifies ambiguity itself). `refuse` only for requests outside the vault (weather, web, booking with third parties, etc.), about 3% of turns, with the right reason.
- H: a title/summary/description/name the model CREATES starts with a capital letter and is the user's words minus the command phrasing ("add a task to pick up the prescription" -> `title: "Pick up the prescription"`). Amounts are minor units from words ("forty two dollars" -> 4200). `people.log_interaction` always carries `since:` (a RelDate or date). `schedule.propose_event` carries `dtend` = dtstart + 1h when the user gives no end.
- G: a relative day the user says is written as a RelDate, never computed.

## 5. v5 addendum: vault candidates in the prompt (binding for v5 data, trainer and eval)

A local retriever, `experiments/toolchat/v5/retrieve.py` (ONE implementation, imported by both data generation and evaluation), ranks the vault's labels against the user's request and appends the top matches to that user message:

```
<request as typed>
vault: tasks "Book the Tahoe cabin"; events "Book the Tahoe cabin"; notes "shortlist"; folder "Travel"
```

- `retrieve.py` API: `candidates(request: str, vault: list[dict], k=6) -> list[dict]` and `render(request, cands) -> str` (the user-message content above; when there are no candidates, the content is the request alone, with no `vault:` line). A vault entry is `{"kind": <grammar kind name, e.g. "tasks">, "label": <title/name>}` or a field value `{"field": "folder"|"notebooks"|"album_titles"|"role"|..., "label": <value>}` rendered as `folder "Travel"`.
- Scoring is deterministic and local: lowercase; strip possessive 's; drop function words (the, a, an, my, our, at, of, for, to, in, on, about, with, and, is, it, that, this, what, whats, s); light stemming (strip -ing, -ed, -es, -s); score = sum of idf of matched stems (idf over the vault's labels) with prefix matches counted at half weight; ties broken by label; only score > 0; top k=6.
- Each user message carries the vault line computed at the time it was said; history is replayed verbatim (so the prompt prefix is stable for the KV cache).
- The literal constraint (§3) additionally allows every candidate label shown in the session so far, exactly as shown.
- Convention for the model: when the right row is among the candidates, write its label EXACTLY (`tasks called "Book the Tahoe cabin"`, `documents that (folder = "Travel")`); otherwise write the user's distinctive words (§4-A).
- Training vaults are SYNTHETIC per session (invented labels from the out-of-world pools, ~40-150 entries, including the session's literals plus realistic distractors that share words). Evaluation vaults come from the evaluation worlds and must never reach training data or data generation.

### 5.1 Retrieval fixes (v5, before training)

- `candidates(request, vault, k=6, prev=None)`: when the request contains a pronoun or back-reference (she, her, he, him, they, them, it, that, those, the other, the same, there), score the vault against `request + " " + prev`, where `prev` is the previous USER message's raw text (not its rendered vault line); otherwise the request alone.
- Ranking: an entry whose normalised label equals a normalised contiguous span of the scored text (exact whole-name match, e.g. request word "Marco" and label "Marco") ranks above every partial match; then idf score as before.
- Prefix rule: only a request token of >= 4 characters that is a prefix of a label token (never the reverse).

### 5.2 Prompt length (v5)

Only the CURRENT user message carries its `vault:` line; history user messages are replayed as the raw request (`ft_chat.strip_vault`), in training and inference alike. Every assistant turn is trained in its own window with exactly the prompt inference sends.

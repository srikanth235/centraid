#!/usr/bin/env node
// Automations BUILDER-TO-RUN suite: closes the gap flows-automations-01-
// lifecycle.mjs's flow6 deliberately left open ("a full LLM build loop is
// not required here"). This suite drives "New automation" -> a real chat
// prompt -> waits for the agent's turn to actually finish writing a real
// handler.js (not the scaffold) -> publishes -> Run now -> verifies the
// RUN'S RESULT reflects the requested goal, via a real gateway read, not
// just `run.ok===true`.
//
// SOURCE-VERIFIED FACTS this suite relies on (read before touching timings
// or assertions):
//   - packages/automation/src/scaffold/scaffold.ts:174 -- the scaffold's
//     default `automation.json` prompt is the literal string
//     'Describe what this automation should do.' (SCAFFOLD_PROMPT below).
//     scaffold.ts:102-155 DEFAULT_HANDLER's body references the placeholder
//     tool name 'example.list_items' and returns `{summary:'nothing new'}`
//     when nothing matches -- both are literal scaffold-only markers a real
//     build should remove (SCAFFOLD_HANDLER_MARKERS below).
//   - apps/desktop/src/renderer/react/shell/routes/automationsData.ts:22-26
//     scaffoldAutomationDraft() mints `id = automation-<6 random chars>`
//     and calls createAutomation({id, name:'New automation', enabled:false})
//     with publish:true under the hood (gateway-client-editing.ts:347) --
//     the SCAFFOLD itself is already live/published the instant "New
//     automation" is clicked, before any chat turn.
//   - apps/desktop/src/renderer/react/shell/routes/builder/useBuilder.ts:
//     215-312 handleStreamEvent -- the chat turn's SSE stream ends on a
//     'final' (or 'aborted') event, which calls finishAgentTurn() (line
//     184-195): sets `generating.current=false`, closes the AI/thinking
//     bubbles. The chat pane (BuilderChatPane.tsx:240-258) renders a
//     `role="status"` progress strip with `aria-label="<verb> — running"`
//     for the ENTIRE duration `generating===true` (turnProgress() always
//     returns a non-null value while generating, so this element mounts
//     once at turn start and unmounts exactly once at turn end -- a single,
//     unambiguous "the turn is done" signal, confirmed by reading the
//     component instead of guessing at a fixed sleep).
//   - CRITICAL: the turn's own file-write tool calls (write/edit/multi_edit)
//     land in the SAME shared draft session apps-store-routes.ts's Code tab
//     and Publish button use -- `desktop-<appId>` (apps/desktop/src/main/
//     app-sessions.ts:48-50, `desktopSessionIdFor`). They do NOT auto-
//     publish (unified-conversation-runner.ts:22-26's own header comment:
//     "Code edits STAGE in the draft worktree... The user clicks Publish to
//     flip the live version."). `useBuilder.ts`'s `refreshAutomationRow`
//     (called from `finishAgentTurn`) re-reads via `listAutomations()`,
//     which resolves off `getActiveMainLink()` -- the PUBLISHED tree
//     (packages/gateway/src/routes/automations-routes.ts:248,368) -- so the
//     Config pane will still show the OLD scaffold content right after the
//     chat turn ends, until something publishes. For an automation,
//     useBuilder.ts:655-659's primary button is 'Enable'/'Disable', not
//     'Publish' -- but `handleToggleEnabled` -> `setAutomationEnabled(...)`
//     always sends `publish:true` (gateway-client-editing.ts:370), which
//     ff-merges the WHOLE staged session (handler.js included) to `main`
//     (lifecycle-automation-routes.ts:121,136-143). So this suite verifies
//     the STAGED build immediately after the turn (reading the draft
//     session's files directly, via the SAME `desktop-<appId>` session id),
//     THEN clicks "Enable" as the publish step, THEN re-verifies via the
//     live `GET /centraid/_automations/read`.
//   - packages/skills/skills/automation-authoring/SKILL.md documents ONLY
//     `ctx.tool(name,args)` / `ctx.agent({prompt,json})` / `ctx.state` /
//     `ctx.runs` / `ctx.input` to the authoring LLM -- it never mentions
//     `ctx.vault`. `ctx.tool` names are a HARD ALLOWLIST against
//     `requires.tools` (packages/automation/src/handler/runner.ts:643-668)
//     with no built-in host tool for anything like "list installed apps" --
//     the scaffold's own 'example.list_items' is explicitly a placeholder
//     ("Replace ... with the real one for your task", scaffold.ts:140) that
//     FAILS at fire time if kept. `ctx.agent`'s `json` schema is enforced
//     provider-side for codex but NOT validated/shown to the model at all
//     for the claude backend (packages/agent-runtime/src/automation/
//     run-automation-live-dispatch.ts:192,224-228) -- so an exact-string
//     LLM answer is not guaranteed.
//   - GOAL CHOSEN (see full rationale in the final report): a *zero-
//     dependency, zero-grant* automation whose handler does NOT call
//     ctx.tool/ctx.agent/ctx.vault at all -- just deterministically returns
//     a fixed literal summary string. This is the only goal in the brief's
//     suggested list that is actually reachable given the researched
//     toolset (no built-in "list apps" ctx.tool exists; ctx.vault needs an
//     explicit owner grant the builder chat cannot mint, and isn't taught to
//     the authoring LLM anyway). Deterministic, mechanically checkable
//     against the run's own `summary`/`outputJson` -- no LLM judgment call
//     needed at verification time.
//
// HARNESS NOTES carried over verbatim from suites 01-05 (read first):
//   - the enable switch is a visually-hidden `<input role="switch">` --
//     `waitFor({state:'attached'})` not 'visible', click the `<label>`
//     wrapper, not the 0x0 input.
//   - timeline node heads: `button[class*="tlHead"]`.
//   - `document.body.innerText` is CSS-uppercased on some labels -- match
//     case-insensitively.
//   - console-error filters must check `msg.location().url` (frameUrl),
//     never the message text.
//   - NEVER use a bare `[aria-expanded]` selector.
//
// Run with: node apps/desktop/tests/e2e-live/flows-automations-06-builder-to-run.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-06-builder-to-run');

// ---- scaffold-default literal markers (scaffold.ts) ----
const SCAFFOLD_PROMPT = 'Describe what this automation should do.';
const SCAFFOLD_HANDLER_MARKERS = ['example.list_items', "summary: 'nothing new'", 'nothing new'];

// ---- the goal we give the builder ----
const GOAL_MARKER = 'automation smoke test ok';
const GOAL_PROMPT =
  `When this automation runs, do NOT call any AI model, any ctx.tool, or any vault data -- ` +
  `just deterministically return this exact fixed result so it is trivial to verify by a test: ` +
  `{ summary: "${GOAL_MARKER}" }. Write plain JavaScript with no external calls at all. ` +
  `Make it manual-only -- no scheduled trigger.`;
const NUDGE_PROMPT =
  `Please just write the handler now exactly as I described -- no scheduled trigger, no ctx.tool, ` +
  `no ctx.agent, no vault calls, just \`return { summary: "${GOAL_MARKER}" };\` verbatim. Do not ask ` +
  `further questions, just make the edit.`;

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const results = [];
let page;
let session;
const consoleMessages = [];
const findings = [];

function note(msg) {
  findings.push(msg);
  console.log(`[auto06] FINDING: ${msg}`);
}

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({
      text: msg.text(),
      type: msg.type(),
      frameUrl: msg.location()?.url ?? '',
    });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
  });
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err?.stack ?? String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-auto06-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `auto06-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.innerText);
}

// ---- out-of-band gateway JSON fetch (owner-device auth, same pattern as
// flows-automations-01/02/03/04/05.mjs) ----
async function gwFetch(pathAndQuery, opts = {}) {
  return page.evaluate(
    async ({ pathAndQuery, method, body }) => {
      const auth = await window.CentraidApi.getGatewayAuth();
      const headers = { 'content-type': 'application/json' };
      if (auth.token) headers.authorization = `Bearer ${auth.token}`;
      if (auth.vaultId) headers['x-centraid-vault'] = auth.vaultId;
      const res = await fetch(`${auth.baseUrl}${pathAndQuery}`, {
        method: method ?? 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    { pathAndQuery, method: opts.method, body: opts.body },
  );
}

async function gwListAutomations() {
  const { json } = await gwFetch('/centraid/_automations');
  return json?.rows ?? [];
}

async function gwFindRow(name) {
  const rows = await gwListAutomations();
  return rows.find((r) => r.name === name) ?? null;
}

async function gwReadAutomation(ref) {
  const { json } = await gwFetch(`/centraid/_automations/read?ref=${encodeURIComponent(ref)}`);
  return json?.row ?? null;
}

async function gwRuns(ref, limit = 20) {
  const { json } = await gwFetch(
    `/centraid/_automations/runs?ref=${encodeURIComponent(ref)}&limit=${limit}`,
  );
  return json?.runs ?? [];
}

async function gwReadRun(runId) {
  const { json } = await gwFetch(`/centraid/_automations/run?runId=${encodeURIComponent(runId)}`);
  return json?.run ?? null;
}

/** GET /_apps/<appId>/files?sessionId=<id> -- {files:[{path,content}]},
 *  same helper shape as suites 03/04/05. Used both to read the SAME
 *  `desktop-<appId>` session the builder chat itself writes into (staged,
 *  pre-publish check) and, via a freshly opened session, to read files off
 *  a currently-live ref (post-publish spot check). */
async function getDraftFile(appId, sessionId, rel) {
  const res = await gwFetch(
    `/centraid/_apps/${encodeURIComponent(appId)}/files?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (res.status !== 200) return { status: res.status, content: null, files: [] };
  const files = res.json?.files ?? [];
  const file = files.find((f) => f.path === rel);
  return { status: res.status, content: file?.content ?? null, files: files.map((f) => f.path) };
}

async function openAutomationsOverview() {
  await navTo(page, 'Automations');
  await page
    .getByRole('heading', { name: 'Automations', level: 1 })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function openAutomationView(name) {
  await openAutomationsOverview();
  const row = page.getByRole('button', { name: new RegExp(esc(name)) }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
  await page
    .getByRole('heading', { name, level: 1 })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function runNowFromViewScreen() {
  const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
  await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await runBtn.click();
}

/** Poll BuilderChatPane's `role="status"` progress strip
 *  (`aria-label="<verb> — running"`, mounted for the WHOLE turn per
 *  useBuilder.ts's turnProgress()) until it disappears -- the one clean,
 *  source-verified "this chat turn is done" signal, not a blind sleep. */
async function waitForTurnToFinish(maxMs) {
  const statusLoc = page.getByRole('status', { name: /running/i });
  // First, confirm the turn actually started (progress strip appeared) --
  // bounded short wait, since 'assistant.start' should land within seconds.
  let started = false;
  const startDeadline = Date.now() + 20_000;
  while (Date.now() < startDeadline) {
    if ((await statusLoc.count()) > 0) {
      started = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log(`[auto06] turn-progress strip appeared within 20s: ${started}`);

  const deadline = Date.now() + maxMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const n = await statusLoc.count().catch(() => -1);
    if (n === 0) return { finished: true, started, elapsedMs: maxMs - (deadline - Date.now()) };
    if (Date.now() - lastLog > 15_000) {
      const label =
        n > 0
          ? await statusLoc
              .first()
              .getAttribute('aria-label')
              .catch(() => null)
          : null;
      console.log(
        `[auto06] still waiting on the turn... progress strip present, aria-label=${JSON.stringify(label)}`,
      );
      lastLog = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  return { finished: false, started, elapsedMs: maxMs };
}

async function lastAiMessageText() {
  return page.evaluate(() => {
    // chatCss.aiText paragraphs -- CSS-module class, substring-match per
    // harness convention (never guess at a bare class name).
    const nodes = Array.from(document.querySelectorAll('[class*="aiText"]'));
    const last = nodes[nodes.length - 1];
    return last ? last.innerText : null;
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[auto06] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  let automationAppId = null;
  let automationRef = null;
  let sessionId = null;
  let stagedHandlerAfterTurn = null;
  let currentName = 'New automation';

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // -----------------------------------------------------------------
    // FLOW: builder-full-build
    // -----------------------------------------------------------------
    await step(
      'builder-full-build',
      'New automation -> send the chosen goal -> wait (bounded) for the SSE turn to finish -> confirm the STAGED draft handler.js/automation.json actually changed from the scaffold',
      async () => {
        await openAutomationsOverview();
        const newBtn = page.getByRole('button', { name: 'New automation' });
        await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await newBtn.click();

        // scaffoldAutomationDraft() mints a REAL, already-published gateway
        // row named "New automation" before the builder even paints.
        await page
          .getByRole('button', { name: 'Config' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot('01-builder-opened-scaffold');

        const scaffoldRow = await gwFindRow('New automation');
        assert(
          Boolean(scaffoldRow),
          'expected a "New automation" gateway row to exist immediately after clicking New automation',
        );
        automationRef = scaffoldRow.ref;
        automationAppId = scaffoldRow.ref.split('/')[0];
        sessionId = `desktop-${automationAppId}`;
        console.log(
          `[auto06] scaffolded ref=${automationRef} appId=${automationAppId} sessionId=${sessionId}`,
        );
        assert(
          scaffoldRow.manifest?.prompt === SCAFFOLD_PROMPT,
          `expected the fresh scaffold's prompt to be the literal default, got ${JSON.stringify(scaffoldRow.manifest?.prompt)}`,
        );

        console.log(`[auto06] goal prompt sent to the builder: ${JSON.stringify(GOAL_PROMPT)}`);
        const textarea = page.getByPlaceholder('Describe a change…');
        await textarea.waitFor({ state: 'visible', timeout: 10_000 });
        await textarea.fill(GOAL_PROMPT);
        await page.getByRole('button', { name: 'Send' }).click();

        // Bounded wait #1 for the turn to finish -- up to 6 minutes of real
        // LLM turn time, polling the role="status" progress strip per the
        // source-verified signal above, never a blind sleep.
        let result = await waitForTurnToFinish(6 * 60_000);
        console.log(`[auto06] first turn result: ${JSON.stringify(result)}`);
        await shot('02-after-first-turn');

        let staged = await getDraftFile(
          automationAppId,
          sessionId,
          `automations/${automationAppId}/automation.json`,
        );
        let stagedManifest = staged.content ? JSON.parse(staged.content) : null;
        let stagedHandler = await getDraftFile(
          automationAppId,
          sessionId,
          `automations/${automationAppId}/handler.js`,
        );
        console.log(
          `[auto06] staged draft session files after turn 1: ${JSON.stringify(staged.files)}; ` +
            `manifest.prompt=${JSON.stringify(stagedManifest?.prompt)}; handler present=${Boolean(stagedHandler.content)}`,
        );

        const promptChanged = Boolean(stagedManifest) && stagedManifest.prompt !== SCAFFOLD_PROMPT;
        const handlerChanged =
          Boolean(stagedHandler.content) &&
          !SCAFFOLD_HANDLER_MARKERS.some((m) => stagedHandler.content.includes(m)) &&
          stagedHandler.content.includes('export default');
        console.log(
          `[auto06] after turn 1: promptChanged=${promptChanged} handlerChanged=${handlerChanged}`,
        );

        // If the agent asked a clarifying question instead of writing code
        // (result.finished but no real file change), or aborted early, send
        // ONE bounded follow-up nudge rather than declaring failure outright
        // -- a real user would do the same. Still inside an overall bounded
        // budget (per the task brief's "generous but bounded" instruction).
        if (result.finished && !(promptChanged && handlerChanged)) {
          const lastMsg = await lastAiMessageText();
          note(
            `after the FIRST turn, the staged handler.js/automation.json had NOT meaningfully changed from the scaffold ` +
              `(promptChanged=${promptChanged}, handlerChanged=${handlerChanged}). Last AI message: ${JSON.stringify((lastMsg ?? '').slice(0, 400))}. ` +
              `Sending one bounded follow-up nudge rather than failing outright.`,
          );
          await textarea.waitFor({ state: 'visible', timeout: 10_000 });
          await textarea.fill(NUDGE_PROMPT);
          await page.getByRole('button', { name: 'Send' }).click();
          result = await waitForTurnToFinish(2 * 60_000);
          console.log(`[auto06] nudge-turn result: ${JSON.stringify(result)}`);
          await shot('03-after-nudge-turn');

          staged = await getDraftFile(
            automationAppId,
            sessionId,
            `automations/${automationAppId}/automation.json`,
          );
          stagedManifest = staged.content ? JSON.parse(staged.content) : null;
          stagedHandler = await getDraftFile(
            automationAppId,
            sessionId,
            `automations/${automationAppId}/handler.js`,
          );
          console.log(
            `[auto06] staged draft session files after nudge: ${JSON.stringify(staged.files)}; ` +
              `manifest.prompt=${JSON.stringify(stagedManifest?.prompt)}; handler present=${Boolean(stagedHandler.content)}`,
          );
        }

        stagedHandlerAfterTurn = stagedHandler.content;
        await shot('04-builder-config-tab-after-build');

        if (!result.finished) {
          const lastMsg = await lastAiMessageText();
          note(
            `BUILD DID NOT CONVERGE within the bounded budget -- the turn-progress strip never disappeared. ` +
              `started=${result.started}, last AI message seen: ${JSON.stringify((lastMsg ?? '').slice(0, 500))}. ` +
              `See auto06-04-builder-config-tab-after-build.png for the exact stuck state. Documenting honestly, not fabricating a pass.`,
          );
          await shot('FAIL-builder-never-converged');
        }
        assert(
          result.finished,
          'the builder chat turn never finished (progress strip never disappeared) within the bounded budget -- see findings for the exact stuck state',
        );

        const finalPromptChanged =
          Boolean(stagedManifest) && stagedManifest.prompt !== SCAFFOLD_PROMPT;
        const finalHandlerChanged =
          Boolean(stagedHandler.content) &&
          !SCAFFOLD_HANDLER_MARKERS.some((m) => stagedHandler.content.includes(m)) &&
          stagedHandler.content.includes('export default');
        console.log(
          `[auto06] FINAL staged-build check: promptChanged=${finalPromptChanged} handlerChanged=${finalHandlerChanged}`,
        );
        console.log(`[auto06] staged handler.js full content:\n${stagedHandler.content}`);
        note(
          `staged handler.js after the builder turn(s) (session=${sessionId}):\n\`\`\`\n${stagedHandler.content}\n\`\`\`\n` +
            `automation.json prompt: ${JSON.stringify(stagedManifest?.prompt)}`,
        );

        assert(
          finalPromptChanged,
          `expected the staged automation.json's prompt to differ from the scaffold default "${SCAFFOLD_PROMPT}", got ${JSON.stringify(stagedManifest?.prompt)}`,
        );
        assert(
          finalHandlerChanged,
          `expected the staged handler.js to be real generated code (no scaffold markers, has "export default"), got:\n${stagedHandler.content}`,
        );

        const hasGoalMarker = (stagedHandler.content ?? '').toLowerCase().includes(GOAL_MARKER);
        console.log(
          `[auto06] staged handler.js literally contains the requested marker string "${GOAL_MARKER}": ${hasGoalMarker}`,
        );
        note(
          `the builder's authored handler.js DOES contain the literal requested marker string "${GOAL_MARKER}": ${hasGoalMarker} -- ` +
            `this is evidence (not proof) that it followed the "return this exact string" instruction; the load-bearing check is the ` +
            `actual RUN's result, verified in the run-now-real-execution flow below.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: publish-and-verify-plan
    // -----------------------------------------------------------------
    await step(
      'publish-and-verify-plan',
      "Click Enable (automations' publish-equivalent primary action) -> GET /centraid/_automations/read shows real handler-backed manifest, not the scaffold default",
      async () => {
        assert(Boolean(automationRef), 'need a scaffolded automation ref from the previous flow');

        const before = await gwReadAutomation(automationRef);
        console.log(
          `[auto06] gateway row BEFORE publish: enabled=${before?.enabled} prompt=${JSON.stringify(before?.manifest?.prompt)}`,
        );
        assert(
          before?.manifest?.prompt === SCAFFOLD_PROMPT,
          'expected the LIVE manifest to still show the scaffold default prompt before publish (confirms the turn truly only staged, did not auto-publish)',
        );

        const enableBtn = page.getByRole('button', { name: 'Enable', exact: true });
        await enableBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await enableBtn.click();
        await page.waitForTimeout(1200);
        await shot('05-after-enable-click');

        // Poll the live read until the manifest reflects the staged prompt
        // (publish is effectively synchronous but give it a bounded margin).
        const deadline = Date.now() + 20_000;
        let after = null;
        while (Date.now() < deadline) {
          after = await gwReadAutomation(automationRef);
          if (after?.manifest?.prompt !== SCAFFOLD_PROMPT) break;
          await page.waitForTimeout(700);
        }
        console.log(
          `[auto06] gateway row AFTER publish: enabled=${after?.enabled} prompt=${JSON.stringify(after?.manifest?.prompt)}`,
        );
        assert(
          after?.enabled === true,
          `expected the automation to be enabled after clicking Enable, got ${JSON.stringify(after?.enabled)}`,
        );
        assert(
          after?.manifest?.prompt !== SCAFFOLD_PROMPT,
          'expected the LIVE manifest prompt to have updated off the scaffold default after publish',
        );
        currentName = after?.manifest?.name || currentName;

        // Config/hero on the builder's own Config tab should now also show
        // the real plan (Enable does not navigate away).
        await shot('06-builder-config-tab-after-publish');
        const builderBodyTxt = await bodyText();
        const stillSaysNotDescribed = /not described yet\./i.test(builderBodyTxt);
        console.log(
          `[auto06] Builder Config tab still shows "Not described yet." placeholder after publish: ${stillSaysNotDescribed}`,
        );
        assert(
          !stillSaysNotDescribed,
          'expected the builder\'s own Config tab to no longer show the "Not described yet." placeholder after publish',
        );

        // Now the automation's real VIEW screen (not the builder) -- hero
        // behavior/prompt block, screenshotted per the brief.
        await openAutomationView(currentName);
        await shot('07-automation-view-hero-after-publish');
        const viewBodyTxt = await bodyText();
        console.log(
          `[auto06] automation view body (first 500 chars): ${viewBodyTxt.slice(0, 500).replace(/\n/g, ' | ')}`,
        );
        assert(
          !/Describe what this automation should do\./i.test(viewBodyTxt),
          'expected the automation VIEW screen to show a real prompt, not the scaffold placeholder',
        );

        note(
          `publish-and-verify-plan: after clicking "Enable" (the automations builder's publish-equivalent primary action, ` +
            `useBuilder.ts handleToggleEnabled -> setAutomationEnabled(..., publish:true)), GET /centraid/_automations/read ` +
            `for ref=${automationRef} now returns manifest.prompt=${JSON.stringify(after?.manifest?.prompt)} -- a real, ` +
            `builder-written plan, no longer the scaffold's "${SCAFFOLD_PROMPT}" placeholder. Both the builder's own Config tab ` +
            `and the automation's real View-screen hero reflect it.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: run-now-real-execution
    // -----------------------------------------------------------------
    await step(
      'run-now-real-execution',
      'Run now on the published, builder-authored automation -> the run resolves -> its summary/output genuinely reflects the requested goal (a real gateway read, not just run.ok===true)',
      async () => {
        assert(Boolean(automationRef), 'need the published automation ref from the previous flows');
        await openAutomationView(currentName);
        await shot('08-view-before-run-now');

        await runNowFromViewScreen();
        await shot('09-run-view-after-click');

        // Same polling shape as flows-automations-01-lifecycle.mjs's
        // flow3 -- [data-status] on the run-view timeline, bounded 90s
        // (this handler makes zero external calls, so it should resolve
        // fast; margin included for worker spin-up).
        const deadline = Date.now() + 90_000;
        let finalStatus = 'pending';
        while (Date.now() < deadline) {
          const nodes = page.locator('[data-status]');
          const n = await nodes.count();
          if (n > 0) {
            finalStatus = await nodes.last().getAttribute('data-status');
            if (finalStatus === 'ok' || finalStatus === 'fail') break;
          }
          await page.waitForTimeout(700);
        }
        console.log(`[auto06] run final timeline data-status: ${finalStatus}`);
        await shot('10-run-view-settled');
        assert(
          finalStatus === 'ok' || finalStatus === 'fail',
          `run did not resolve within 90s, stuck at data-status=${finalStatus}`,
        );

        const runs = await gwRuns(automationRef, 5);
        const latest = runs[0];
        assert(Boolean(latest), 'expected at least one run record after Run now');
        console.log(`[auto06] latest run record: ${JSON.stringify(latest)}`);

        const runDetail = await gwReadRun(latest.runId);
        console.log(
          `[auto06] full run detail via GET /_automations/run?runId=: ${JSON.stringify(runDetail)}`,
        );
        await shot('11-run-view-timeline-detail');

        let outputObj = null;
        try {
          outputObj = runDetail?.outputJson ? JSON.parse(runDetail.outputJson) : null;
        } catch {
          /* leave null, logged below */
        }
        const summaryText = (runDetail?.summary ?? '') + ' ' + JSON.stringify(outputObj ?? {});
        const resultMatchesGoal = summaryText.toLowerCase().includes(GOAL_MARKER);
        console.log(
          `[auto06] run.ok=${runDetail?.ok} run.error=${JSON.stringify(runDetail?.error)} run.summary=${JSON.stringify(runDetail?.summary)} ` +
            `run.outputJson=${JSON.stringify(runDetail?.outputJson)} parsedOutput=${JSON.stringify(outputObj)} ` +
            `resultMatchesGoal("${GOAL_MARKER}")=${resultMatchesGoal}`,
        );

        note(
          `run-now-real-execution: ref=${automationRef} runId=${latest.runId} ok=${runDetail?.ok} ` +
            `summary=${JSON.stringify(runDetail?.summary)} outputJson=${JSON.stringify(runDetail?.outputJson)} -- ` +
            `resultMatchesGoal=${resultMatchesGoal} (goal marker: "${GOAL_MARKER}"). This is the load-bearing, deterministic ` +
            `proof that the automation's OWN handler code executed for real (not the scaffold's "nothing new"/"example.list_items"), ` +
            `since the exact fixed string was requested and checked mechanically, no LLM judgment call needed at verification time.`,
        );

        assert(
          runDetail?.ok === true,
          `expected the run to succeed (ok:true), got ok=${runDetail?.ok} error=${JSON.stringify(runDetail?.error)}`,
        );
        assert(
          resultMatchesGoal,
          `expected the run's summary/output to contain the requested goal marker "${GOAL_MARKER}", got summary=${JSON.stringify(runDetail?.summary)} outputJson=${JSON.stringify(runDetail?.outputJson)}`,
        );

        // Timeline node expand (best-effort, same tlHead convention as
        // suites 01-05) -- downstream evidence screenshot for the report.
        const nodeHeads = page.locator('button[class*="tlHead"]');
        if ((await nodeHeads.count()) > 0) {
          await nodeHeads.first().click();
          await page.waitForTimeout(300);
          await shot('12-run-view-timeline-expanded');
        }
        const logTab = page.getByRole('tab', { name: 'Log' });
        if ((await logTab.count()) > 0) {
          await logTab.click();
          await page.waitForTimeout(300);
          await shot('13-run-view-log-mode');
        }
      },
    );

    // -----------------------------------------------------------------
    // FLOW: console-sweep
    // -----------------------------------------------------------------
    await step(
      'console-sweep',
      'Zero unexpected console errors across the whole suite',
      async () => {
        const allErrors = consoleMessages.filter((m) => m.type === 'error');
        for (const e of allErrors) console.log(`  CONSOLE ERROR: ${e.text} (${e.frameUrl})`);
        assert(
          allErrors.length === 0,
          `expected 0 console errors across the suite, got ${allErrors.length}: ${JSON.stringify(allErrors.map((e) => e.text))}`,
        );
      },
    );

    // -----------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AUTOMATIONS BUILDER-TO-RUN VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('============================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`Console warnings: ${consoleMessages.filter((m) => m.type === 'warning').length}`);
    console.log('\n---- FINDINGS ----');
    for (const f of findings) console.log(`- ${f}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll automations-builder-to-run steps PASSED.');
    }
  } finally {
    await session.close();
    // Deliberately keep USER_DATA_DIR (not rm'd) for cross-referencing
    // screenshots/logs against the on-disk vault after the run.
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

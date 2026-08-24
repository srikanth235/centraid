// governance: allow-repo-hygiene file-size-limit — pure content table: the 10 journeys, ACTS, MAPPING, and GLOSSARY are one normative dataset authors edit as a unit.
/* ============================================================================
   Centraid Explorer — narrated journeys across the Sovereign Isle.
   Every beat cites its repo source; vocabulary is binding:
   conversation ⊃ turn ⊃ item, never "chat" for the ledger.
   Beat.cam  → ISLE focus (+ orbit tweaks).  Beat.fx → timeline ops (seconds).
   ============================================================================ */
"use strict";

const DOC = (f) => "../" + f;
const srcOf = (file, anchor) => ({
  label: file,
  url: DOC(file) + (anchor || ""),
});

/* ── progressive disclosure: acts per journey (rail headers) ─────────────── */
window.ACTS = {
  boot: [
    [0, "WATCH"],
    [2, "MECHANISM"],
    [5, "SETTLED"],
  ],
  message: [
    [0, "WATCH"],
    [2, "MECHANISM"],
    [5, "THE TWIST"],
  ],
  harness: [
    [0, "WATCH"],
    [2, "MECHANISM"],
    [4, "CONSENT"],
  ],
  photo: [
    [0, "WATCH"],
    [2, "MECHANISM"],
    [5, "SHARING"],
    [6, "BACKUP"],
  ],
  dark: [
    [0, "READS"],
    [3, "WRITES"],
    [5, "SYNC"],
    [7, "HONESTY"],
  ],
  stolen: [
    [0, "WATCH"],
    [1, "EVERY SLOT"],
    [6, "WHAT HOLDS"],
  ],
  pair: [
    [0, "WATCH"],
    [2, "MECHANISM"],
  ],
  clerk: [
    [0, "WATCH"],
    [1, "MECHANISM"],
  ],
  commons: [
    [0, "WATCH"],
    [1, "MECHANISM"],
  ],
  welcome: [
    [0, "WATCH"],
    [3, "INSIDE"],
  ],
};

window.JOURNEYS = [
  /* ── welcome ─────────────────────────────────────────────────────────────── */
  {
    id: "welcome",
    tab: "THE ISLE",
    title: "Welcome to the isle",
    beats: [
      {
        t: "One isle per person",
        text: "Centraid is personal software over a sovereign vault: every vault belongs to exactly one owner — forever. This floating isle is one person's data, self-contained, with a visible edge.",
        src: srcOf("ARCHITECTURE.md", "#vault-ownership-and-sharing-726"),
        cam: { focus: "isle" },
        xr: true,
        fx: [{ k: "pulse", el: "isle", on: true }],
      },
      {
        t: "One gate",
        text: "The only way in is the gatehouse — the gateway, the HTTP surface of @centraid/server. Loopback callers carry a Bearer derived from custody; remote devices prove enrolled identities on the tunnel. There is no password plane.",
        src: srcOf("ARCHITECTURE.md"),
        cam: { focus: "gate" },
        fx: [
          { k: "pulse", el: "isle", on: false },
          { k: "pulse", el: "gate", on: true },
          {
            k: "callout",
            at: [15.5, 9, 46],
            tone: "warn",
            title: "KEY CABINET · keys/",
            body: "Every secret on the isle lives in this one cabinet — self-describing encrypted envelopes under OS custody.",
          },
        ],
      },
      {
        t: "Four visitors, one gate code",
        text: "Four seats, one gate code: the desktop thin client (loopback Bearer), the web PWA (relay-only — its thread must climb the beacon), the mobile app over HTTP, and the deliberately tiny companion. None embeds a backend.",
        src: srcOf("ARCHITECTURE.md", "#overview"),
        cam: {
          focus: "custom",
          r: 190,
          theta: 0.42,
          phi: 0.95,
          target: [10, -10, 45],
        },
        fx: [
          { k: "cclear" },
          { k: "pulse", el: "gate", on: false },
          {
            k: "callout",
            at: [0, 4, 70],
            tone: "info",
            title: "THE BRIDGE",
            body: "iroh QUIC tunnel — packages/tunnel. Browsers have no UDP, so the web seat's thread climbs the relay beacon.",
          },
          {
            k: "spawn",
            id: "w1",
            path: [
              [0, 3.6, 100],
              [0, 3.6, 70],
              [0, 3.6, 50],
            ],
            color: "slate",
            speed: 0.1,
          },
          {
            k: "spawn",
            id: "w2",
            path: [
              [-34, 0, 74],
              [-20, 1, 62],
              [0, 3.6, 50],
            ],
            color: "indigo",
            speed: 0.09,
            wait: 1.2,
          },
          {
            k: "spawn",
            id: "w3",
            path: [
              [70, -6, 34],
              [60, 40, 36],
              [36, 2, 28],
              [8, 3.6, 44],
            ],
            color: "relay",
            speed: 0.07,
            wait: 2.2,
          },
          {
            k: "spawn",
            id: "w4",
            path: [
              [-80, 0, 46],
              [-50, 2, 36],
              [-4, 3.6, 46],
            ],
            color: "rose",
            speed: 0.08,
            wait: 3.4,
          },
        ],
      },
      {
        t: "What lives on the isle",
        text: "The vault drum and its blob cellar, the ledger archive, the automation hall, the commons circle, the consent desk by the gate — and the eight app pavilions at the rim, each in its real identity hue. We will walk each one.",
        src: srcOf("ARCHITECTURE.md", "#workspace-layout"),
        cam: { focus: "isle" },
        fx: [
          { k: "clearA" },
          { k: "pulse", el: "vault", on: true },
          { k: "wait", s: 1 },
          { k: "pulse", el: "ledger", on: true },
          { k: "wait", s: 1 },
          { k: "pulse", el: "automation", on: true },
          { k: "wait", s: 1 },
          { k: "pulse", el: "commons", on: true },
          { k: "wait", s: 1 },
          { k: "pulse", el: "clerk", on: true },
        ],
      },
    ],
  },

  /* ── first light (bootstrapping) ─────────────────────────────────────────── */
  {
    id: "boot",
    tab: "FIRST LIGHT",
    title: "First light — the isle builds itself",
    beats: [
      {
        t: "A blank machine",
        text: "Every isle begins as an empty directory. Centraid ships as a daemon — centraid-gateway under a dataDir — and a fresh data dir holds nothing: no accounts, no cloud, no ceremony.",
        src: srcOf("ARCHITECTURE.md", "#on-disk-layout"),
        cam: {
          focus: "custom",
          r: 200,
          theta: 0.47,
          phi: 0.9,
          target: [0, 0, 40],
        },
        fx: [{ k: "reset" }, { k: "build", p: 0 }],
      },
      {
        t: "The gateway founds itself",
        text: "The daemon boots — and a fresh data dir is never zero-vault: at construction the gateway auto-founds one marked Personal vault, enrolls the host device's owner, and records the pairing in vault_owners. Silently, in one transaction. Founding is simply the first mint.",
        src: srcOf("docs/glossary.md", "#owners-gateway-726"),
        cam: { focus: "isle", r: 170, phi: 0.9 },
        fx: [
          { k: "build", p: 1 },
          { k: "wait", s: 2.4 },
          {
            k: "callout",
            at: [-6, 8, 10],
            tone: "info",
            title: "AUTO-FOUND · #603",
            body: "no founding ticket, no recovery ceremony, no first-run wizard. The gateway is never zero-vault.",
          },
        ],
      },
      {
        t: "The keys come first",
        text: "keys/ is the only secret-bearing directory: the endpoint identity, the per-vault DEK, every backup epoch — each a self-describing encrypted envelope. The vault's own identity keypair is minted at creation.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: { focus: "keycab" },
        fx: [
          { k: "pulse", el: "keycab", on: true },
          {
            k: "callout",
            at: [15.5, 9, 46],
            tone: "warn",
            title: "keys/",
            body: "gateway.db holds no secrets — sealed columns there store ciphertext only. This cabinet is the estate's entire key material.",
          },
        ],
      },
      {
        t: "One owner, forever",
        text: "vault_owners(vault_id PRIMARY KEY, owner_id) — the primary key IS the one-owner invariant. Exactly one owner per vault, across migrations; no roles, no partial authority, no member lattice to escalate.",
        src: srcOf("SECURITY.md"),
        cam: { focus: "vault" },
        fx: [
          { k: "pulse", el: "keycab", on: false },
          { k: "pulse", el: "vault", on: true },
          {
            k: "callout",
            at: [0, 26, -2],
            tone: "info",
            title: "THE MINT",
            body: "minting confers no authority to the minter — ownership is the new owner's from that moment, and never returns.",
          },
        ],
      },
      {
        t: "The first seat enrolls",
        text: "The host device enrolls as the owner's first seat. Its loopback Bearer is derived from custody — HMAC over the endpoint key — never written to disk, never printed. Authentication is the transport; there is no password plane.",
        src: srcOf("SECURITY.md"),
        cam: { focus: "gate" },
        fx: [
          { k: "pulse", el: "vault", on: false },
          { k: "pulse", el: "gate", on: true },
          {
            k: "spawn",
            id: "b1",
            path: [
              [0, 2, 100],
              [0, 3.6, 70],
              [0, 3.6, 54],
            ],
            color: "slate",
            s: 1.5,
            speed: 0.07,
          },
        ],
      },
      {
        t: "Now it can serve",
        text: "The isle is complete: the gate admits, the vault keeps, the ledger records, the hall automates. Every journey from here is this one world, running. Next: send a message through it.",
        src: srcOf("ARCHITECTURE.md"),
        cam: { focus: "isle" },
        fx: [
          { k: "remove", id: "b1" },
          { k: "pulse", el: "gate", on: false },
          { k: "pulse", el: "isle", on: true },
        ],
      },
    ],
  },

  /* ── pair a seat (pairing + replica bootstrap) ───────────────────────────── */
  {
    id: "pair",
    tab: "PAIR A SEAT",
    title: "Pair a seat — a device joins",
    beats: [
      {
        t: "The owner mints a ticket",
        text: "Adding a seat starts at the gate: the owner mints a pair ticket — one-time, time-boxed, its secret stored only as a sha256. It is the only ticket kind: always join an existing gateway.",
        src: srcOf("docs/glossary.md", "#pairing"),
        cam: { focus: "gate" },
        fx: [
          { k: "reset" },
          { k: "pulse", el: "gate", on: true },
          {
            k: "callout",
            at: [0, 18, 50],
            tone: "info",
            title: "PAIR TICKET",
            body: "minted by an owner, burns on redeem. A wrong guess never consumes the real owner's ticket.",
          },
        ],
      },
      {
        t: "The ticket rides to the new device",
        text: "The ticket is shown as a QR and redeemed over the tunnel. Redemption is a single conditional transaction — a second claimant, correct secret or not, finds the ticket gone.",
        src: srcOf("SECURITY.md"),
        cam: {
          focus: "custom",
          r: 110,
          theta: 0.35,
          phi: 1,
          target: [-20, -2, 62],
        },
        fx: [
          { k: "pulse", el: "gate", on: false },
          {
            k: "spawn",
            id: "tk",
            path: [
              [0, 3.6, 50],
              [-14, 2, 60],
              [-30, 0, 72],
            ],
            color: "warm",
            s: 1.4,
            speed: 0.06,
          },
          { k: "remove", id: "tk", at: 2.6 },
        ],
      },
      {
        t: "Enrollment binds device to owner",
        text: "The binding is (endpoint_id, owner_id) — the device joins its owner, not a vault. It reaches exactly the vaults that owner owns; there is no per-device role, only an orthogonal attenuation mask.",
        src: srcOf("docs/glossary.md", "#owners-gateway-726"),
        cam: { focus: "mobile", r: 40 },
        fx: [
          { k: "pulse", el: "mobile", on: true },
          {
            k: "callout",
            at: [-34, 5, 74],
            tone: "ok",
            title: "ENROLLED",
            body: "proved iroh EndpointId → owner. Revocation tombstones the binding; the owner's other devices are untouched.",
          },
        ],
      },
      {
        t: "Bootstrap: a shaped snapshot",
        text: "The seat asks for newest-first bootstrap and receives a shaped snapshot — existing app consents ∩ the device's trust tier, row- and column-minimized. The phone never receives the whole vault.",
        src: srcOf("ARCHITECTURE.md", "#device-replicas"),
        cam: { focus: "mobile", r: 30, phi: 1.15 },
        fx: [
          {
            k: "spawn",
            id: "snap",
            path: [
              [-6, 2, 52],
              [-20, 1, 62],
              [-32, 0, 72],
            ],
            color: "indigo",
            s: 1.6,
            speed: 0.05,
          },
          { k: "remove", id: "snap", at: 2.6 },
          {
            k: "callout",
            at: [-34, 5, 74],
            tone: "info",
            title: "SHAPES",
            body: "server-derived, consent-scoped. REPLICA_SCHEMA_EPOCH is an invalidation number — an incompatible change forces re-bootstrap.",
          },
        ],
      },
      {
        t: "Deltas from here on",
        text: "After the snapshot, one SSE connection multiplexes per-vault cursors; incremental deltas extend through commit boundaries. The seat is now fully offline-capable — see the islet-go-dark journey next.",
        src: srcOf("docs/mobile-offline.md", "#bootstrap-and-freshness"),
        cam: {
          focus: "custom",
          r: 120,
          theta: 0.4,
          phi: 0.95,
          target: [-20, -4, 60],
        },
        fx: [
          { k: "pulse", el: "mobile", on: false },
          {
            k: "callout",
            at: [-10, 6, 60],
            tone: "info",
            title: "ONE CURSOR PER VAULT",
            body: "a frame never combines cursors or data across vaults. Aggregate freshness is the minimum across sources.",
          },
        ],
      },
    ],
  },
  /* ── message ─────────────────────────────────────────────────────────────── */
  {
    id: "message",
    tab: "A MESSAGE",
    title: "A message's journey",
    beats: [
      {
        t: "Someone speaks at the gate",
        text: "A person speaks at the gate. Their words arrive as the first item of a conversation — a message_in item, ordinal 0.",
        src: srcOf("ARCHITECTURE.md", "#runtime-model-conversation-turn-item"),
        cam: { focus: "bridge" },
        fx: [
          { k: "reset" },
          { k: "pulse", el: "gate", on: true },
          {
            k: "spawn",
            id: "m1",
            path: [
              [0, 3.6, 96],
              [0, 3.6, 72],
              [0, 3.6, 54],
            ],
            color: "slate",
            s: 1.6,
            speed: 0.09,
          },
        ],
      },
      {
        t: "Through the consent desk",
        text: "The gate proves the caller; the call crosses the consent desk on the avenue. Nothing reaches the vault except through this desk.",
        src: srcOf(
          "ARCHITECTURE.md",
          "#tool-surface-declared-handlers--the-vault-register"
        ),
        cam: { focus: "clerk" },
        fx: [
          {
            k: "move",
            id: "m1",
            path: [
              [0, 3.6, 52],
              [1.5, 3.6, 34],
              [0, 3.6, 30],
            ],
            color: "slate",
            s: 1.6,
            speed: 0.1,
          },
        ],
      },
      {
        t: "Inked: conversation, turn, item 0",
        text: "The conversation is the durable thread; the turn is one execution under it; items are its ordered trace. The inbound message is always item zero — inked in the ledger archive, never erased.",
        src: srcOf(
          "docs/glossary.md",
          "#runtime-model-never-chat-for-the-ledger"
        ),
        cam: { focus: "ledger" },
        fx: [
          {
            k: "move",
            id: "m1",
            path: [
              [0, 3.6, 26],
              [10, 3.6, 8],
              [24, 3.6, 4],
            ],
            color: "slate",
            s: 1.6,
            speed: 0.1,
          },
          { k: "remove", id: "m1", at: 1.8 },
          { k: "pulse", el: "ledger", on: true },
          {
            k: "ledgerRow",
            text: "message_in · ordinal 0 · “remind me about the passport”",
            tone: "in",
          },
        ],
      },
      {
        t: "Steps and tools, inked in order",
        text: "A turn opens. Each step — one model inference, with token cost — is an item; each tool call rides out through the consent desk and is inked when it returns with a receipt.",
        src: srcOf("ARCHITECTURE.md", "#runtime-model-conversation-turn-item"),
        cam: { focus: "ledger" },
        fx: [
          { k: "ledgerRow", text: "turn opens" },
          { k: "ledgerRow", text: "step · model inference · 1,204 tok" },
          {
            k: "spawn",
            id: "t1",
            path: [
              [28, 3.6, 6],
              [10, 3.6, 22],
              [1.5, 3.6, 30],
            ],
            color: "violet",
            s: 1.2,
            speed: 0.12,
          },
          { k: "remove", id: "t1", at: 2.4 },
          {
            k: "spawn",
            id: "r1",
            path: [
              [1.5, 3.6, 30],
              [10, 3.6, 22],
              [28, 3.6, 6],
            ],
            color: "forest",
            s: 1.1,
            speed: 0.12,
            wait: 2.5,
          },
          { k: "remove", id: "r1", at: 4.9 },
          {
            k: "ledgerRow",
            text: "tool · executed · receipt #8812",
            tone: "ok",
          },
        ],
      },
      {
        t: "The reply leaves by the same gate",
        text: "The turn closes and the reply exits past the desk. The transcript stays durable in journal.db — it is the memory, the audit, and the Insights source.",
        src: srcOf("ARCHITECTURE.md", "#on-disk-layout"),
        cam: {
          focus: "custom",
          r: 90,
          theta: 0.5,
          phi: 0.98,
          target: [14, 4, 26],
        },
        fx: [
          { k: "ledgerRow", text: "step · final answer composed" },
          {
            k: "spawn",
            id: "m2",
            path: [
              [26, 3.6, 6],
              [8, 3.6, 24],
              [0, 3.6, 50],
              [0, 3.6, 80],
            ],
            color: "slate",
            s: 1.6,
            speed: 0.07,
          },
        ],
      },
      {
        t: "Now: an automation fires",
        text: "A scheduled tick arrives — and it enters as… message_in, ordinal 0, of a long-lived automation conversation. Same desks, same ink; the other party is a deterministic script.",
        src: srcOf(
          "docs/glossary.md",
          "#runtime-model-never-chat-for-the-ledger"
        ),
        cam: { focus: "automation" },
        fx: [
          { k: "lclear" },
          { k: "clearA" },
          { k: "pulse", el: "ledger", on: false },
          { k: "pulse", el: "automation", on: true },
          {
            k: "spawn",
            id: "g1",
            path: [
              [-35, 3.6, 14],
              [-24, 3.6, 8],
              [-8, 3.6, 4],
              [16, 3.6, 4],
              [28, 3.6, 4],
            ],
            color: "violet",
            s: 1.3,
            speed: 0.06,
          },
        ],
      },
      {
        t: "One world, running twice",
        text: "The tick is inked exactly where the person's words were: item 0, steps, tools — under one conversation whose kind is automation. Everything is agentic chat, which is why we never say chat for the ledger.",
        src: srcOf(
          "docs/glossary.md",
          "#runtime-model-never-chat-for-the-ledger"
        ),
        cam: { focus: "ledger" },
        fx: [
          { k: "remove", id: "g1" },
          { k: "pulse", el: "automation", on: false },
          { k: "pulse", el: "ledger", on: true },
          {
            k: "ledgerRow",
            text: "message_in · ordinal 0 · cron tick 06:00",
            tone: "in",
          },
          {
            k: "ledgerRow",
            text: "step · compile · plan resolved",
            tone: "warn",
          },
          {
            k: "callout",
            at: [34, 17, 2],
            tone: "warn",
            title: "SAME LEDGER",
            body: "kind lives on the conversation — chat, build, automation are three kinds of one transcript.",
          },
        ],
      },
    ],
  },

  /* ── harness row (ACP turn driver) ───────────────────────────────────────── */
  {
    id: "harness",
    tab: "HARNESS ROW",
    title: "The harness row — how turns reach a model",
    beats: [
      {
        t: "The engine rooms",
        text: "Your turn never calls a model API directly. It drives an installed CLI — codex, claude-code, opencode — over ACP, the Agent Client Protocol. Chat assistants work because the harness owns the model conversation; the shed owns the engine.",
        src: srcOf("docs/glossary.md", "#hosts-and-clients"),
        cam: { focus: "harness" },
        fx: [{ k: "reset" }, { k: "pulse", el: "harness", on: true }],
      },
      {
        t: "One door: TurnPlane.runTurn",
        text: "Chat threads, workspace builds, automation steering, headless compile, ctx.delegate — every caller reaches an installed CLI through one door. Posture (attended vs unattended) selects consent, failover boundary, and permissions — never a second implementation.",
        src: srcOf("ARCHITECTURE.md", "#runtime-model-conversation-turn-item"),
        cam: {
          focus: "custom",
          r: 70,
          theta: 0.95,
          phi: 1,
          target: [40, 4, 0],
        },
        fx: [
          { k: "pulse", el: "ledger", on: true },
          {
            k: "spawn",
            id: "t1",
            path: [
              [28, 3.6, 4],
              [40, 3.6, 2],
              [52, 3.6, -13],
            ],
            color: "ochre",
            s: 1.3,
            speed: 0.07,
          },
          { k: "remove", id: "t1", at: 2.6 },
          {
            k: "spawn",
            id: "t2",
            path: [
              [52, 3.6, -13],
              [40, 3.6, 2],
              [28, 3.6, 4],
            ],
            color: "warm",
            s: 1.3,
            speed: 0.07,
            wait: 2.7,
          },
          { k: "remove", id: "t2", at: 5.3 },
        ],
      },
      {
        t: "Sessions that survive a provider change",
        text: "conversation_harness_sessions holds each conversation's per-harness ACP resume handles and hydration watermarks. Changing providers never changes the durable conversation id — A to B and back to A resumes A.",
        src: srcOf("ARCHITECTURE.md", "#runtime-model-conversation-turn-item"),
        cam: { focus: "harness", r: 40, theta: 0.9 },
        fx: [
          {
            k: "spawn",
            id: "r1",
            path: [
              [52, 3.6, -13],
              [44, 3.6, -8],
              [38, 3.6, -4],
            ],
            color: "warm",
            s: 1.1,
            speed: 0.09,
          },
          { k: "remove", id: "r1", at: 1.8 },
          {
            k: "spawn",
            id: "r2",
            path: [
              [38, 3.6, -4],
              [46, 3.6, -4],
              [54, 3.6, -4],
            ],
            color: "slate",
            s: 1.1,
            speed: 0.09,
            wait: 1.9,
          },
          { k: "remove", id: "r2", at: 3.7 },
          {
            k: "callout",
            at: [53, 10, -8],
            tone: "info",
            title: "RESUME HANDLES",
            body: "8,000-token / two-turn hydration plans per (conversation, harness). Two delegates in one fire settle independently.",
          },
        ],
      },
      {
        t: "Adapters for the unwilling",
        text: "A CLI without a native ACP mode gets a first-party adapter shim — the only thing adapter is allowed to mean. Below that door, one pinned @agentclientprotocol/sdk connection owns one session actor for its lifetime.",
        src: srcOf(
          "docs/glossary.md",
          "#runtime-model-never-chat-for-the-ledger"
        ),
        cam: { focus: "harness", r: 34, phi: 1.12 },
        fx: [
          {
            k: "callout",
            at: [56, 8, -5],
            tone: "info",
            title: "ACP COUPLING",
            body: "the pinned protocol ring: launch data lives in HARNESSES, the connection owns the session. Harnesses never leak into the ledger's name for things.",
          },
        ],
      },
      {
        t: "Egress is consent-keyed",
        text: "Some work needs a provider model — a delegate step, an OCR fallback. That rides the one violet thread, and only with provider-egress consent. The egress class — on-device, gateway, provider — is computed from the engine, never user-set, and it is the axis consent is keyed on.",
        src: srcOf("docs/glossary.md", "#core-product-nouns"),
        cam: {
          focus: "custom",
          r: 80,
          theta: 1,
          phi: 0.9,
          target: [70, 20, -20],
        },
        fx: [
          { k: "cut", name: "egress", on: false },
          {
            k: "spawn",
            id: "e1",
            path: [
              [56, 6, -6],
              [80, 25, -30],
              [115, 60, -55],
            ],
            color: "violet",
            s: 1.3,
            speed: 0.045,
          },
          { k: "remove", id: "e1", at: 3.4 },
          { k: "wait", s: 0.6 },
          {
            k: "callout",
            at: [90, 40, -40],
            tone: "warn",
            title: "PROVIDER EGRESS",
            body: "consent-keyed, receipted. The ledger stamps only ACP-confirmed model identity.",
          },
        ],
      },
      {
        t: "Grounded by skills",
        text: "What the harness knows about this vault arrives as SKILL.md grounding units loaded by the harness runtime. The thread goes dark again the moment the consented step ends.",
        src: srcOf("docs/glossary.md", "#core-product-nouns"),
        cam: { focus: "harness" },
        fx: [
          { k: "cut", name: "egress", on: true },
          { k: "cclear" },
          {
            k: "callout",
            at: [53, 10, -8],
            tone: "info",
            title: "SKILL.md",
            body: "harness grounding units — packages/server/src/skills. The context the CLI wakes up with.",
          },
        ],
      },
    ],
  },
  /* ── photo ───────────────────────────────────────────────────────────────── */
  {
    id: "photo",
    tab: "A PHOTO",
    title: "A photo's journey",
    beats: [
      {
        t: "Arrival at the gate",
        text: "A photo rides in from the phone islet and passes the gate like any visitor's cargo. The gateway owns the user-facing request path; the byte plane below stays a dumb, bounded service.",
        src: srcOf("ARCHITECTURE.md", "#performance-and-byte-plane-boundary"),
        cam: { focus: "gate" },
        fx: [
          { k: "reset" },
          { k: "pulse", el: "gate", on: true },
          {
            k: "spawn",
            id: "ph1",
            path: [
              [-34, 0, 74],
              [-16, 1.5, 62],
              [0, 3.6, 52],
            ],
            color: "amber",
            s: 1.5,
            speed: 0.08,
          },
        ],
      },
      {
        t: "Content-addressed into the cellar",
        text: "Its bytes are content-addressed into the blob cellar — the file's own SHA-256 becomes its address, so identical bytes are stored exactly once. A blob has no facade; the identical crates are the point.",
        src: srcOf("ARCHITECTURE.md", "#on-disk-layout"),
        cam: { focus: "cellar" },
        fx: [
          {
            k: "move",
            id: "ph1",
            path: [
              [0, 3.6, 44],
              [12, 3.6, 6],
              [22, 3.6, -24],
            ],
            color: "amber",
            s: 1.5,
            speed: 0.08,
          },
          { k: "remove", id: "ph1", at: 2.6 },
          { k: "pulse", el: "cellar", on: true },
          {
            k: "callout",
            at: [26, 11, -30],
            tone: "info",
            title: "CAS · vault/<id>/blobs",
            body: "content-addressed, plaintext under the v0 L0 premise — the OS boundary guards this room.",
          },
        ],
      },
      {
        t: "One row, one replica whisper",
        text: "The asset row lands in vault.db — and a replica_change entry is written by a trigger inside the same transaction. Shaped, consent-scoped deltas ride out to every enrolled seat.",
        src: srcOf("ARCHITECTURE.md", "#device-replicas"),
        cam: { focus: "vault" },
        fx: [
          { k: "pulse", el: "cellar", on: false },
          { k: "pulse", el: "vault", on: true },
          {
            k: "spawn",
            id: "d1",
            path: [
              [6, 3.6, 4],
              [0, 3.6, 30],
              [0, 3.6, 52],
              [-16, 1.5, 62],
              [-32, 0, 72],
            ],
            color: "indigo",
            s: 1.2,
            speed: 0.055,
          },
          {
            k: "spawn",
            id: "d2",
            path: [
              [6, 3.6, 4],
              [0, 3.6, 30],
              [0, 3.6, 52],
              [0, 2, 80],
              [0, -2, 94],
            ],
            color: "slate",
            s: 1.2,
            speed: 0.055,
            wait: 1.4,
          },
        ],
      },
      {
        t: "Workers in the automation hall",
        text: "Recognition automations are ordinary headless workers in the same hall: OCR and embeddings run deterministically on pinned local models, in bounded batches of 16. No separate inference service exists.",
        src: srcOf("ARCHITECTURE.md", "#recognition-automations-731"),
        cam: { focus: "automation" },
        fx: [
          { k: "clearA" },
          { k: "pulse", el: "vault", on: false },
          { k: "pulse", el: "automation", on: true },
          {
            k: "callout",
            at: [-35, 16, 2],
            tone: "info",
            title: "ocr@1 · faces@1",
            body: "the handler owns its ML — model assets live in the automation runtime, stamped model@version.",
          },
        ],
      },
      {
        t: "Faces wait at the consent rope",
        text: "Faces is the exception: it reads no photograph without an open, consent-tagged enrich_request or a prior consent stamp — grouping proposes, only the owner names.",
        src: srcOf("SECURITY.md"),
        cam: { focus: "clerk" },
        fx: [
          { k: "pulse", el: "automation", on: false },
          { k: "pulse", el: "clerk", on: true },
          {
            k: "callout",
            at: [0, 10, 28],
            tone: "warn",
            title: "CONSENT GATE",
            body: "an enrich_request must carry an open capability tag before the faces worker may look.",
          },
        ],
      },
      {
        t: "Shared is residency (if you share)",
        text: "Under a grant, the subject's closure is re-projected into the audience vault, where it enters through the same post-ingest door as an authored row. Sharing places a resident copy; nobody ever queries your isle.",
        src: srcOf("ARCHITECTURE.md", "#vault-ownership-and-sharing-726"),
        cam: { focus: "commons" },
        fx: [
          { k: "pulse", el: "clerk", on: false },
          { k: "pulse", el: "commons", on: true },
          {
            k: "callout",
            at: [-40, 11, -22],
            tone: "info",
            title: "COMMONS",
            body: "domain rows and blobs become real residents of every joined member's vault.",
          },
        ],
      },
      {
        t: "Sealed for the warehouse",
        text: "For backup, chunks are sealed with the backup keyring before they leave the isle. The warehouse — the one red thread — stores ciphertext plus metadata shape, never plaintext.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: { focus: "warehouse" },
        fx: [
          { k: "pulse", el: "commons", on: false },
          {
            k: "spawn",
            id: "cr1",
            path: [
              [-20, 3.6, -10],
              [-58, 2, 10],
              [-84, 1.5, 3],
              [-106, 5, -4],
            ],
            color: "net",
            s: 1.6,
            speed: 0.045,
          },
          { k: "remove", id: "cr1", at: 4.4 },
          { k: "pulse", el: "warehouse", on: true },
        ],
      },
    ],
  },

  /* ── stolen ──────────────────────────────────────────────────────────────── */

  /* ── dark (mobile offline, first-class) ──────────────────────────────────── */
  {
    id: "dark",
    tab: "MOBILE OFFLINE",
    title: "The phone is offline — and nothing stops",
    beats: [
      {
        t: "Four grounds in one pocket",
        text: "The phone mounts up to four vault replicas into one read-only SQLite connection. Every result carries its source vault and whether you may write; identical bytes across vaults display once, with badges — never as duplicate rows.",
        src: srcOf("docs/mobile-offline.md", "#mounted-read-plane"),
        cam: { focus: "mobile" },
        fx: [
          { k: "reset" },
          { k: "scopes", n: 4 },
          { k: "sync", on: true },
          {
            k: "callout",
            at: [-38, -2, 70],
            tone: "info",
            title: "MOUNTED READ PLANE",
            body: "ATTACH DATABASE × 4 — the cap bounds descriptors, fan-out, and frame work. A focused vault is the write target, never a read filter.",
          },
        ],
      },
      {
        t: "Bootstrap: newest first, honestly partial",
        text: "First contact asks for newest items and commits page one as a crash-safe partial preview — the grid paints while the canonical walk continues. It is labeled partial and never treated as complete until the walk commits at page one's cursor.",
        src: srcOf("docs/mobile-offline.md", "#bootstrap-and-freshness"),
        cam: { focus: "mobile", r: 36, phi: 1.12 },
        fx: [
          {
            k: "spawn",
            id: "bs",
            path: [
              [0, 3.6, 50],
              [-16, 1.8, 62],
              [-31, 0, 71],
            ],
            color: "indigo",
            s: 1.6,
            speed: 0.06,
          },
          { k: "remove", id: "bs", at: 2.4 },
          {
            k: "callout",
            at: [-34, 4, 74],
            tone: "info",
            title: "COVERAGE: partial",
            body: "durability and coverage are explicit status fields. A memory fallback is labeled non-durable and cannot create a remembered replica identity.",
          },
        ],
      },
      {
        t: "The thread is cut — reads do not stop",
        text: "The road dies. Reads keep coming from the local stock — replica ⊕ outbox is the durable read law — and search runs the same bounded FTS query in every attached database, merged and ranked on the phone.",
        src: srcOf("docs/mobile-offline.md", "#mounted-read-plane"),
        cam: { focus: "mobile", r: 32, phi: 1.15 },
        fx: [
          { k: "cut", name: "mobile", on: true },
          { k: "sync", on: false },
          {
            k: "callout",
            at: [-34, 4, 74],
            tone: "warn",
            title: "OFFLINE",
            body: "freshness was stored per (gateway, vault) — the header says “Offline on this phone”, not a guessed timestamp.",
          },
        ],
      },
      {
        t: "A write becomes a durable intent",
        text: "The owner edits anyway: the action becomes a durable intent — {intentId, appId, action, payloadHash} — pinned to the outbox, surviving reload, restart, and reconnect. The shelf shows the pending overlay; it never fabricates a canonical row.",
        src: srcOf("docs/mobile-offline.md"),
        cam: { focus: "mobile", r: 30, phi: 1.18 },
        fx: [
          { k: "outbox", n: 3 },
          {
            k: "callout",
            at: [-30, -1, 71],
            tone: "warn",
            title: "QUEUED",
            body: "each blueprint declares its action-to-row projection in pending-projection.ts — one engine, no per-app pending arrays.",
          },
        ],
      },
      {
        t: "The status grammar",
        text: "Every intent settles queued → sending → executed / parked / denied / conflict / failed. Replaying an intentId returns the same durable outcome instead of re-running; denied, conflict, and failed stay editable, retryable, discardable.",
        src: srcOf(
          "docs/mobile-offline.md",
          "#replica-correctness-and-durability"
        ),
        cam: { focus: "mobile", r: 30, phi: 1.18 },
        fx: [
          {
            k: "callout",
            at: [-34, 4, 74],
            tone: "info",
            title: "IDEMPOTENT",
            body: "edit/retry mints a fresh immutable intent id + payload hash; the old terminal result is truthfully journaled.",
          },
        ],
      },
      {
        t: "When does sync actually run?",
        text: "Three chances, one truth: foreground pulls; the background task (BGTaskScheduler / WorkManager) runs the same queues opportunistically; and wake-only push can start a pull earlier — but its payload carries nothing, so loss or throttling cannot lose data.",
        src: srcOf(
          "docs/mobile-offline.md",
          "#background-work-and-push-privacy"
        ),
        cam: {
          focus: "custom",
          r: 90,
          theta: 0.35,
          phi: 1,
          target: [-20, -2, 60],
        },
        fx: [
          { k: "cut", name: "mobile", on: false },
          { k: "sync", on: true },
          { k: "outbox", n: 0 },
          {
            k: "callout",
            at: [0, 16, 52],
            tone: "info",
            title: "WAKE-ONLY PUSH",
            body: "no vault id, no headline, no cursor — a knock on the door, not a letter. Uploads honor metered/battery policy.",
          },
        ],
      },
      {
        t: "Revocation is a scoped tombstone",
        text: "Revoke one vault and only that source is purged — its cursor, rows, intents, and thumbnail pack. The other mounted grounds are untouched, and the aggregate freshness honestly drops to the slowest survivor.",
        src: srcOf("docs/mobile-offline.md", "#bootstrap-and-freshness"),
        cam: { focus: "mobile", r: 36 },
        fx: [
          { k: "revoke", n: 3 },
          {
            k: "callout",
            at: [-31.5, -2, 70],
            tone: "bad",
            title: "TOMBSTONED",
            body: "scoped purge: three scopes remain mounted. The aggregate cursor is the minimum across sources — a missing source keeps it partial.",
          },
        ],
      },
      {
        t: "Storage honesty",
        text: "Each source pins a thumbnail pack — recent 90 days plus favorites, 128 MiB, oldest-first eviction. “Free thumbnail cache” removes only reproducible pixels; on low disk the phone fails closed and never evicts canonical rows or queued writes to manufacture space.",
        src: srcOf("docs/mobile-offline.md", "#thumbnail-packs-and-budgets"),
        cam: { focus: "mobile", r: 30, phi: 1.15 },
        fx: [
          { k: "pack", on: true },
          {
            k: "callout",
            at: [-28, -2, 76],
            tone: "ok",
            title: "128 MiB / SOURCE",
            body: "replica rows and pending intents are not cache — the storage screen reports database, thumbnail, and pending bytes separately.",
          },
        ],
      },
      {
        t: "At rest, and the Locker exception",
        text: "Replicas live in a durable directory excluded from OS backup, protected by iOS Data Protection / Android credential encryption — deliberately no SQLCipher, a measured decision. And Locker is stricter still: secrets never enter a replica row or durable intent — reveals are online-only, always.",
        src: srcOf(
          "docs/mobile-offline.md",
          "#durable-path-and-at-rest-decision"
        ),
        cam: { focus: "mobile", r: 42, theta: 0.5 },
        fx: [
          { k: "pack", on: false },
          { k: "scopes", n: 3 },
          {
            k: "callout",
            at: [-34, 4, 74],
            tone: "warn",
            title: "SECRETS STAY ONLINE-ONLY",
            body: "passphrases, reveals, permits — never a replica row, never an intent. The biometric lock is presence, not encryption.",
          },
        ],
      },
    ],
  },

  /* ── clerk ───────────────────────────────────────────────────────────────── */
  {
    id: "clerk",
    tab: "CONSENT DESK",
    title: "An agent at the consent desk",
    beats: [
      {
        t: "The vault register",
        text: "An agent wants something from the vault. It sees exactly one tool family: vault_sql (one read-only statement), vault_invoke (one typed command), vault_content (one document's text).",
        src: srcOf(
          "ARCHITECTURE.md",
          "#tool-surface-declared-handlers--the-vault-register"
        ),
        cam: { focus: "clerk" },
        fx: [
          { k: "reset" },
          {
            k: "spawn",
            id: "ag1",
            path: [
              [-40, 3.6, 20],
              [-16, 3.6, 24],
              [-2, 3.6, 27],
            ],
            color: "violet",
            s: 1.3,
            speed: 0.09,
          },
        ],
      },
      {
        t: "Through the same pipeline as any handler",
        text: "The call stops at the consent desk: every data touch crosses ctx.vault into the consent pipeline and comes back executed, denied, or parked — always with a receipt id. No engine code holds a database of its own.",
        src: srcOf(
          "ARCHITECTURE.md",
          "#tool-surface-declared-handlers--the-vault-register"
        ),
        cam: { focus: "clerk", r: 30 },
        fx: [
          { k: "remove", id: "ag1", at: 0.1 },
          { k: "pulse", el: "clerk", on: true },
          {
            k: "callout",
            at: [0, 10, 28],
            tone: "info",
            title: "CONSENT PIPELINE",
            body: "Ajv-validated input → worker thread → ctx.vault → consent decision → receipt.",
          },
        ],
      },
      {
        t: "Executed / denied / parked",
        text: "Three lamps, one receipt each. Parked work waits in Notifications as an owner decision — a visible queue, never a silent guess.",
        src: srcOf("docs/glossary.md", "#owners-gateway-726"),
        cam: { focus: "clerk", r: 26, phi: 1.15 },
        fx: [
          {
            k: "callout",
            at: [0, 10, 28],
            tone: "ok",
            title: "RECEIPT #4411",
            body: "executed. Parked waits as an owner decision; a rejected proposal stays a state so it can return deliberately.",
          },
        ],
      },
      {
        t: "A UI button uses the same window",
        text: "A tap on an app button and a vault_invoke call land on the same handler — one calling convention across all eight bundled apps, enforced as a release invariant.",
        src: srcOf(
          "ARCHITECTURE.md",
          "#tool-surface-declared-handlers--the-vault-register"
        ),
        cam: {
          focus: "custom",
          r: 60,
          theta: 0.3,
          phi: 1,
          target: [10, 4, 36],
        },
        fx: [
          { k: "cclear" },
          { k: "pulse", el: "clerk", on: false },
          {
            k: "spawn",
            id: "u1",
            path: [
              [47, 3.6, 47],
              [20, 3.6, 38],
              [2, 3.6, 29],
            ],
            color: "forest",
            s: 1.2,
            speed: 0.08,
          },
          {
            k: "spawn",
            id: "a2",
            path: [
              [0, 3.6, 8],
              [0, 3.6, 18],
              [0, 3.6, 27],
            ],
            color: "violet",
            s: 1.2,
            speed: 0.08,
            wait: 1.4,
          },
          {
            k: "callout",
            at: [8, 8, 32],
            tone: "info",
            title: "SAME DESK",
            body: "UI button and vault_invoke — one calling convention, one receipt grammar.",
          },
        ],
      },
    ],
  },

  /* ── commons ─────────────────────────────────────────────────────────────── */
  {
    id: "commons",
    tab: "COMMONS",
    title: "The commons circle",
    beats: [
      {
        t: "A grant is a standing sentence",
        text: "Sharing writes one row: this audience may view or edit this subject, until revoked. A grant on a container covers its contents now and later — revocation stops it at revoked_at.",
        src: srcOf(
          "docs/glossary.md",
          "#sharing-the-grant-plane-commons-links-and-the-peer-plane-726-731-825"
        ),
        cam: { focus: "commons" },
        fx: [{ k: "reset" }, { k: "pulse", el: "commons", on: true }],
      },
      {
        t: "Residency, not references",
        text: "Fulfillment projects the subject's closure into each audience vault — rows and blobs become real residents there, entering through the same post-ingest door as authored data. Consent lasts with membership, not a clock.",
        src: srcOf("ARCHITECTURE.md", "#circle-backed-commons-731"),
        cam: { focus: "commons", r: 44 },
        fx: [
          {
            k: "callout",
            at: [-40, 11, -22],
            tone: "info",
            title: "RESIDENT COPY",
            body: "commons carries domain rows and source blobs — never derivatives. Each seat runs its own recognition.",
          },
        ],
      },
      {
        t: "The steward only orders",
        text: "Members submit vault-signed intents; the steward verifies signature and nonce, refuses replays, then appends the outcome to share_commons_op under one monotonic sequence. An ordering role, never ownership.",
        src: srcOf("ARCHITECTURE.md", "#circle-backed-commons-731"),
        cam: { focus: "commons", r: 34, phi: 1.12 },
        fx: [
          {
            k: "callout",
            at: [-40, 11, -22],
            tone: "ok",
            title: "share_commons_op",
            body: "signed · nonced · one monotonic sequence per grant. A malicious steward can delay, but the delay is observable.",
          },
        ],
      },
      {
        t: "Offline writers keep the real input",
        text: "An offline member keeps a durable share_commons_intent — the UI overlays its pending state honestly (“waiting for Alice's isle”) but fabricates no domain row before execution.",
        src: srcOf("docs/mobile-offline.md", "#commons-writes-and-cursors"),
        cam: {
          focus: "custom",
          r: 80,
          theta: -0.3,
          phi: 1,
          target: [-38, 2, 30],
        },
        fx: [
          {
            k: "spawn",
            id: "in1",
            path: [
              [-34, 0, 74],
              [-38, 1, 52],
              [-40, 3.6, -16],
            ],
            color: "forest",
            s: 1.2,
            speed: 0.05,
          },
          {
            k: "callout",
            at: [-52, 6, 8],
            tone: "warn",
            title: "PENDING · honest overlay",
            body: "the real input waits in share_commons_intent; the UI names the steward it is waiting for.",
          },
        ],
      },
    ],
  },
  {
    id: "stolen",
    tab: "STOLEN DISK",
    title: "The night the disk was stolen",
    beats: [
      {
        t: "Dusk deepens",
        text: "Night falls on the isle, and someone copies it. They can take every byte — but the key cabinet's wrapping key lives outside the disk, in OS custody.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: { focus: "isle", r: 210, phi: 0.95 },
        fx: [
          { k: "reset" },
          { k: "night", on: true },
          { k: "pulse", el: "vault", on: true },
        ],
      },
      {
        t: "gateway.db — the admin shack ledger",
        text: "Copied: enrollments, tickets, prefs, backup fencing — plaintext gateway state with no key material in it. Sealed columns there store ciphertext only.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: { focus: "gate" },
        fx: [
          { k: "pulse", el: "vault", on: false },
          { k: "pulse", el: "gate", on: true },
          {
            k: "callout",
            at: [0, 18, 50],
            tone: "bad",
            title: "PLAINTEXT",
            body: "gateway.db — enrollments, tickets, prefs. Filesystem permissions + the OS user boundary are all that guard it.",
          },
        ],
      },
      {
        t: "keys/ — envelopes without their wrapping key",
        text: "The cabinet yields ciphertext: each envelope is AES-256-GCM under a wrapping key rooted in OS custody — Keychain, systemd creds, safeStorage. Without that key the copies are inert.",
        src: srcOf("SECURITY.md"),
        cam: { focus: "keycab" },
        fx: [
          { k: "pulse", el: "gate", on: false },
          { k: "pulse", el: "keycab", on: true },
          {
            k: "callout",
            at: [15.5, 9, 46],
            tone: "ok",
            title: "CIPHERTEXT · aes-256-gcm-v1",
            body: "endpoint identity, backup keyring, per-vault DEKs — all sealed. The scheme line says which; legacy file-0600 entries would be raw.",
          },
        ],
      },
      {
        t: "vault.db — honest about the lit cells",
        text: "Most of the drum reads plainly: ordinary columns, journal bands, blobs — the lit cells. Only declared sealed columns stay dark, AES-256-GCM with the vault DEK the thief does not have.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: { focus: "vault" },
        fx: [
          { k: "pulse", el: "keycab", on: false },
          { k: "pulse", el: "vault", on: true },
          { k: "cells", n: 3 },
          {
            k: "callout",
            at: [-9, 9, 6],
            tone: "bad",
            title: "PLAINTEXT",
            body: "ordinary columns + journal.db + blobs — readable. Full-disk encryption is the real boundary.",
          },
          { k: "wait", s: 2 },
          {
            k: "callout",
            at: [9, 20, -8],
            tone: "ok",
            title: "STAYS DARK",
            body: "sealed columns — structural AAD + vault DEK from keys/, never derived from the backup keyring.",
          },
        ],
      },
      {
        t: "journal.db and the blob cellar — open books",
        text: "The conversation ledger, audit stream, and original photos are plaintext files protected by permissions alone. A copy without custody reads them all.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: {
          focus: "custom",
          r: 80,
          theta: 0.7,
          phi: 1.02,
          target: [16, 6, -14],
        },
        fx: [
          { k: "pulse", el: "vault", on: false },
          { k: "pulse", el: "ledger", on: true },
          {
            k: "callout",
            at: [34, 16, 2],
            tone: "bad",
            title: "PLAINTEXT",
            body: "journal.db — the ledger and audit bands, readable.",
          },
          { k: "wait", s: 1.8 },
          { k: "pulse", el: "cellar", on: true },
          {
            k: "callout",
            at: [26, 11, -30],
            tone: "bad",
            title: "PLAINTEXT",
            body: "blobs/ — original bytes, unsealed under the v0 premise.",
          },
        ],
      },
      {
        t: "The warehouse loses nothing",
        text: "Across the void the crates stay shut: snapshots and WAL chunks were sealed with the backup keyring before leaving the host. The provider — or a thief with provider credentials alone — sees ciphertext.",
        src: srcOf(
          "ARCHITECTURE.md",
          "#byte-custody-backup-and-device-compute"
        ),
        cam: { focus: "warehouse" },
        fx: [
          { k: "pulse", el: "ledger", on: false },
          { k: "pulse", el: "cellar", on: false },
          { k: "pulse", el: "warehouse", on: true },
          {
            k: "callout",
            at: [-112, 17, -6],
            tone: "ok",
            title: "CIPHERTEXT",
            body: "sealed with the backup keyring before leaving. Reaching the provider and decrypting it are separate capabilities — the API key is deliberately absent from the kit.",
          },
        ],
      },
      {
        t: "The recovery kit's password is load-bearing",
        text: "One chest matters most: the recovery kit — scrypt + AES-256-GCM over a document carrying the keyring and per-vault DEKs. Its password is custody, not ceremony; with it, a blank machine rebuilds everything.",
        src: srcOf("ARCHITECTURE.md", "#at-rest-formats-issue-555"),
        cam: { focus: "warehouse", theta: -0.85, r: 44, target: [-106, 7, -1] },
        fx: [
          { k: "pulse", el: "warehouse", on: false },
          { k: "pulse", el: "kit", on: true },
          {
            k: "callout",
            at: [-105, 9, 0.5],
            tone: "info",
            title: "centraid-recovery-kit-wrapped",
            body: "exported deliberately from the Backup plane; consumed by `centraid-gateway recover`. First run mints none.",
          },
        ],
      },
      {
        t: "Verdict",
        text: "A stolen disk yields gateway state, most vault rows, journals, and photos — guarded by your OS account and full-disk encryption, nothing else. What holds: sealed columns, backups, and whatever the kit password wraps. Application sealing bounds the remote provider, not an attacker standing on this disk.",
        src: srcOf("SECURITY.md"),
        cam: { focus: "isle", r: 200, phi: 0.9 },
        xr: false,
        fx: [{ k: "pulse", el: "kit", on: false }],
      },
    ],
  },
];

/* ── mapping table (appendix) ── */
window.MAPPING = [
  [
    "The isle itself",
    "One person's vault — self-contained, with a visible edge",
    "ARCHITECTURE.md · SECURITY.md",
  ],
  [
    "The vault drum; dark vs lit cells",
    "vault.db — sealed columns (AES-256-GCM, vault DEK + AAD) stay dark; ordinary columns are readable",
    "at-rest table (#555)",
  ],
  [
    "The glowing DEK seams + oculus",
    "The vault's sealing boundary — light leaks only where the DEK controls",
    "packages/vault",
  ],
  [
    "Key cabinet by the gate",
    "keys/ KeyStore envelopes; per-vault DEKs; aes-256-gcm-v1 under OS custody",
    "ARCHITECTURE.md at-rest",
  ],
  [
    "Gatehouse (only door)",
    "Gateway HTTP surface — @centraid/server, serve(), Bearer + proved devices",
    "ARCHITECTURE.md",
  ],
  [
    "Consent desk on the avenue; three lamps",
    "Consent pipeline — executed / parked / denied, each with a receipt id",
    "tool surface docs (#286)",
  ],
  [
    "Ledger archive; lit windows",
    "journal.db — conversation ledger band + append-only audit band",
    "ARCHITECTURE.md runtime model",
  ],
  [
    "A moving parcel",
    "A row in flight — message_in, a replica delta, an intent, a snapshot",
    "runtime model; mobile-offline",
  ],
  [
    "Automation hall; chimneys with pulses",
    "packages/server/src/automation — cron/webhook fire spine; a tick is message_in ordinal 0",
    "runtime model",
  ],
  [
    "Blob cellar; identical crates",
    "Content-addressed CAS under vault/<id>/blobs — a blob has no identity but its hash",
    "SECURITY.md v0 premise",
  ],
  [
    "Avenues through the vault plinth",
    "Every data touch crosses the vault — an app never reaches another app's data",
    "ARCHITECTURE.md tool surface",
  ],
  [
    "Bridge + device islets",
    "iroh QUIC tunnel (packages/tunnel); each seat is its own ground joined by a thread",
    "ARCHITECTURE.md; glossary",
  ],
  [
    "The relay beacon",
    "Browsers have no UDP — the web PWA's thread climbs a relay-only path",
    "ARCHITECTURE.md overview",
  ],
  [
    "Queued parcels on the phone islet",
    "Durable intent outbox; pending-write overlay replica ⊕ outbox",
    "docs/mobile-offline.md",
  ],
  [
    "A cut thread",
    "Offline: reads from the local replica, writes queue as durable intents",
    "docs/mobile-offline.md",
  ],
  [
    "The red thread to the far warehouse",
    "Backup: snapshots/WAL sealed with the backup keyring before leaving — the one egress",
    "at-rest table; @centraid/backup",
  ],
  [
    "Recovery chest",
    "centraid-recovery-kit-wrapped — password = custody; rebuilds a vault on a blank machine",
    "at-rest table; #603",
  ],
  [
    "Eight pavilions at the rim",
    "The eight system apps — shell code over the one vault, each in its identity hue",
    "packages/blueprints; apps.ts",
  ],
  [
    "Commons circle + steward spire",
    "share_circle_grant; steward orders share_commons_op (signed, nonced, monotonic)",
    "#731",
  ],
  [
    "Night mode",
    "The stolen-disk thought experiment — what a copy without custody yields",
    "at-rest table; SECURITY.md",
  ],
  [
    "Birds… none. Every dot of light is data.",
    "No unmapped decoration: if it glows, it means something",
    "the honesty contract",
  ],
];

/* ── glossary rail terms ── */
window.GLOSSARY = [
  [
    "vault",
    "on disk: vault/<id>/",
    "Sovereign personal ontology for one owner. Unit of custody: vault.db + journal.db (+ blobs, app data).",
  ],
  [
    "gateway",
    "@centraid/server",
    "Host-agnostic backend that mounts vaults, serves HTTP, runs automations and harness turns.",
  ],
  [
    "conversation ⊃ turn ⊃ item",
    "journal.db ledger band",
    "The runtime model. Inbound is message_in ordinal 0. Never 'chat' for the ledger.",
  ],
  [
    "journal",
    "journal.db",
    "Audit/receipt stream AND conversation ledger bands — one file per vault, two bands.",
  ],
  [
    "consent / grant",
    "consent gateway; share_grant",
    "Owner-signed permission for an app or device to touch vault scopes; a standing share sentence.",
  ],
  [
    "replica",
    "device-local SQLite",
    "Consent-scoped, read-mostly device copy; intents for offline writes; gateway is sole canonical writer.",
  ],
  [
    "pending-write overlay",
    "replica ⊕ outbox",
    "Durable local read law; survives restart; statuses queued→executed/parked/denied/conflict.",
  ],
  [
    "pair ticket",
    "the only ticket kind",
    "One-time ceremony enrolling a device key; burns on redeem.",
  ],
  [
    "owner / host",
    "vault_owners(vault_id, owner_id)",
    "Exactly one owner per vault, forever. Hosting is location, not authority.",
  ],
  [
    "steward",
    "share_commons_op",
    "Ordering role for one commons' signed intents — never ownership.",
  ],
  [
    "recognition automation",
    "blueprints/automations/*",
    "Headless handler owning its own ML; deterministic steps on pinned local models.",
  ],
  [
    "delegate",
    "ctx.delegate",
    "A bounded judgment step recorded as item kind='delegate'. An act, not a principal.",
  ],
  [
    "harness",
    "codex, claude-code, opencode…",
    "An installed model-capable CLI Centraid drives for a turn via ACP.",
  ],
  [
    "recovery kit",
    "centraid-recovery-kit-wrapped",
    "Passphrase-wrapped bundle of backup keyring + per-vault DEKs. Its password is load-bearing custody.",
  ],
  [
    "wake",
    "PushWakeRelay",
    "Content-free push telling a client to fetch locally — never carries vault content.",
  ],
];

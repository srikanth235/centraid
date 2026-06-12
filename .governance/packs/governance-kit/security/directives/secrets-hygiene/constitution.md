### secrets-hygiene

- **Directive**: No tracked file violates either of the following sub-checks:
    - `hardcoded-credentials` (CWE-798) — no tracked file contains a plaintext AWS / GCP / GitHub / Slack / Stripe token, private-key block, or generic `api_key = "..."` literal, per the directive's heuristic pattern set (line-level waiver: `# governance: allow-secrets-hygiene <reason>`).
    - `dotenv` — `.env` (and `.env.*` except `.env.example` / `.env.sample` / `.env.template`) is not tracked, and `.gitignore` exists and covers `.env`.
- **Rationale**: A leaked credential in git history is a credential compromised — rotation is the only recourse. `.env` is where those credentials most commonly live, so closing the door on tracking it complements the pattern scan that catches the ones that slip past into source. Treat the two as one directive: they share a failure mode and both belong on every commit.
- **Enforced by**: `.governance/packs/governance-kit/security/directives/secrets-hygiene/check.sh`
- **Exceptions**: For documented, intentional fixtures, append `# governance: allow-secrets-hygiene <reason>` to the offending line — the waiver is visible in `git blame` and searchable by design. To carve out a sub-check entirely for your repo, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive).

#!/usr/bin/env bash
# Directive: gateway-engine-mode-agnostic - a gateway rule may not branch on
# which deployment it is running in.
#
# THE SUBJECT MOVED AND THE PRINCIPLE DID NOT (#1029 §3). This directive was
# written for v0's `packages/server/src/engine/`, which v1 does not have - and
# a check whose glob matches nothing is a check that passes for the wrong
# reason. Its principle is more load-bearing now than it was then: v1's gateway
# is ONE PROTOCOL WITH TWO DEPLOYMENTS, a paid hosted offering on Cloudflare and
# a standalone server anyone can self-host, and the phone cannot tell which it
# is talking to. So the glob is repointed at the two crates that are that
# gateway, and the identifier list is respelled in Rust.
#
# `crates/gateway-core` is the rules and `crates/gateway-server` is the
# standalone adapter. What genuinely differs between the deployments goes behind
# a port - `ByteStore` for where bytes live, `StateStore` for where state lives,
# the adapter's own path for how a member is admitted, and `ChecksumMode` for
# which evidence a store can produce, which is a property of the STORE the
# adapter was pointed at (B2 and MinIO attest different headers) rather than of
# the adapter.
#
# Detection: deployment-discriminator identifiers, in the spellings Rust uses -
# type names and snake_case bindings both, because either shape is a branch. The
# list is explicit and narrow on purpose: adding a new one (e.g. `RuntimeMode`)
# is a deliberate edit here, exactly as adding `hostMode` was before.
# `ChecksumMode` is deliberately NOT on it - it is the one honest difference, it
# is an input rather than a branch, and forbidding it would forbid the thing the
# conformance suite runs both halves of.
#
# `crates/gateway-core/tests/wasm_clean.rs` carries the same scan for the rules
# crate from inside `cargo test`, and `crates/gateway-server/tests/no_rules_here.rs`
# carries it for the adapter. This carries it for both at the commit door. Two
# doors, one principle: a test fails a run, this refuses a commit, and neither
# is a substitute for the other.
#
# Waiver: `// governance: allow-gateway-engine-mode-agnostic <reason>` on the
# offending line, for the rare case where a gateway legitimately needs to know
# which deployment it is (none today; the architecture promise is that no such
# case should exist).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "gateway-engine-mode-agnostic"
require_git

# Deployment-discrimination identifiers, in Rust's spellings.
PATTERN='\b(GatewayMode|GatewayKind|DeploymentMode|HostingMode|gateway_mode|gateway_kind|deployment_mode|hosting_mode|is_hosted|is_standalone|is_cloudflare|is_worker|is_self_hosted)\b'

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "gateway-engine-mode-agnostic" && continue
    ident=$(printf '%s' "$match" | grep -oE "$PATTERN" | head -1)
    violation "$file:$line_no - a gateway branches on its deployment via '$ident'. One protocol, two deployments (#1029 §3): what differs goes behind ByteStore, StateStore, the adapter's admission path, or ChecksumMode"
done < <(git grep -nE "$PATTERN" -- 'crates/gateway-core/src/**/*.rs' 'crates/gateway-server/src/**/*.rs' 2>/dev/null || true)

directive_end

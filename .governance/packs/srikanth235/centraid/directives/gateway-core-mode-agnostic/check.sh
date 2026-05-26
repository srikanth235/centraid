#!/usr/bin/env bash
# Directive: gateway-core-mode-agnostic - packages/runtime-core/ must
# never branch on gateway mode. Mode-specific code belongs at the
# entrypoints (apps/desktop/src/main/ for the embedded gateway,
# packages/openclaw-plugin/src/ for the OpenClaw gateway). The "same
# code, two modes" architecture property breaks the moment runtime-core
# starts checking which host it's living in.
#
# Detection: gateway-mode-discriminator identifiers (gatewayMode,
# gatewayKind, isEmbeddedGateway, isOpenClawGateway, isLocalGateway,
# isRemoteGateway, deploymentMode) appearing in any tracked
# packages/runtime-core/ source file. The pattern is intentionally
# narrow - it avoids flagging the unrelated `kind: 'openclaw'` adapter
# discriminator (which is about agent runtime, not gateway mode) and
# generic names like `isLocal` (which could legitimately mean "is local
# timezone" or similar).
#
# Waiver: `// governance: allow-gateway-core-mode-agnostic <reason>` on
# the offending line for the rare case where runtime-core legitimately
# needs to know the host (none today; the architecture promise is no
# such case should exist).
set -u
source "$(dirname "$0")/../../../../../lib.sh"
directive_start "gateway-core-mode-agnostic"
require_git

# Gateway-mode-discrimination identifiers. The list is explicit and
# narrow on purpose - adding a new discriminator name (e.g.
# `hostMode`, `runtimeMode`) is a deliberate edit here.
PATTERN='\b(gatewayMode|gatewayKind|gateway_mode|gateway_kind|isEmbeddedGateway|isOpenClawGateway|isLocalGateway|isRemoteGateway|deploymentMode|hostingMode)\b'

while IFS=: read -r file line_no match; do
    [[ -z "$file" ]] && continue
    has_waiver "$file" "$line_no" "gateway-core-mode-agnostic" && continue
    ident=$(printf '%s' "$match" | grep -oE "$PATTERN" | head -1)
    violation "$file:$line_no - runtime-core branches on gateway mode via '$ident' (move to apps/desktop/src/main/ or packages/openclaw-plugin/src/)"
done < <(git grep -nE "$PATTERN" -- 'packages/runtime-core/src/**/*.ts' 'packages/runtime-core/src/**/*.tsx' 'packages/runtime-core/src/**/*.js' ':!**/*.test.ts' ':!**/*.test.tsx' ':!**/*.spec.ts' ':!**/dist/**' 2>/dev/null || true)

directive_end

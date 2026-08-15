# Receipt — issue #796: malformed device-work status degrades safely

## Checklist

- [x] A device-work status response without `vaults` degrades to an empty list.
- [x] A client seam contract test prevents the Household route crash from
      returning.

## What changed

`packages/client/src/gateway-client-devices.ts` now applies the same `?? []`
wire guard used by its sibling collection readers, so an empty or old gateway
response cannot hand `undefined` to the Household route.

`packages/client/src/gateway-client-devices.contract.test.ts` routes a
shape-valid HTTP response with an empty JSON object through the real client and
asserts that `getGatewayDeviceWorkStatus()` resolves to `[]`.

### Checklist crosswalk

- **A device-work status response without `vaults` degrades to an empty list.**
  The return boundary now uses `out.vaults ?? []`.
- **A client seam contract test prevents the Household route crash from
  returning.** The new device-work status seam test passes `{}` through the
  real JSON client and asserts `[]`.

- **A device-work status response without `vaults` degrades to an empty list**
  — the return boundary now uses `out.vaults ?? []`.
- **A client seam contract test prevents the Household route crash** — the new
  device-work status seam test passes `{}` through the real JSON client.

## Out of scope

No gateway response schema or Household presentation behavior changed. This is
the client compatibility guard requested by the issue.

## Decisions

None.

## Verification

```sh
bun run --cwd packages/client test -- src/gateway-client-devices.contract.test.ts
```

The paired focused client run passed 29/29 tests. With the `?? []` guard
temporarily removed, the new seam regression failed 1/4 because the client
returned `undefined`; restoring the guard returned the focused suite to green.

## Audit

PASS — fresh-context audit by `/root/receipt_audit_792_796`: the receipt mirrors
issue #796, names both changed files, and the `?? []` guard plus real-client
contract regression match the claimed empty-response degradation (29/29 paired
client tests passed).

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |

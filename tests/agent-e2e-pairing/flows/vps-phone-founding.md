# VPS phone founding

This flow is the issue #555 acceptance path that component tests cannot prove:
a real zero-vault `centraid-gateway` daemon on a fresh data directory is founded
by a never-seen device over the real iroh forwarding plane.

The executable journey:

1. Starts `serve` without `--init-vault` and confirms the gateway reports
   `uninitialized`.
2. Runs the host-only `init-ticket --json` command while the daemon is live.
3. Connects a fresh device identity with that grant and creates the first
   vault.
4. Confirms that device is the vault's sole owner.
5. Writes the wrapped recovery-kit document outside the gateway data
   directory, reads it back as a newly selected file, and verifies its exact
   fingerprint plus password and explicit loss consent.
6. Restarts the daemon and proves the durable EndpointId, ready status, and
   owner access survive.
7. Confirms an unknown second device is rejected once the founding grant is
   gone.

The mobile screen's unit test separately proves its native share-sheet and
document-picker calls. Together those tests cover both the platform gesture and
the real daemon/tunnel/storage ceremony without persisting a raw DEK.

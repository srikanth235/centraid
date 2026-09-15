// Export the service-unit fixtures from v0's OWN generators (#1020, D-1020-G1).
//
// Run with `bun run contracts/deploy/units/export-v0-units.ts`, then
// `bun run format`. See `./README.md` for why these fixtures come from v0 and
// what the Rust tests do with them.
//
// This script is the only writer of the two `*.expected` files it names. The
// third fixture in this directory (`centraid-gateway@.system.service.expected`)
// has no v0 ancestor and is NOT written here — it is the v1 generator's own
// output, recorded as a regression fixture.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildLaunchdPlist,
  buildSystemdUnit,
  DEFAULT_LAUNCHD_LABEL,
} from "../../../packages/server/src/cli/service-unit.ts";

const out = import.meta.dirname;
mkdirSync(out, { recursive: true });

// The v1 exec line, fed through v0's generator: `nodeBin` + `cliEntry` + `args`
// are joined, so one executable and its subcommand produce exactly the ExecStart
// v1 needs while still exercising v0's quoting and ordering.
writeFileSync(
  path.join(out, "centraid-gateway.user.service.expected"),
  buildSystemdUnit({
    nodeBin: "/usr/local/bin/centraid",
    cliEntry: "gateway",
    args: ["--data-dir", "/home/owner/.local/share/centraid"],
    stdoutLog: "/home/owner/.local/state/centraid/gateway.out.log",
    stderrLog: "/home/owner/.local/state/centraid/gateway.err.log",
    workingDirectory: "/home/owner/.local/share/centraid",
    encryptedCredential: {
      id: "centraid-keystore",
      path: "/home/owner/.config/centraid/credentials/centraid-gateway.keystore.cred",
    },
  })
);

writeFileSync(
  path.join(out, "dev.centraid.gateway.plist.expected"),
  buildLaunchdPlist(DEFAULT_LAUNCHD_LABEL, {
    nodeBin: "/usr/local/bin/centraid",
    cliEntry: "gateway",
    args: ["--data-dir", "/Users/owner/Library/Application Support/Centraid"],
    stdoutLog: "/Users/owner/Library/Logs/Centraid/gateway.out.log",
    stderrLog: "/Users/owner/Library/Logs/Centraid/gateway.err.log",
    workingDirectory: "/Users/owner/Library/Application Support/Centraid",
  })
);

console.log(
  "contracts/deploy/units: two fixtures written from v0's generators"
);

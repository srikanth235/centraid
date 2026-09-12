// Export the recovery kit's wrap parameters and one v0-made wrapped sample as
// a language-neutral fixture (#1020, wave 2 lane R, D-1020-R3).
//
// THE ONE PLACE v1 READS A v0 ARTEFACT, AND WHY. #1020 is explicit that there
// is no v0-artefact compatibility for seat files or pairing tickets: those are
// re-made in a ceremony the owner is present for. A recovery kit is not like
// that. It is a file in a member's drawer, written once, opened years later, on
// the day everything else is gone — the one artefact whose whole purpose is to
// outlive the software that wrote it. So v1's parser MUST open a v0-made kit,
// and this fixture is how that is proven rather than asserted.
//
// The sample is produced by v0's own `wrapRecoveryKit` under a FIXED password
// and a fixed document, so the Rust `parse_recovery_kit` is tested against
// bytes v1 did not make. The password is in the fixture because the material
// inside is fixture material: three all-zero-ish 32-byte keys that seal
// nothing. A real kit's password is never written down anywhere.
//
// Regenerate with:
//
//   bun contracts/tools/export-recovery-kit-fixture.ts > contracts/custody/recovery-kit.json
//   bun run format
//
// The second step is not optional: the repository formatter owns JSON too, so
// the committed fixture is this script's output AFTER oxfmt.

import {
  RECOVERY_KIT_SCRYPT,
  recoveryKitFingerprint,
  wrapRecoveryKit,
} from "../../packages/backup/src/recovery-kit.js";
import type { RecoveryKitDocument } from "../../packages/backup/src/recovery-kit.js";

/** A fixture password that satisfies v0's #1014 X13 floor (12+ characters). */
const PASSWORD = "correct horse battery staple";

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64");
}

const document: RecoveryKitDocument = {
  version: 1,
  kind: "centraid-recovery-kit",
  createdAt: "2026-07-18T00:00:00.000Z",
  keyring: {
    version: 1,
    active: 2,
    epochs: [
      { epoch: 1, key: key(0x11), createdAt: "2026-01-01T00:00:00.000Z" },
      { epoch: 2, key: key(0x22), createdAt: "2026-06-01T00:00:00.000Z" },
    ],
  },
  targets: [
    {
      provider: "local",
      targetId: "local:/srv/centraid/backup",
      vaultId: "00000000-0000-7000-8000-000000000456",
      label: "the household vault",
      sealKey: key(0x33),
      identitySeed: key(0x44),
      lockerKeys: [
        { keyId: "k-1", key: key(0x55) },
        { keyId: "k-2", key: key(0x66) },
      ],
    },
    {
      // A target with no key material at all: every optional field absent is a
      // legal kit, and the fingerprint must treat the absence as `null` rather
      // than skipping the field.
      provider: "local",
      targetId: "local:/srv/centraid/backup-2",
      vaultId: "00000000-0000-7000-8000-000000000789",
      label: "the workshop vault",
    },
  ],
};

const wrapped = wrapRecoveryKit(document, PASSWORD);

// Sanity, at export time rather than at read time: the header's fingerprint is
// the document's, and the wrap parameters are the ones the fixture publishes.
if (wrapped.fingerprint !== recoveryKitFingerprint(document)) {
  throw new Error("export-recovery-kit-fixture: fingerprint disagreement");
}
if (
  wrapped.N !== RECOVERY_KIT_SCRYPT.N ||
  wrapped.r !== RECOVERY_KIT_SCRYPT.r ||
  wrapped.p !== RECOVERY_KIT_SCRYPT.p
) {
  throw new Error(
    "export-recovery-kit-fixture: scrypt parameters disagreement"
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "centraid-recovery-kit-fixture/1",
      note:
        "v0-made wrapped recovery kit, for the v1 parser. Regenerate with " +
        "contracts/tools/export-recovery-kit-fixture.ts.",
      scrypt: RECOVERY_KIT_SCRYPT,
      wrapAad: "centraid-recovery-kit-wrap-v1",
      label: "recovery kit",
      passphraseFloor: { minChars: 12, minWords: 4 },
      password: PASSWORD,
      fingerprint: wrapped.fingerprint,
      document,
      wrapped,
    },
    null,
    2
  )}\n`
);

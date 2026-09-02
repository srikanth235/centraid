/*
 * Terminal QR for `centraid-gateway pair --qr` (headless / VPS phone
 * bootstrap): the same one-line `centraid-gw-pair` token desktop pastes into
 * "Add gateway"; mobile scans or pastes it and redeems over
 * `centraid/gw-pair/1`. Keeps qrcode a gateway-CLI-only dependency.
 */

import QRCode from "qrcode";

/**
 * Uses the `terminal` renderer (`utf8` hits Invalid array length for some
 * base64url payloads in qrcode@1.5).
 */
export async function renderTerminalQr(text: string): Promise<string> {
  // Prefer low ECC so real EndpointTickets (often multi-KB with relay
  // hints) still fit a version-40 code when scanned from a terminal.
  try {
    return await QRCode.toString(text, {
      type: "terminal",
      errorCorrectionLevel: "L",
      small: true,
      margin: 1,
    });
  } catch (error) {
    try {
      return await QRCode.toString(text, {
        type: "terminal",
        errorCorrectionLevel: "L",
        margin: 1,
      });
    } catch {
      throw error instanceof Error
        ? error
        : new Error(`QR encode failed: ${String(error)}`);
    }
  }
}

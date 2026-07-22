/*
 * Terminal QR for `centraid-gateway pair --qr` (headless / VPS phone bootstrap).
 *
 * Encodes the same one-line `centraid-gw-pair` token that desktop pastes into
 * "Add gateway". Mobile scans it (or pastes it) and redeems over
 * `centraid/gw-pair/1`. Keeps qrcode as a gateway CLI dependency only.
 */

import QRCode from 'qrcode';

/**
 * Render a block QR suitable for SSH TTYs.
 * Uses the `terminal` renderer (`utf8` hits Invalid array length for some
 * base64url payloads in qrcode@1.5).
 * @param text One-line pairing ticket (or any short payload)
 */
export async function renderTerminalQr(text: string): Promise<string> {
  // Prefer low ECC so real EndpointTickets (often multi-KB with relay
  // hints) still fit a version-40 code when scanned from a terminal.
  try {
    return await QRCode.toString(text, {
      type: 'terminal',
      errorCorrectionLevel: 'L',
      small: true,
      margin: 1,
    });
  } catch (first) {
    // Fall back without `small` if the compact renderer rejects the matrix.
    try {
      return await QRCode.toString(text, {
        type: 'terminal',
        errorCorrectionLevel: 'L',
        margin: 1,
      });
    } catch {
      throw first instanceof Error ? first : new Error(`QR encode failed: ${String(first)}`);
    }
  }
}

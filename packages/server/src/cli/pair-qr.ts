import QRCode from "qrcode";

export async function renderTerminalQr(text: string): Promise<string> {
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

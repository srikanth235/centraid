import type { SendStream } from "./iroh.js";
import type { TunnelResponseHeader } from "./protocol.js";
import { encodeHeaderFrame } from "./protocol.js";

/** Copy unavoidable: iroh rejects Buffer at runtime. */
export function bytesToArray(buf: Buffer, out: number[] = []): Array<number> {
  out.length = buf.length;
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]!;
  return out;
}

/** Header frame + JSON body + FIN. */
export async function respondFrame(
  send: SendStream,
  status: number,
  payload: Record<string, string>
): Promise<void> {
  try {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    await send.writeAll(
      encodeHeaderFrame({
        status,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      } satisfies TunnelResponseHeader)
    );
    await send.writeAll(bytesToArray(body));
    await send.finish();
  } catch {
    // Stream already gone.
  }
}

export function respondError(
  send: SendStream,
  status: number,
  error: string
): Promise<void> {
  return respondFrame(send, status, { error });
}

/** Peer-lane refusal: typed STATE (#726), never an error body. */
export function respondPeerState(
  send: SendStream,
  status: number,
  state: string
): Promise<void> {
  return respondFrame(send, status, { state });
}

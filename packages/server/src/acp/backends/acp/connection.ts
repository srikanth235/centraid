import type { ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION;
export const AUTH_REQUIRED_CODE = acp.RequestError.authRequired().code;
const STDERR_TAIL_BYTES = 64 * 1024;

export interface AcpTurnHandlers {
  requestPermission: (
    params: acp.RequestPermissionRequest
  ) => acp.MaybePromise<acp.RequestPermissionResponse>;
  sessionUpdate: (params: acp.SessionNotification) => acp.MaybePromise<void>;
}

export interface AcpConnectionOwner {
  request: acp.ClientContext["request"];
  notify: acp.ClientContext["notify"];
  bindTurn: (handlers: AcpTurnHandlers) => () => void;
  readonly exited: Promise<void>;
  hasExited: () => boolean;
  spawnError: () => Error | undefined;
  stderrTail: () => string;
}

export function createAcpConnection(
  child: ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>
): AcpConnectionOwner {
  let activeTurn: AcpTurnHandlers | undefined;
  let processExited = false;
  let exitError: Error | undefined;
  let stderrBuf = "";

  const app = acp
    .client({ name: "centraid" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      if (!activeTurn) throw acp.RequestError.requestCancelled();
      return activeTurn.requestPermission(params);
    })
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      activeTurn?.sessionUpdate(params)
    );
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );
  const sdk = app.connect(stream);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      exitError = error;
      processExited = true;
      sdk.close(error);
      resolve();
    });
    child.once("exit", () => {
      processExited = true;
      sdk.close(new Error("acp harness exited"));
      resolve();
    });
  });

  return {
    request: sdk.agent.request.bind(sdk.agent) as acp.ClientContext["request"],
    notify: sdk.agent.notify.bind(sdk.agent) as acp.ClientContext["notify"],
    bindTurn: (handlers) => {
      if (activeTurn) {
        throw new Error("ACP process already has an active turn owner");
      }
      activeTurn = handlers;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (activeTurn === handlers) activeTurn = undefined;
      };
    },
    exited,
    hasExited: () => processExited,
    spawnError: () => exitError,
    stderrTail: () => stderrBuf,
  };
}

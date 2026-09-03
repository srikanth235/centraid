import type { IncomingMessage } from "node:http";

export function companionRequestAllowed(
  req: Pick<IncomingMessage, "method" | "url">,
  grants: readonly string[],
  enrollmentId: string
): boolean {
  const pathname = new URL(req.url ?? "/", "http://gateway.local").pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const selfRevokePath = `/centraid/_gateway/devices/${encodeURIComponent(enrollmentId)}`;
  const appRpc =
    method === "POST" &&
    /^\/centraid\/[^_/][^/]*\/(?:actions|queries)\/[^/]+$/u.test(pathname);
  return (
    appRpc ||
    pathname === "/centraid/_vault/status" ||
    pathname === "/centraid/_vault/apps" ||
    pathname === "/centraid/_vault/blocking" ||
    (pathname === selfRevokePath &&
      (req.method ?? "GET").toUpperCase() === "DELETE") ||
    (pathname === "/centraid/_vault/blobs" &&
      (req.method ?? "GET").toUpperCase() === "POST" &&
      grants.includes("docs"))
  );
}

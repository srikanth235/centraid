export type Route =
  | { kind: "registry-list" }
  | { kind: "registry-deregister"; appId: string }
  | { kind: "app-settings-read"; appId: string }
  | { kind: "app-settings-write"; appId: string }
  | { kind: "app-logs"; appId: string; query: Record<string, string> }
  | { kind: "app-changes"; appId: string }
  | { kind: "app-action"; appId: string; action: string }
  | { kind: "app-query"; appId: string; query: string }
  | { kind: "app-describe"; appId: string; query: Record<string, string> }
  | {
      kind: "app-chat";
      appId: string;
      segments: string[];
    }
  | { kind: "app-harness-status"; refresh: boolean }
  | { kind: "not-found" };

const PREFIX = "/centraid";
const DRAFT_PREFIX = "/centraid/_draft/";

export function parseWithDraft(
  method: string,
  rawUrl: string
): { route: Route; draftSessionId?: string } {
  const url = new URL(rawUrl, "http://localhost");
  if (!url.pathname.startsWith(DRAFT_PREFIX)) {
    return { route: parseRoute(method, rawUrl) };
  }
  const rest = url.pathname.slice(DRAFT_PREFIX.length);
  const slash = rest.indexOf("/");
  const draftSessionId = decodeURIComponent(
    slash === -1 ? rest : rest.slice(0, slash)
  );
  const innerPath = slash === -1 ? "" : rest.slice(slash);
  const innerUrl = `${PREFIX}${innerPath}${url.search}`;
  if (!draftSessionId) return { route: { kind: "not-found" } };
  return { route: parseRoute(method, innerUrl), draftSessionId };
}

export function parseRoute(method: string, rawUrl: string): Route {
  const url = new URL(rawUrl, "http://localhost");
  let pathname = url.pathname;
  if (!pathname.startsWith(PREFIX)) return { kind: "not-found" };
  pathname = pathname.slice(PREFIX.length);
  if (pathname === "" || pathname === "/") return { kind: "not-found" };

  const segments = pathname.split("/").filter(Boolean);
  const m = method.toUpperCase();

  if (segments[0] === "_apps") {
    if (segments.length === 1) {
      if (m === "GET") return { kind: "registry-list" };
      return { kind: "not-found" };
    }
    const appId = decodeURIComponent(segments[1] ?? "");
    if (!appId) return { kind: "not-found" };

    if (segments.length === 2) {
      if (m === "DELETE") return { kind: "registry-deregister", appId };
      return { kind: "not-found" };
    }

    const sub = decodeURIComponent(segments[2] ?? "");

    if (sub === "settings" && segments.length === 3) {
      if (m === "GET") return { kind: "app-settings-read", appId };
      if (m === "PUT") return { kind: "app-settings-write", appId };
      return { kind: "not-found" };
    }
    if (sub === "logs" && segments.length === 3 && m === "GET") {
      const query = Object.fromEntries(url.searchParams.entries());
      return { kind: "app-logs", appId, query };
    }

    return { kind: "not-found" };
  }

  if (segments[0] === "_turn") {
    if (
      segments[1] === "harness-status" &&
      segments.length === 2 &&
      m === "GET"
    ) {
      return {
        kind: "app-harness-status",
        refresh: url.searchParams.get("refresh") === "1",
      };
    }
    return { kind: "not-found" };
  }

  const appId = decodeURIComponent(segments[0] ?? "");
  if (!appId || appId.startsWith("_")) return { kind: "not-found" };

  if (segments.length === 1) return { kind: "not-found" };

  const second = decodeURIComponent(segments[1] ?? "");

  if (second === "_changes") {
    if (m !== "GET" || segments.length !== 2) return { kind: "not-found" };
    return { kind: "app-changes", appId };
  }

  if (second === "actions" && m === "POST" && segments.length === 3) {
    const action = decodeURIComponent(segments[2] ?? "");
    if (!action) return { kind: "not-found" };
    return { kind: "app-action", appId, action };
  }
  if (second === "queries" && m === "POST" && segments.length === 3) {
    const query = decodeURIComponent(segments[2] ?? "");
    if (!query) return { kind: "not-found" };
    return { kind: "app-query", appId, query };
  }

  if (second === "_describe") {
    if (m !== "GET" || segments.length !== 2) return { kind: "not-found" };
    const query = Object.fromEntries(url.searchParams.entries());
    return { kind: "app-describe", appId, query };
  }

  if (second === "_turn") {
    return { kind: "app-chat", appId, segments: segments.slice(1) };
  }

  return { kind: "not-found" };
}

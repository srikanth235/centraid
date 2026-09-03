export function memberFacingError(message: string): string {
  return message
    .replace(/\bgateway\s+daemons\b/giu, "vault services")
    .replace(/\bgateway\s+daemon\b/giu, "vault service")
    .replace(/\bgateways\b/giu, "vault hosts")
    .replace(/\bgateway\b/giu, "vault host")
    .replace(/\bdaemons\b/giu, "vault services")
    .replace(/\bdaemon\b/giu, "vault service")
    .replace(/\breplicas\b/giu, "offline copies")
    .replace(/\breplica\b/giu, "offline copy")
    .replace(/\bcomponents\b/giu, "parts")
    .replace(/\bcomponent\b/giu, "part");
}

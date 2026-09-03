export function isWebHost(): boolean {
  return typeof window !== "undefined" && window.CentraidIroh !== undefined;
}

export function seat(): "custodian" | "viewer" {
  return isWebHost() ? "viewer" : "custodian";
}

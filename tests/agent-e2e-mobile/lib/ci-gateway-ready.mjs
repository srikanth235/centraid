// Readiness probe for the mobile E2E host. A list-only check can stay green
// when the device-pairing route or live Iroh endpoint is absent, which made the
// iOS lane fail only after the expensive native build. Mint one throwaway
// ticket and validate its shape without ever printing the capability.

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:18789").replace(
  /\/+$/u,
  ""
);

const apps = await fetch(`${baseUrl}/centraid/_apps`);
if (!apps.ok) process.exit(1);

const ticket = await fetch(`${baseUrl}/centraid/_gateway/devices/ticket`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    role: "write",
    ttlMinutes: 1,
    newMemberLabel: "Mobile E2E readiness probe",
  }),
});
const result = await ticket.json().catch(() => ({}));
if (!ticket.ok || result?.ok !== true || typeof result.ticket !== "string") {
  process.exit(1);
}

console.log("mobile CI gateway ready (apps + redacted pairing ticket)");

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
    ttlMinutes: 1,
  }),
});
const result = await ticket.json().catch(() => ({}));
if (!ticket.ok || result?.ok !== true || typeof result.ticket !== "string") {
  process.exit(1);
}

console.log("mobile CI gateway ready (apps + redacted pairing ticket)");

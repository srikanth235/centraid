# Running a Centraid gateway on a box you own

A gateway is any machine the member controls that runs `centraid-gateway` — the laptop at home, a VPS, a NAS ([#1080](https://github.com/srikanth235/centraid/issues/1080)). It holds a sealed copy of the phone's vaults and can read none of it. One binary, one data directory, one port; the protocol, the commands and the data directory are [docs/gateway.md](../../docs/gateway.md).

## The shortest path

```sh
centraid-gateway serve --data-dir ~/centraid-gateway
```

The first `serve` mints the gateway's identity, listens on `0.0.0.0:8443`, advertises itself on the LAN, and prints a pairing QR. Scan it from the phone — **Pair with your laptop** on the More sheet, or **Add a gateway** on the Backup screen — and compare the safety number the phone shows with the `safety` line `serve` prints when the pairing lands. A QR admits one phone's vault, once, within a day; `centraid-gateway pair --data-dir ~/centraid-gateway` prints another, and `centraid-gateway health --data-dir ~/centraid-gateway` answers whether it is up.

**Until a phone pairs, the gateway holds nothing** — no vault, no account and no key — which is not a limitation to work around. It is the point.

To keep it running across reboots:

```sh
centraid-gateway install --data-dir ~/centraid-gateway --dry-run   # prints the unit and its path
centraid-gateway install --data-dir ~/centraid-gateway             # writes it, and prints how to start it
```

`install` writes a systemd user unit or a launchd agent and never enables it ([deploy/README.md](../README.md#the-service-units)).

## Getting it reachable

**LAN first** ([R-1080-9](../../docs/decisions.md#backups-from-first-principles-1080)). A phone on the same network finds the gateway by its addresses and by Bonjour, and that is the ordinary case: the backup happens at home, overnight, on Wi-Fi. Away from home, the phone reaches only an address it can dial directly:

| Shape | How |
| --- | --- |
| **A VPS** | Its public address. Open the port to TCP; pair from the QR `pair` prints there. |
| **A VPN both ends are on** (Tailscale, WireGuard) | The gateway's address on the VPN, which `pair` lists like any other interface address. |
| **A router port forward** | Forward the port to the gateway, TCP, untouched. |

**Nothing terminates TLS in front of it.** The phone pins the certificate this gateway minted, so a reverse proxy, a tunnel or a Funnel that presents its own certificate is refused — and none of them is needed, because there is no domain, no certificate authority and no ACME here. There is no relay and no hole punching either: a phone that cannot dial any of the gateway's addresses waits, and says how long it has been since it last reached it.

## A container

```sh
docker build -f deploy/gateway/Dockerfile -t centraid-gateway .
docker run -d --name centraid-gateway --network host \
  -v centraid-gateway:/var/lib/centraid centraid-gateway
docker logs centraid-gateway        # the first pairing QR
docker exec centraid-gateway centraid-gateway pair --data-dir /var/lib/centraid
```

Host networking, because the phone dials the addresses `pair` lists and Bonjour advertises from the same view, and a container's own network is not one a phone can reach. The volume, because the data directory is the whole gateway: a container removed without one takes the gateway's identity with it, and every paired phone refuses the one that replaces it.

## Backing up the box that holds the backups

Stop the gateway, copy its data directory whole, start it again. **That is everything.** There is no key to export and no credential to keep in step: what the directory holds is the gateway's own TLS identity, hashes of tokens and pairing secrets, the index, and ciphertext nobody there can open. Copied to another machine and started there, it is the same gateway, and every paired phone still trusts it.

A second gateway somewhere else, paired from the phone, is the better answer to a box that dies with the house: the phone backs up to each gateway it can reach ([R-1080-8](../../docs/decisions.md#backups-from-first-principles-1080)).

## What the gateway does on its own

Two sweeps, inside `serve`: **purge** hourly — the bytes of objects the phone deleted more than seven days ago — and **scrub** every 90 days, which re-hashes every stored object against its recorded digest and marks a damaged one missing so the phone sends it again. `centraid-gateway scrub` runs one now. Both log counts only, never names. There is no quota: the disk is yours.

## Upgrading

Stop it, replace the binary or the image, start it over the same data directory.

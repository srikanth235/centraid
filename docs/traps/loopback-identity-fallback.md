# Trap — a loopback fallback is an identity, and it is the wrong one

**Area:** `packages/server/src/serve/build-gateway.ts` (`deviceKeyFor`), `packages/tunnel/src/{desktop-tunnel,native-relay,forward-identity}.ts`.

## The shape

`DeviceAccess.deviceKeyFor` answers "who is this request?". Returning `undefined` is a refusal the composed handler honours with a 403. The trap is the tempting fallback: _this socket is loopback, so it must be the host._

It is not. Every forwarder in the product delivers a REMOTE party to `127.0.0.1` — the phone tunnel, the Rust byte relay, a linked gateway's peer lane. The embedded gateway carried that fallback from #263 until #1015, guarded only by "no peer header", with a comment saying that tightening it would sever phone-link. It did sever phone-link, because the forwarder named nobody; and the price of not tightening it was that every paired phone reached every vault door — the Locker key door, which hands back `K` — as the owner of the box. Revoking that phone changed nothing at those doors, because nothing had ever named it there.

## The rule

1. **A forwarder must name the party it authenticated.** Deleting the client's copy of the identity headers is half the job; stamping the proved EndpointId is the other half. `forwardIdentityHeaders` is the one place that decides what a stamp looks like, so the JS relay and the Rust byte pump's control plane cannot drift.
2. **Host identity is `isDirectHostRequest`, not `isLoopbackRequest`.** Loopback AND no forwarder marking. If "who is this" and "is this the host" use different predicates, they will eventually disagree, and the disagreement will be in the permissive direction.
3. **`undefined` is a refusal, never a fallback.** A forwarded hop with no stamp is refused. It is the only safe answer: the alternative is promotion.
4. **Both forwarder lanes, every time.** `desktop-tunnel.ts` is the portable relay; `native-relay.ts`'s `/authorize` control answer is what the PRODUCTION Rust pump stamps. A fix to one and not the other passes the JS suites and ships nothing — the native suites are gated behind `CENTRAID_RUN_NATIVE_TUNNEL=1` and do not run by default.
5. **Admission stays explicit.** Do not let a verified stamp auto-enrol its EndpointId: admission would become a side effect of traffic, and "an enrollment is the ONLY admission" (#603) would stop being true. The desktop vouches for a phone through a host-custody route at the moment the member scans the code, and tombstones it at the moment they revoke.

## Related

- [SECURITY.md](../../SECURITY.md) — local-socket / loopback boundary
- [docs/client-keying.md](../client-keying.md) rule 9
- [docs/enrollment.md](../enrollment.md) §7

# Browser relay policy

The web and extension transports default to iroh's production n0 relay map. Relay traffic remains end-to-end encrypted; the relay can observe transport metadata but cannot read the Centraid tunnel.

`BrowserEndpoint.spawn` also accepts an explicit list of HTTPS relay URLs. This is the supported seam for an owner-operated or organization-operated relay deployment; callers must receive the list from trusted pairing configuration and fail pairing when a URL is invalid. An empty or absent list retains the audited default.

The infrastructure owner is responsible for relay availability, certificate lifecycle, capacity, regional placement, abuse handling, and publishing incident status. The Centraid release owner is responsible for verifying that the default and override paths remain interoperable in the browser binding.

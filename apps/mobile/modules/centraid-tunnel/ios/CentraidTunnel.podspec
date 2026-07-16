Pod::Spec.new do |s|
  s.name           = 'CentraidTunnel'
  s.version        = '0.1.0'
  s.summary        = 'iroh p2p tunnel and localhost HTTP proxy for the centraid mobile app'
  s.description    = 'Pairs the phone with a desktop over iroh QUIC and proxies WebView HTTP requests through the tunnel (issue #263).'
  s.author         = 'centraid'
  s.homepage       = 'https://centraid.dev'
  s.license        = { :type => 'MIT' }
  # iroh-ffi 1.0's Apple deps call nw_path_is_ultra_constrained (iOS 17+); the
  # official xcframework is built with a 17.5 floor (Package.swift). The app
  # target must be >= 17.5 too (set ios.deploymentTarget via
  # expo-build-properties).
  s.platforms      = { :ios => '17.5' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Iroh Swift binding, sourced from the OFFICIAL n0-computer/iroh-ffi 1.0.0
  # release artifact — no bytes committed, no bespoke fetch script. This is
  # the same prebuilt xcframework (identical SHA-256) that the upstream
  # SwiftPM package (product `IrohLib`) resolves for git-URL / Swift Package
  # Index consumers; we pull it via CocoaPods instead because Expo integrates
  # local modules as CocoaPods `:path` pods. `IrohLib.swift` (the uniffi
  # wrapper) is compiled into THIS pod's module, so TunnelWire.swift uses its
  # types without an `import`. `Iroh.xcframework` carries the compiled Rust
  # FFI (module `Iroh`) for ios-arm64 + ios-arm64_x86_64-simulator + macos.
  #
  # NOTE: CocoaPods runs `prepare_command` when a pod is *downloaded*; for a
  # `:path` development pod it may be skipped, in which case run the two
  # commands below once (or re-run `pod install`) before building — see
  # ../README.md ("iOS binding"). The pinned checksum matches upstream
  # Package.swift's `releaseChecksum`.
  iroh_tag = 'v1.0.0'
  iroh_sha = '514b147f7965fe17acaece9a1157cf9421463b6c9282224983e871ea868b86ef'
  iroh_base = "https://github.com/n0-computer/iroh-ffi"
  s.prepare_command = <<-CMD
    set -euo pipefail
    if [ ! -d Iroh.xcframework ]; then
      tmp="$(mktemp -d)"
      curl -sSL -o "$tmp/iroh.zip" "#{iroh_base}/releases/download/#{iroh_tag}/IrohLib.xcframework.zip"
      got="$(shasum -a 256 "$tmp/iroh.zip" | awk '{print $1}')"
      [ "$got" = "#{iroh_sha}" ] || { echo "iroh xcframework checksum mismatch: $got" >&2; exit 1; }
      unzip -q "$tmp/iroh.zip" -d "$tmp/x"
      cp -R "$(find "$tmp/x" -maxdepth 1 -name '*.xcframework' | head -1)" Iroh.xcframework
      rm -rf "$tmp"
    fi
    if [ ! -f IrohLib.swift ]; then
      curl -sSL -o IrohLib.swift "https://raw.githubusercontent.com/n0-computer/iroh-ffi/#{iroh_tag}/IrohLib/Sources/IrohLib/IrohLib.swift"
    fi
  CMD

  s.vendored_frameworks = 'Iroh.xcframework'
  # iroh's netdev/netwatch use these on Apple platforms.
  s.frameworks = 'SystemConfiguration', 'Network'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Non-recursive glob: keep the vendored xcframework's own headers out of the
  # pod's compiled sources. All module + generated sources are flat in ios/;
  # the Tests/ subdirectory is not swept into the module.
  s.source_files = '*.{h,m,swift}'
end

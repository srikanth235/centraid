Pod::Spec.new do |s|
  s.name           = 'CentraidTunnel'
  s.version        = '0.1.0'
  s.summary        = 'iroh p2p tunnel and localhost HTTP proxy for the centraid mobile app'
  s.description    = 'Pairs the phone with a desktop over iroh QUIC and proxies WebView HTTP requests through the tunnel (issue #263).'
  s.author         = 'centraid'
  s.homepage       = 'https://centraid.dev'
  s.license        = { :type => 'MIT' }
  # iroh-ffi 1.0's Apple deps call nw_path_is_ultra_constrained (iOS 17+); the
  # vendored xcframework is built with a 17.5 floor. The app target must be
  # >= 17.5 too (set ios.deploymentTarget via expo-build-properties).
  s.platforms      = { :ios => '17.5' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Iroh Swift binding (uniffi-generated from n0-computer/iroh-ffi 1.0.0),
  # vendored locally rather than via SPM/CocoaPods (upstream's IrohLib.podspec
  # is stale at 0.35.0). IrohLib.swift is the generated wrapper — compiled into
  # this pod's module, so TunnelWire.swift uses its types without an import.
  # Iroh.xcframework carries the compiled Rust FFI (module `Iroh`) for
  # ios-arm64, ios-arm64_x86_64-simulator, and macos-arm64.
  # Regenerate: download IrohLib.xcframework.zip from the v1.0.0 release +
  #   cargo run --bin uniffi-bindgen generate --language swift --library <dylib>
  s.vendored_frameworks = 'Iroh.xcframework'
  # iroh's netdev/netwatch use these on Apple platforms.
  s.frameworks = 'SystemConfiguration', 'Network'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Non-recursive glob: keep the vendored xcframework's own headers out of the
  # pod's compiled sources. All module + generated sources are flat in ios/.
  s.source_files = '*.{h,m,swift}'
end

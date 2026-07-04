Pod::Spec.new do |s|
  s.name           = 'CentraidTunnel'
  s.version        = '0.1.0'
  s.summary        = 'iroh p2p tunnel and localhost HTTP proxy for the centraid mobile app'
  s.description    = 'Pairs the phone with a desktop over iroh QUIC and proxies WebView HTTP requests through the tunnel (issue #263).'
  s.author         = 'centraid'
  s.homepage       = 'https://centraid.dev'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Iroh Swift binding (uniffi-generated from n0-computer/iroh-ffi 1.0).
  # The canonical distribution is the `IrohLib` Swift package
  # (https://github.com/n0-computer/iroh-ffi) — add it to the generated Xcode
  # project via SPM after `bunx expo prebuild`, or vendor the generated Swift
  # sources + XCFramework behind a local podspec and uncomment:
  # s.dependency 'IrohLib', '~> 1.0'
  # All binding touchpoints live in TunnelWire.swift (adapter section).

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
end

Pod::Spec.new do |s|
  s.name           = 'CentraidNetworkStatus'
  s.version        = '0.1.0'
  s.summary        = 'Conservative network-policy facts for Centraid'
  s.description    = 'Reports only network facts the platform exposes without sensitive permissions.'
  s.author         = 'centraid'
  s.homepage       = 'https://centraid.dev'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '17.5' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,swift}'
end

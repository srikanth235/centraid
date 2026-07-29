Pod::Spec.new do |s|
  s.name           = 'CentraidStorage'
  s.version        = '0.1.0'
  s.summary        = 'Durable protected storage directory for Centraid replicas'
  s.description    = 'Creates a backup-excluded Application Support directory with iOS file protection.'
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

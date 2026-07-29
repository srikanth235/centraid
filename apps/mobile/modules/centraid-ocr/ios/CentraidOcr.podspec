Pod::Spec.new do |s|
  s.name           = 'CentraidOcr'
  s.version        = '0.1.0'
  s.summary        = 'Private on-device OCR for Centraid capture'
  s.description    = 'Recognizes bounded local images with Apple Vision without network access.'
  s.author         = 'centraid'
  s.homepage       = 'https://centraid.dev'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '17.5' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'UIKit'
  s.source_files = '*.{h,m,swift}'
end

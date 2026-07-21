require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name = "ConvexEmbeddedNative"
  s.version = package["version"]
  s.summary = package["description"]
  s.description = package["description"]
  s.license = package["license"] || "MIT"
  s.author = package["author"] || "Convex"
  s.homepage = package["homepage"] || "https://github.com/get-convex/embedded"
  s.source = { :git => "https://github.com/get-convex/embedded.git", :tag => s.version.to_s }
  s.platforms = { :ios => "15.1" }
  s.swift_version = "5.9"
  s.static_framework = true

  s.dependency "ExpoModulesCore"
  s.frameworks = "CoreFoundation"
  s.libraries = "iconv"
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.vendored_frameworks = "native/apple/ConvexEmbedded.xcframework"
  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_COMPILATION_MODE" => "wholemodule"
  }
end

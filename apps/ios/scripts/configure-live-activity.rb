#!/usr/bin/env ruby
# Optional personal-build experiment; run after configure-share-extension.rb
# with --spec-only so XcodeGen writes both app extension targets together.
require 'yaml'
require 'pathname'
ios = File.expand_path('..', __dir__)
spec_path = File.expand_path(ARGV.find { |item| !item.start_with?('--') } || 'src-tauri/gen/apple/project.yml', ios)
raise 'Missing generated XcodeGen project.' unless File.file?(spec_path)
spec = YAML.safe_load(File.read(spec_path), permitted_classes: [], permitted_symbols: [], aliases: true)
raise 'Unexpected XcodeGen project specification.' unless spec.is_a?(Hash) && spec['targets'].is_a?(Hash)
apps = spec['targets'].select { |_name, target| target['type'] == 'application' && target['platform'] == 'iOS' }
raise 'Expected one app and the existing Share Extension.' unless apps.length == 1 && spec['targets'].key?('CapriShare')
name, main = apps.first
main.fetch('info').fetch('properties')['NSSupportsLiveActivities'] = true
directory = File.dirname(spec_path)
relative = ->(path) { Pathname.new(File.join(ios, path)).relative_path_from(Pathname.new(directory)).to_s }
dependencies = main['dependencies'] ||= []
dependencies.reject! { |dependency| dependency['target'] == 'CapriLive' }
dependencies << { 'target' => 'CapriLive', 'embed' => true, 'codeSign' => false }
info = main.fetch('info').fetch('properties')
spec['targets']['CapriLive'] = {
  'type' => 'app-extension', 'platform' => 'iOS', 'deploymentTarget' => '16.2',
  'sources' => [
    { 'path' => relative.call('live-activity/CapriActivityWidget.swift') },
    { 'path' => relative.call('plugin-device-bridge/ios/Sources/CapriActivityAttributes.swift') }
  ],
  'settings' => { 'base' => {
    'PRODUCT_NAME' => 'CapriLive', 'PRODUCT_MODULE_NAME' => 'CapriLive',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'dev.gentledot.capri.live', 'SWIFT_VERSION' => '5.0',
    'APPLICATION_EXTENSION_API_ONLY' => true, 'SKIP_INSTALL' => true,
    'CODE_SIGNING_ALLOWED' => false, 'CODE_SIGNING_REQUIRED' => false,
    'TARGETED_DEVICE_FAMILY' => '1,2', 'GENERATE_INFOPLIST_FILE' => false
  } },
  'info' => { 'path' => 'CapriLive/Info.plist', 'properties' => {
    'CFBundleDisplayName' => 'Capri',
    'CFBundleShortVersionString' => info.fetch('CFBundleShortVersionString', '0.1.0'),
    'CFBundleVersion' => info.fetch('CFBundleVersion', '1'),
    'NSExtension' => { 'NSExtensionPointIdentifier' => 'com.apple.widgetkit-extension' }
  } },
  'entitlements' => { 'path' => 'CapriLive/CapriLive.entitlements', 'properties' => {} },
  'dependencies' => [{ 'sdk' => 'ActivityKit.framework' }, { 'sdk' => 'WidgetKit.framework' }, { 'sdk' => 'SwiftUI.framework' }, { 'sdk' => 'ImageIO.framework' }]
}
File.write(spec_path, YAML.dump(spec))
unless ARGV.include?('--spec-only')
  Dir.chdir(directory) { raise 'XcodeGen failed while adding Capri Live Activity.' unless system('xcodegen', 'generate', '--spec', spec_path) }
end
puts 'Configured optional Capri Live Activity target; signing and device acceptance remain separate.'

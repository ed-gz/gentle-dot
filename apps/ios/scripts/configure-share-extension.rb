#!/usr/bin/env ruby
# Run after `cargo tauri ios init --ci`, before the unsigned signing overrides.
# XcodeGen's generated spec is edited idempotently; no PBX UUID regex surgery.
require 'yaml'
require 'pathname'
require 'fileutils'

ios = File.expand_path('..', __dir__)
spec_path = File.expand_path(ARGV.find { |item| !item.start_with?('--') } || 'src-tauri/gen/apple/project.yml', ios)
raise 'Missing Tauri XcodeGen project.yml; run tauri ios init first.' unless File.file?(spec_path)
spec = YAML.safe_load(File.read(spec_path), permitted_classes: [], permitted_symbols: [], aliases: true)
raise 'Unexpected XcodeGen project specification.' unless spec.is_a?(Hash) && spec['targets'].is_a?(Hash)
main_targets = spec['targets'].select { |_name, target| target['type'] == 'application' && target['platform'] == 'iOS' }
raise 'Expected exactly one iOS application target.' unless main_targets.length == 1
name, main = main_targets.first
group = ENV.fetch('CAPRI_APP_GROUP', 'group.dev.gentledot.capri')
raise 'Invalid App Group identifier.' unless group.match?(/\Agroup\.[A-Za-z0-9.-]{3,200}\z/)
directory = File.dirname(spec_path)
relative = ->(path) { Pathname.new(File.join(ios, path)).relative_path_from(Pathname.new(directory)).to_s }
main['info'] ||= { 'path' => "#{name}/Info.plist" }
main['info']['properties'] ||= {}
main_info = main['info']['properties']
main_info['CapriAppGroup'] = group
main_info['NSMicrophoneUsageDescription'] ||= 'Capri usa el micrófono cuando dictas una instrucción. La transcripción se realiza en este iPhone.'
main_info['NSLocalNetworkUsageDescription'] ||= 'Capri se conecta a la laptop que vinculas para consultar tus sesiones y transferir los trabajos que autorizas.'
# WKWebView's existing file picker can open UIImagePickerController's camera.
# This declaration does not request access before the person chooses capture.
main_info['NSCameraUsageDescription'] ||= 'Capri usa la cámara cuando eliges leer el QR de tu laptop o capturar una foto o un video para adjuntarlo a una conversación o un trabajo.'
# The continued-processing request is user initiated in the foreground. Keep
# existing modes and IDs, and declare a wildcard for a unique run suffix. Xcode
# resolves the bundle identifier during build; a re-signer may change the app
# ID afterward, so native code must check the final values and fall back if the
# signed bundle and permitted prefix no longer match.
background_modes = main_info['UIBackgroundModes'] ||= []
raise 'Expected UIBackgroundModes array of strings.' unless background_modes.is_a?(Array) && background_modes.all? { |item| item.is_a?(String) }
background_modes << 'processing' unless background_modes.include?('processing')
task_identifiers = main_info['BGTaskSchedulerPermittedIdentifiers'] ||= []
raise 'Expected BGTaskSchedulerPermittedIdentifiers array of strings.' unless task_identifiers.is_a?(Array) && task_identifiers.all? { |item| item.is_a?(String) }
inference_identifier = '$(PRODUCT_BUNDLE_IDENTIFIER).capri-inference.*'
task_identifiers << inference_identifier unless task_identifiers.include?(inference_identifier)
schemes = main_info['CFBundleURLTypes'] ||= []
raise 'Expected CFBundleURLTypes array.' unless schemes.is_a?(Array)
unless schemes.any? { |entry| Array(entry['CFBundleURLSchemes']).include?('capri-auth') }
  schemes << { 'CFBundleURLName' => 'dev.gentledot.capri.oauth', 'CFBundleURLSchemes' => ['capri-auth'] }
end
unless schemes.any? { |entry| Array(entry['CFBundleURLSchemes']).include?('dev.gentledot.capri.auth') }
  schemes << { 'CFBundleURLName' => 'dev.gentledot.capri.mcp-oauth', 'CFBundleURLSchemes' => ['dev.gentledot.capri.auth'] }
end
google_client = ENV.fetch('CAPRI_GOOGLE_CLIENT_ID', '').strip
unless google_client.empty?
  raise 'Expected a public Google iOS client ID, never a client secret.' unless google_client.match?(/\A[A-Za-z0-9_-]+\.apps\.googleusercontent\.com\z/)
  google_scheme = google_client.split('.').reverse.join('.')
  schemes.reject! { |entry| entry['CFBundleURLName'] == 'dev.gentledot.capri.google' }
  schemes << { 'CFBundleURLName' => 'dev.gentledot.capri.google', 'CFBundleURLSchemes' => [google_scheme] }
  main_info['CapriGoogleClientID'] = google_client
end
main['entitlements'] ||= { 'path' => "#{name}/#{name}.entitlements" }
main['entitlements']['properties'] ||= {}
groups = main['entitlements']['properties']['com.apple.security.application-groups'] ||= []
raise 'Expected application groups array.' unless groups.is_a?(Array)
groups << group unless groups.include?(group)
dependencies = main['dependencies'] ||= []
dependencies.reject! { |dependency| dependency['target'] == 'CapriShare' }
dependencies << { 'target' => 'CapriShare', 'embed' => true, 'codeSign' => false }

predicate = 'SUBQUERY(extensionItems, $item, SUBQUERY($item.attachments, $attachment, ' \
  'ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.audio" OR ' \
  'ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.mpeg-4" OR ' \
  'ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.image" OR ' \
  'ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.plain-text" OR ' \
  'ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "com.adobe.pdf" OR ' \
  'ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.file-url").@count == ' \
  '$item.attachments.@count AND $item.attachments.@count > 0 AND $item.attachments.@count <= 10).@count == extensionItems.@count AND extensionItems.@count > 0'
spec['targets']['CapriShare'] = {
  'type' => 'app-extension', 'platform' => 'iOS', 'deploymentTarget' => '15.0',
  'sources' => [
    { 'path' => relative.call('share-extension/ShareViewController.swift') },
    { 'path' => relative.call('share-extension/SharedMediaInspection.swift') },
    { 'path' => relative.call('plugin-device-bridge/ios/Sources/AppGroupResolver.swift') },
    { 'path' => relative.call('plugin-device-bridge/ios/Sources/SharedInbox.swift') }
  ],
  'settings' => { 'base' => {
    'PRODUCT_NAME' => 'CapriShare', 'PRODUCT_MODULE_NAME' => 'CapriShare',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'dev.gentledot.capri.share',
    'SWIFT_VERSION' => '5.0', 'APPLICATION_EXTENSION_API_ONLY' => true,
    'SKIP_INSTALL' => true, 'CODE_SIGNING_ALLOWED' => false, 'CODE_SIGNING_REQUIRED' => false,
    'TARGETED_DEVICE_FAMILY' => '1,2', 'GENERATE_INFOPLIST_FILE' => false
  } },
  'info' => { 'path' => 'CapriShare/Info.plist', 'properties' => {
    'CFBundleDisplayName' => 'Capri',
    'CFBundleShortVersionString' => main_info.fetch('CFBundleShortVersionString', '0.1.0'),
    'CFBundleVersion' => main_info.fetch('CFBundleVersion', '1'),
    'CapriAppGroup' => group,
    'NSExtension' => {
      'NSExtensionPointIdentifier' => 'com.apple.share-services',
      'NSExtensionPrincipalClass' => '$(PRODUCT_MODULE_NAME).ShareViewController',
      'NSExtensionAttributes' => { 'NSExtensionActivationRule' => predicate }
    }
  } },
  'entitlements' => { 'path' => 'CapriShare/CapriShare.entitlements',
    'properties' => { 'com.apple.security.application-groups' => [group] } },
  'dependencies' => [{ 'sdk' => 'UniformTypeIdentifiers.framework' }, { 'sdk' => 'CryptoKit.framework' }]
}
File.write(spec_path, YAML.dump(spec))
unless ARGV.include?('--spec-only')
  Dir.chdir(directory) do
    raise 'XcodeGen failed while adding Capri Share Extension.' unless system('xcodegen', 'generate', '--spec', spec_path)
  end
end
puts 'Configured Capri Share Extension, matching App Groups, and OAuth callback scheme.'

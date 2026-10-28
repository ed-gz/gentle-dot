#!/usr/bin/env ruby
# The frontend is embedded by Tauri. Keep an independently verifiable exact PNG
# in the app resources as well; both copies are checked before/after packaging.
require 'yaml'
require 'pathname'
ios = File.expand_path('..', __dir__)
spec_path = File.expand_path(ARGV.find { |value| !value.start_with?('--') } || 'src-tauri/gen/apple/project.yml', ios)
spec = YAML.safe_load(File.read(spec_path), permitted_classes: [], permitted_symbols: [], aliases: true)
apps = spec.fetch('targets').select { |_name, target| target['type'] == 'application' && target['platform'] == 'iOS' }
raise 'Expected one iOS application target.' unless apps.length == 1
art = File.join(ios, 'public/personal-art')
raise 'Missing verified personal artwork.' unless File.file?(File.join(art, 'capri-full.png')) && File.file?(File.join(art, 'manifest.json'))
relative = Pathname.new(art).relative_path_from(Pathname.new(File.dirname(spec_path))).to_s
sources = apps.values.first['sources'] ||= []
sources.reject! { |item| item.is_a?(Hash) && item['path'] == relative }
sources << { 'path' => relative, 'type' => 'folder', 'buildPhase' => 'resources' }
File.write(spec_path, YAML.dump(spec))
unless ARGV.include?('--spec-only')
  Dir.chdir(File.dirname(spec_path)) { raise 'XcodeGen failed while packaging personal Capri.' unless system('xcodegen', 'generate', '--spec', spec_path) }
end
puts 'Configured personal Capri bundle resources.'

import AVFoundation
import Foundation

@main
struct VoiceLevelTests {
    static func main() throws {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1),
              let audio = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 256),
              let samples = audio.floatChannelData?[0] else { fatalError("Cannot create PCM fixture") }
        audio.frameLength = 256
        for index in 0..<256 { samples[index] = 0 }
        precondition(VoiceLevel.measure(audio) == 0, "silence has no signal")
        for index in 0..<256 { samples[index] = 0.1 }
        guard let quiet = VoiceLevel.measure(audio) else { fatalError("meter unavailable") }
        precondition(quiet > 0 && quiet < 1, "voice-sized signal should have a visible level")
        for index in 0..<256 { samples[index] = 0.8 }
        guard let loud = VoiceLevel.measure(audio) else { fatalError("meter unavailable") }
        precondition(loud > quiet && loud <= 1, "louder input must produce a higher bounded level")
        samples[0] = .nan
        precondition(VoiceLevel.measure(audio) == nil, "invalid input must not produce a misleading level")
        precondition(VoiceLevel.fromDecibels(-80) == 0)
        precondition(VoiceLevel.fromDecibels(0) == 1)
        precondition(VoiceLevel.fromDecibels(.nan) == nil)
        guard let tone = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1_024),
              let toneSamples = tone.floatChannelData?[0] else { fatalError("Cannot create tone fixture") }
        tone.frameLength = 1_024
        for index in 0..<1_024 { toneSamples[index] = Float(sin(2 * Double.pi * 3_000 * Double(index) / 48_000)) }
        precondition((VoiceLevel.measure(tone) ?? 0) > 0.5, "meter must not alias a periodic input into silence")
        guard let stereo = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 44_100, channels: 2, interleaved: true),
              let mixed = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: 32), let ints = mixed.int16ChannelData?[0] else { fatalError("Cannot create interleaved PCM fixture") }
        mixed.frameLength = 32
        for index in 0..<64 { ints[index] = index.isMultiple(of: 2) ? 16_384 : 0 }
        guard let stereoLevel = VoiceLevel.measure(mixed) else { fatalError("stereo meter unavailable") }
        precondition(stereoLevel > quiet && stereoLevel < 1, "interleaved channels must be sampled correctly")
        print("VoiceLevel: bounded PCM meter, silence, invalid and interleaved samples passed.")
    }
}

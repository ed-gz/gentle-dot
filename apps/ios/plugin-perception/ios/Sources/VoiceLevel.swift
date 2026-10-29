import AVFoundation
import Foundation

/// An ephemeral input meter, not a speech detector. It samples a bounded number
/// of frames and never retains audio or emits it to logs. Nil means this PCM
/// format could not be metered; silence is represented by zero.
enum VoiceLevel {
    static func measure(_ buffer: AVAudioPCMBuffer) -> Double? {
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        guard frames > 0, channels > 0, channels <= 8 else { return nil }
        let samples = min(frames, 64)
        let interleaved = buffer.format.isInterleaved
        var sum = 0.0
        var count = 0
        for channel in 0..<channels {
            for index in 0..<samples {
                // A small deterministic offset avoids repeatedly sampling the
                // same phase of a periodic signal (for example at 3 kHz).
                let frame = (index * frames / samples + index % 7) % frames
                let plane = interleaved ? 0 : channel
                let offset = interleaved ? frame * channels + channel : frame
                let value: Double
                switch buffer.format.commonFormat {
                case .pcmFormatFloat32:
                    guard let data = buffer.floatChannelData else { return nil }
                    value = Double(data[plane][offset])
                case .pcmFormatInt16:
                    guard let data = buffer.int16ChannelData else { return nil }
                    value = Double(data[plane][offset]) / 32_768
                case .pcmFormatInt32:
                    guard let data = buffer.int32ChannelData else { return nil }
                    value = Double(data[plane][offset]) / 2_147_483_648
                default: return nil
                }
                guard value.isFinite else { return nil }
                let bounded = max(-1, min(1, value))
                sum += bounded * bounded
                count += 1
            }
        }
        guard count > 0 else { return nil }
        let rms = sqrt(sum / Double(count))
        // Map -60 dBFS…0 dBFS to 0…1. The quiet floor is not proof that
        // speech is absent; callers should only use this for visual feedback.
        return rms > 0 ? max(0, min(1, (20 * log10(rms) + 60) / 60)) : 0
    }

    static func fromDecibels(_ decibels: Float) -> Double? {
        guard decibels.isFinite else { return nil }
        return max(0, min(1, (Double(decibels) + 60) / 60))
    }
}

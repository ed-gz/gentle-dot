import AVFoundation
import Foundation

enum VoiceAudioError: Error {
    case invalidFormat, converterUnavailable, cannotAllocate, conversionFailed, excessiveOutput
}

/// SpeechAnalyzer requires input in a compatible format. AVAudioFile's
/// processing format can preserve the actual recording's sample rate and
/// channel count even when a different common format was requested on open.
enum VoiceAudio {
    static func openForAnalysis(source: URL, converted: URL, format: AVAudioFormat,
                                maximumSeconds: Double, diagnostic: ((String) -> Void)? = nil) throws -> AVAudioFile {
        guard format.sampleRate.isFinite, format.sampleRate > 0, format.sampleRate <= 192_000,
              format.channelCount > 0, format.channelCount <= 8,
              maximumSeconds.isFinite, maximumSeconds > 0, maximumSeconds <= 90 else {
            throw VoiceAudioError.invalidFormat
        }
        diagnostic?("open-input")
        let input = try AVAudioFile(forReading: source, commonFormat: format.commonFormat,
                                    interleaved: format.isInterleaved)
        if input.processingFormat.isEqual(format) { return input }
        diagnostic?("create-converter")
        guard let converter = AVAudioConverter(from: input.processingFormat, to: format) else {
            throw VoiceAudioError.converterUnavailable
        }
        diagnostic?("open-output")
        var output: AVAudioFile? = try AVAudioFile(forWriting: converted, settings: format.settings,
                                                    commonFormat: format.commonFormat,
                                                    interleaved: format.isInterleaved)
        var endedInput = false
        var readError: Error?
        var framesWritten: AVAudioFramePosition = 0
        let frameLimit = AVAudioFramePosition(ceil(format.sampleRate * (maximumSeconds + 1)))
        diagnostic?("convert")
        while true {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else {
                throw VoiceAudioError.cannotAllocate
            }
            let previousPosition = input.framePosition
            var conversionError: NSError?
            let result = converter.convert(to: buffer, error: &conversionError) { requested, status in
                if endedInput { status.pointee = .endOfStream; return nil }
                // AVAudioFile.read(into:) can throw at EOF without supplying an
                // NSError. Detect the known end before asking it for a buffer.
                if input.framePosition >= input.length {
                    endedInput = true; status.pointee = .endOfStream; return nil
                }
                guard let next = AVAudioPCMBuffer(pcmFormat: input.processingFormat,
                    frameCapacity: min(max(requested, 1), 65_536)) else {
                    readError = VoiceAudioError.cannotAllocate; status.pointee = .endOfStream; return nil
                }
                do { try input.read(into: next) }
                catch {
                    if input.framePosition >= input.length { endedInput = true }
                    else { readError = error }
                    status.pointee = .endOfStream; return nil
                }
                if next.frameLength == 0 { endedInput = true; status.pointee = .endOfStream; return nil }
                status.pointee = .haveData
                return next
            }
            if let error = readError ?? conversionError { throw error }
            if buffer.frameLength > 0 {
                framesWritten += AVAudioFramePosition(buffer.frameLength)
                guard framesWritten <= frameLimit else { throw VoiceAudioError.excessiveOutput }
                guard let writer = output else { throw VoiceAudioError.conversionFailed }
                try writer.write(from: buffer)
            }
            if result == .endOfStream { break }
            if result == .error || (buffer.frameLength == 0 && input.framePosition == previousPosition) {
                throw VoiceAudioError.conversionFailed
            }
        }
        // Release the writer to flush and close its file before opening for reading.
        output = nil
        diagnostic?("open-converted")
        let file = try AVAudioFile(forReading: converted, commonFormat: format.commonFormat,
                                   interleaved: format.isInterleaved)
        guard file.processingFormat.isEqual(format) else { throw VoiceAudioError.invalidFormat }
        return file
    }
}

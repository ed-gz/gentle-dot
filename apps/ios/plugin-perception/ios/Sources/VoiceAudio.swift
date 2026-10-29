import AVFoundation
import Foundation

enum VoiceAudioError: Error {
    case invalidFormat, converterUnavailable, cannotAllocate, conversionFailed, excessiveOutput
}

/// Convert the file to the requested sample rate and channels, then expose it
/// through AVAudioFile's standard Float32 processing representation. In the
/// macOS 26 synthetic probe, the same 16 kHz Int16 CAF failed when opened as
/// Int16 and succeeded when read as standard Float32. Physical bytes are not
/// changed by the final read representation.
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
        if input.processingFormat.isEqual(format) {
            return try openStandardFile(source, matching: format, maximumSeconds: maximumSeconds)
        }
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
        return try openStandardFile(converted, matching: format, maximumSeconds: maximumSeconds)
    }

    private static func openStandardFile(_ url: URL, matching format: AVAudioFormat,
                                         maximumSeconds: Double) throws -> AVAudioFile {
        // The file API uses its processing representation, independent of the
        // on-disk encoding. Reopen without rewriting the recording.
        let file = try AVAudioFile(forReading: url)
        let processing = file.processingFormat
        guard processing.commonFormat == .pcmFormatFloat32, !processing.isInterleaved,
              processing.sampleRate == format.sampleRate, processing.channelCount == format.channelCount else {
            throw VoiceAudioError.invalidFormat
        }
        let frameLimit = AVAudioFramePosition(ceil(format.sampleRate * (maximumSeconds + 1)))
        guard file.length >= 0, file.length <= frameLimit else { throw VoiceAudioError.excessiveOutput }
        return file
    }
}

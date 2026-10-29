import AVFoundation
import Foundation
import Speech

enum LiveVoiceCaptureError: Error {
    case invalidFormat, cannotCopy, recordingInterrupted, captureOverflow, writeFailed
}

/// Queues are bounded independently: a lagging preview cannot compromise the
/// original file. If the file writer falls behind, stop and report failure
/// instead of silently returning an incomplete recording as successful.
@available(iOS 26.0, *)
final class LiveCaptureState {
    let inputs: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let writeQueue = DispatchQueue(label: "dev.gentledot.capri.voice.write", qos: .userInitiated)
    private let previewQueue = DispatchQueue(label: "dev.gentledot.capri.voice.preview", qos: .userInitiated)
    private let lock = NSLock()
    private let issue: (String) -> Void
    private let sourceFormat: AVAudioFormat
    private let targetFormat: AVAudioFormat
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var lifecycle = LiveCaptureLifecycle()
    private var previewEnabled = true
    private var writePending = 0
    private var previewPending = 0
    private let queueLimit = 64
    private var remainingFrames: Int64
    private var failure: LiveVoiceCaptureError?
    private var level: Double?
    var stopEngine: (() -> Void)?

    init(url: URL, source: AVAudioFormat, target: AVAudioFormat, issue: @escaping (String) -> Void) throws {
        guard source.sampleRate.isFinite, source.sampleRate >= 8_000, source.sampleRate <= 192_000,
              source.channelCount > 0, source.channelCount <= 8,
              source.streamDescription.pointee.mFormatID == kAudioFormatLinearPCM,
              source.streamDescription.pointee.mFramesPerPacket == 1,
              target.sampleRate.isFinite, target.sampleRate >= 8_000, target.sampleRate <= 192_000,
              target.channelCount > 0, target.channelCount <= 8,
              target.streamDescription.pointee.mFormatID == kAudioFormatLinearPCM,
              target.streamDescription.pointee.mFramesPerPacket == 1 else { throw LiveVoiceCaptureError.invalidFormat }
        let pair = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(64))
        inputs = pair.stream; continuation = pair.continuation
        sourceFormat = source; targetFormat = target; self.issue = issue
        remainingFrames = Int64((source.sampleRate * 90).rounded(.down))
        file = try AVAudioFile(forWriting: url, settings: source.settings,
                               commonFormat: source.commonFormat, interleaved: source.isInterleaved)
        if !source.isEqual(target) {
            converter = AVAudioConverter(from: source, to: target)
            if converter == nil { previewEnabled = false; continuation.finish() }
        }
    }

    func begin() {
        lock.lock(); lifecycle.begin(); let noPreview = !previewEnabled; lock.unlock()
        if noPreview { issue("La vista previa no está disponible. El audio se transcribirá al terminar.") }
    }

    func enableHardwareMonitor() { lock.lock(); lifecycle.enableHardwareMonitor(); lock.unlock() }

    var microphoneLevel: Double? { lock.lock(); defer { lock.unlock() }; return level }

    /// This may arrive on the audio engine's internal queue. Do not tear down
    /// the engine here; report the failure and schedule teardown on main.
    func hardwareChanged() {
        lock.lock()
        let affected = lifecycle.hardwareChanged()
        if affected { failure = .recordingInterrupted }
        let stopAction = stopEngine
        lock.unlock()
        if affected {
            issue("Cambió el micrófono y la grabación se interrumpió. Vuelve a intentarlo.")
            stopAction?()
        }
    }

    func receive(_ buffer: AVAudioPCMBuffer) {
        var issueMessage: String?
        var stop = false
        lock.lock()
        guard lifecycle.accepting else { lock.unlock(); return }
        if !buffer.format.isEqual(sourceFormat) {
            failure = .recordingInterrupted; lifecycle.close(); stop = true
            issueMessage = "Cambió el micrófono y la grabación se interrumpió. Vuelve a intentarlo."
        } else if buffer.frameLength > 65_536 {
            failure = .captureOverflow; lifecycle.close(); stop = true
            issueMessage = "El bloque de audio fue demasiado grande. Vuelve a dictarlo."
        } else if buffer.frameLength == 0 {
            // No samples arrived. This is not a failed copy or lost audio;
            // keep accepting the next buffer and preserve the current meter.
            lock.unlock(); return
        } else {
            level = VoiceLevel.measure(buffer)
            var offset: AVAudioFrameCount = 0
            // Apple may deliver more frames than requested. Copy bounded
            // chunks in order, never holding the engine's reusable buffer.
            while offset < buffer.frameLength && remainingFrames > 0 {
                if writePending >= queueLimit {
                    failure = .captureOverflow; lifecycle.close(); stop = true
                    issueMessage = "No pude conservar todo el audio. Vuelve a dictarlo."
                    break
                }
                let frames = AVAudioFrameCount(min(Int64(min(buffer.frameLength - offset, 8_192)), remainingFrames))
                guard let copy = LiveAudioBuffer.copy(buffer, offset: offset, frames: frames) else {
                    failure = .cannotCopy; lifecycle.close(); stop = true
                    issueMessage = "No pude conservar todo el audio. Vuelve a dictarlo."
                    break
                }
                offset += frames
                remainingFrames -= Int64(frames)
                writePending += 1
                // Enqueue under the lock so drain() cannot overtake this buffer.
                writeQueue.async { [self] in
                    defer { lock.lock(); writePending -= 1; lock.unlock() }
                    do { guard let file else { throw LiveVoiceCaptureError.writeFailed }; try file.write(from: copy) }
                    catch { failRecording(.writeFailed) }
                }
                if previewEnabled {
                    if previewPending >= queueLimit {
                        previewEnabled = false; continuation.finish()
                        issueMessage = "La vista previa perdió audio. La grabación completa se transcribirá al terminar."
                    } else {
                        previewPending += 1
                        previewQueue.async { [self] in
                            defer { lock.lock(); previewPending -= 1; lock.unlock() }
                            convert(copy)
                        }
                    }
                }
            }
            if remainingFrames == 0 { lifecycle.close(); stop = true }
        }
        let stopAction = stopEngine
        lock.unlock()
        if let issueMessage { issue(issueMessage) }
        if stop { stopAction?() }
    }

    private func failRecording(_ reason: LiveVoiceCaptureError) {
        lock.lock()
        let first = failure == nil
        if first { failure = reason; lifecycle.close() }
        let stopAction = stopEngine
        lock.unlock()
        if first {
            issue("No pude conservar la grabación completa. Vuelve a intentarlo.")
            stopAction?()
        }
    }

    private func failPreview() {
        lock.lock()
        let first = previewEnabled
        if first { previewEnabled = false; continuation.finish() }
        lock.unlock()
        if first { issue("La vista previa se interrumpió. La grabación completa se transcribirá al terminar.") }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); let enabled = previewEnabled; lock.unlock()
        guard enabled else { return }
        if sourceFormat.isEqual(targetFormat) {
            emit(buffer)
            return
        }
        guard let converter else { failPreview(); return }
        let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
        var offset: AVAudioFrameCount = 0
        var iterations = 0
        while offset < buffer.frameLength {
            iterations += 1
            guard iterations <= 64 else { failPreview(); return }
            let before = offset
            let wanted = Int(ceil(Double(buffer.frameLength - offset) * ratio)) + 256
            let capacity = min(65_536, max(1, wanted))
            guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(capacity)) else { failPreview(); return }
            var invalidInput = false
            var error: NSError?
            let status = converter.convert(to: converted, error: &error) { requested, inputStatus in
                guard offset < buffer.frameLength else { inputStatus.pointee = .noDataNow; return nil }
                let frames = min(requested, buffer.frameLength - offset)
                guard frames > 0, let slice = LiveAudioBuffer.copy(buffer, offset: offset, frames: frames) else {
                    invalidInput = true; inputStatus.pointee = .noDataNow; return nil
                }
                offset += frames
                inputStatus.pointee = .haveData
                return slice
            }
            guard error == nil, status != .error, !invalidInput,
                  offset > before || converted.frameLength > 0 else { failPreview(); return }
            if converted.frameLength > 0 { emit(converted) }
            lock.lock(); let stillEnabled = previewEnabled; lock.unlock()
            guard stillEnabled else { return }
        }
    }

    private func emit(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else { return }
        switch continuation.yield(AnalyzerInput(buffer: buffer)) {
        case .enqueued: break
        case .dropped, .terminated: failPreview()
        @unknown default: failPreview()
        }
    }

    /// A sample-rate converter may hold a short priming tail. Flush it before
    /// ending the preview sequence instead of silently discarding that audio.
    private func flushPreview() {
        lock.lock(); let enabled = previewEnabled; lock.unlock()
        guard enabled, let converter else { return }
        for _ in 0..<64 {
            guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: 4096) else { failPreview(); return }
            var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, inputStatus in
                inputStatus.pointee = .endOfStream; return nil
            }
            guard error == nil, status != .error else { failPreview(); return }
            if converted.frameLength > 0 { emit(converted) }
            if status == .endOfStream { return }
            if converted.frameLength == 0 { failPreview(); return }
            lock.lock(); let stillEnabled = previewEnabled; lock.unlock()
            guard stillEnabled else { return }
        }
        failPreview()
    }

    func closeInput() { lock.lock(); lifecycle.close(); lock.unlock() }

    private func recordingFailure() -> LiveVoiceCaptureError? {
        lock.lock(); defer { lock.unlock() }; return failure
    }

    private func finishPreview() {
        lock.lock(); previewEnabled = false; lock.unlock()
        continuation.finish()
    }

    func drain() async throws {
        closeInput()
        await LiveVoiceDrain.barrier(on: writeQueue) { [self] in file = nil }
        await LiveVoiceDrain.barrier(on: previewQueue) { [self] in flushPreview(); finishPreview() }
        if let error = recordingFailure() { throw error }
    }
}

/// The caller has already requested microphone permission and activated the
/// audio session. Failure to start may fall back to the existing recorder.
@available(iOS 26.0, *)
@MainActor
final class LiveVoiceCapture {
    let inputs: AsyncStream<AnalyzerInput>
    private let url: URL
    private let engine = AVAudioEngine()
    private let state: LiveCaptureState
    private let preserveOnStartFailure: Bool
    private var running = false
    private var tapInstalled = false
    private var timer: DispatchWorkItem?
    private var configurationObserver: NSObjectProtocol?

    var recording: Bool { running }
    var microphoneLevel: Double? { state.microphoneLevel }

    init(url: URL, analyzerFormat: AVAudioFormat, preserveOnStartFailure: Bool = false, onPreviewIssue: @escaping (String) -> Void) throws {
        self.url = url
        self.preserveOnStartFailure = preserveOnStartFailure
        let source = engine.inputNode.outputFormat(forBus: 0)
        state = try LiveCaptureState(url: url, source: source, target: analyzerFormat) { message in
            DispatchQueue.main.async { onPreviewIssue(message) }
        }
        inputs = state.inputs
        state.stopEngine = { [weak self] in DispatchQueue.main.async { self?.stopInput() } }
    }

    deinit {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
    }

    func start() async throws {
        guard !running, !tapInstalled else { throw LiveVoiceCaptureError.recordingInterrupted }
        let node = engine.inputNode
        node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { [state] buffer, _ in
            state.receive(buffer)
        }
        tapInstalled = true
        state.begin()
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: nil) { [state] _ in state.hardwareChanged() }
        do {
            engine.prepare(); try engine.start(); running = true
            state.enableHardwareMonitor()
            // A configuration change between start() and enabling the monitor
            // can stop the engine before its notification is observed.
            if !engine.isRunning { state.hardwareChanged() }
        } catch {
            // Fallback may use the same URL. Release any queued writer before
            // allowing the caller to create its recorder there.
            stopInput()
            try? await state.drain()
            if !preserveOnStartFailure { try? FileManager.default.removeItem(at: url) }
            throw error
        }
        let cutoff = DispatchWorkItem { [weak self] in self?.stopInput() }
        timer = cutoff; DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: cutoff)
    }

    private func stopInput() {
        timer?.cancel(); timer = nil
        state.closeInput()
        if let observer = configurationObserver {
            NotificationCenter.default.removeObserver(observer); configurationObserver = nil
        }
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        running = false
    }

    /// Returns only after all accepted original samples have been written and
    /// the file has been closed. Any loss/error makes the entire capture fail.
    func stop() async throws {
        stopInput()
        try await state.drain()
    }

    /// The temporary file is removed only after the writer can no longer use it.
    func cancel() async {
        stopInput()
        try? await state.drain()
        try? FileManager.default.removeItem(at: url)
    }
}

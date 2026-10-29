import AVFoundation
import Foundation
import Tauri
import UIKit
import WebKit

private struct SessionArgs: Decodable { let sessionId: String; let ownerId: String?; let retainDestination: String? }
private struct VoiceOwnerArgs: Decodable { let ownerId: String?; let retainDestination: String? }
private struct RetainedVoiceArgs: Decodable { let record: VoiceRecoveryRecord }
private struct VoiceReceiptArgs: Decodable { let receipt: VoiceNativeReceipt }
private struct VoiceReceiptSessionArgs: Decodable { let sessionId: String }

final class PerceptionPlugin: Plugin {
    private var voice: AnyObject?
    private var document: DocumentOperation?
    private var pairingCode: DocumentOperation?
    private var observers: [NSObjectProtocol] = []

    @objc override func load(webview: WKWebView) {
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    if #available(iOS 26.0, *) { (self?.voice as? VoiceController)?.resignActive() }
                    self?.document?.cancel()
                    self?.pairingCode?.cancel()
                }
            })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    if #available(iOS 26.0, *) { (self?.voice as? VoiceController)?.enterBackground() }
                    self?.document?.cancel()
                    self?.pairingCode?.cancel()
                }
            })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main) { [weak self] notification in
                guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      raw == AVAudioSession.InterruptionType.began.rawValue else { return }
                Task { @MainActor in if #available(iOS 26.0, *) { (self?.voice as? VoiceController)?.audioInterrupted() } }
            })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        document?.cancel()
        pairingCode?.cancel()
    }

    @available(iOS 26.0, *)
    @MainActor
    private func controller() -> VoiceController {
        if let current = voice as? VoiceController { return current }
        let current = VoiceController(); voice = current; return current
    }

    @objc func checkVoice(_ invoke: Invoke) {
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().check()) }
            else { invoke.resolve(VoiceReply(available: false, status: "os_unsupported", message: "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func prepareVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(VoiceOwnerArgs.self), args.ownerId == nil || UUID(uuidString: args.ownerId!) != nil else {
            invoke.resolve(VoiceReply.failure("invalid_voice_owner", "El comando de voz no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().prepare(ownerID: args.ownerId)) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func startVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(VoiceOwnerArgs.self), args.ownerId == nil || UUID(uuidString: args.ownerId!) != nil,
              args.retainDestination == nil || (args.ownerId != nil && VoiceRetentionBinding.validDestination(args.retainDestination)) else {
            invoke.resolve(VoiceReply.failure("invalid_voice_owner", "El comando de voz no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().start(ownerID: args.ownerId, retainDestination: args.retainDestination)) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func stopVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(SessionArgs.self), UUID(uuidString: args.sessionId) != nil,
              (args.ownerId == nil && args.retainDestination == nil) ||
              (args.ownerId.flatMap(UUID.init(uuidString:)) != nil && VoiceRetentionBinding.validDestination(args.retainDestination)) else {
            invoke.resolve(VoiceReply.failure("invalid_voice_session", "El comando de voz no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().stop(id: args.sessionId, retainOwner: args.ownerId, retainDestination: args.retainDestination)) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func cancelVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(VoiceOwnerArgs.self), args.ownerId == nil || UUID(uuidString: args.ownerId!) != nil else {
            invoke.resolve(VoiceReply.failure("invalid_voice_owner", "El comando de voz no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) {
                let result: VoiceCancellationResult
                if let id = args.ownerId {
                    result = await controller().cancelAndConfirm(ownerID: id)
                } else if let controller = voice as? VoiceController {
                    result = await controller.cancelAndConfirm(ownerID: nil)
                } else { result = .confirmed }
                switch result {
                case .confirmed: break
                case .closing:
                    invoke.resolve(VoiceReply.failure("cancel_pending", "Apple todavía está deteniendo el micrófono. Toca el micrófono para reintentar.")); return
                case .cleanupFailed:
                    invoke.resolve(VoiceReply.failure("cancel_cleanup_failed", "No pude eliminar el audio pendiente. Toca el micrófono para reintentar.")); return
                }
            }
            invoke.resolve(VoiceReply(ok: true))
        }
    }
    @objc func inspectRetainedVoice(_ invoke: Invoke) {
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().inspectRetained()) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func discardRetainedVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(RetainedVoiceArgs.self) else {
            invoke.resolve(VoiceReply.failure("invalid_voice_retention", "El audio guardado no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().discardRetained(args.record)) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func attachRetainedVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(RetainedVoiceArgs.self), args.record.state == .ready else {
            invoke.resolve(VoiceReply.failure("invalid_voice_retention", "El audio guardado no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().attachRetained(args.record)) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func listVoiceReceipts(_ invoke: Invoke) {
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().listVoiceReceipts()) }
            else { invoke.resolve(VoiceReceiptReply.failure()) }
        }
    }
    @objc func getVoiceReceipt(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(VoiceReceiptSessionArgs.self), UUID(uuidString: args.sessionId) != nil else { invoke.resolve(VoiceReceiptReply.failure()); return }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().getVoiceReceipt(args.sessionId)) }
            else { invoke.resolve(VoiceReceiptReply.failure()) }
        }
    }
    @objc func discardVoiceReceipt(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(VoiceReceiptArgs.self) else { invoke.resolve(VoiceReceiptReply.failure()); return }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().discardVoiceReceipt(args.receipt)) }
            else { invoke.resolve(VoiceReceiptReply.failure()) }
        }
    }
    @objc func releaseRetainedVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(VoiceReceiptArgs.self) else { invoke.resolve(VoiceReceiptReply.failure()); return }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().releaseRetainedVoice(args.receipt)) }
            else { invoke.resolve(VoiceReceiptReply.failure()) }
        }
    }
    @objc func recognizeDocument(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(DocumentArgs.self) else {
            invoke.resolve(DocumentReply(error: "invalid_document", message: "El documento no es válido.")); return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                invoke.resolve(DocumentReply(error: "not_foreground", message: "Abre Capri para leer el documento.")); return
            }
            guard self.document == nil else {
                invoke.resolve(DocumentReply(error: "busy", message: "Espera a que termine la lectura actual.")); return
            }
            let operation = DocumentOperation()
            self.document = operation
            let timeout = DispatchWorkItem { operation.cancel(timeout: true) }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 120, execute: timeout)
            DispatchQueue.global(qos: .userInitiated).async {
                let result = operation.recognize(args)
                timeout.cancel()
                DispatchQueue.main.async {
                    if self.document === operation { self.document = nil }
                    invoke.resolve(operation.finalResult(result))
                }
            }
        }
    }
    @objc func cancelDocument(_ invoke: Invoke) {
        DispatchQueue.main.async { self.document?.cancel(); invoke.resolve(VoiceReply(ok: true)) }
    }
    @objc func scanPairingCode(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(DocumentArgs.self) else {
            invoke.resolve(PairingCodeReply(error: "invalid_image")); return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                invoke.resolve(PairingCodeReply(error: "not_foreground")); return
            }
            guard self.pairingCode == nil else {
                invoke.resolve(PairingCodeReply(error: "busy")); return
            }
            let operation = DocumentOperation()
            self.pairingCode = operation
            let timeout = DispatchWorkItem { operation.cancel(timeout: true) }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 30, execute: timeout)
            DispatchQueue.global(qos: .userInitiated).async {
                let result = operation.scanPairingCode(args)
                timeout.cancel()
                DispatchQueue.main.async {
                    if self.pairingCode === operation { self.pairingCode = nil }
                    invoke.resolve(operation.finalResult(result))
                }
            }
        }
    }
    @objc func cancelPairingCode(_ invoke: Invoke) {
        DispatchQueue.main.async { self.pairingCode?.cancel(); invoke.resolve(VoiceReply(ok: true)) }
    }
}

@_cdecl("init_plugin_perception")
func initPerceptionPlugin() -> Plugin { PerceptionPlugin() }

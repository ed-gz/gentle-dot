import AVFoundation
import Foundation
import Tauri
import UIKit
import WebKit

private struct SessionArgs: Decodable { let sessionId: String; let ownerId: String?; let retainDestination: String?; let operationOwnerId: String? }
private struct VoiceOwnerArgs: Decodable { let ownerId: String?; let retainDestination: String? }
private struct RetainedVoiceArgs: Decodable { let record: VoiceRecoveryRecord; let ownerId: String? }
private struct PrepareRetainedVoiceArgs: Decodable { let record: VoiceRecoveryRecord; let ownerId: String }
private struct VoiceReceiptArgs: Decodable { let receipt: VoiceNativeReceipt }
private struct VoiceReceiptSessionArgs: Decodable { let sessionId: String }
private struct DocumentRequestIdArgs: Decodable { let requestId: String }
private struct IncompleteVoiceExportReply: Encodable {
    let ok: Bool
    let exported: Bool?
    let cancelled: Bool?
    let error: String?
    let message: String?
    static func failure() -> Self { Self(ok: false, exported: nil, cancelled: nil, error: "export_unconfirmed", message: "No pude confirmar la exportación. Revisa el estado del audio.") }
}

final class PerceptionPlugin: Plugin {
    private var voice: AnyObject?
    private var document: DocumentOperation?
    private var documentOwners = DocumentOwnership()
    private var pairingCode: DocumentOperation?
    private let pairingBarrier = PairingScanBarrier()
    private var observers: [NSObjectProtocol] = []
    private weak var exportWebview: WKWebView?
    private var incompleteExporter: VoiceIncompleteExporter?
    private var incompleteExportBusy = false
    private var incompleteTemporary: URL?
    private var incompleteExportInitialized = false
    private let incompleteExportRoot = FileManager.default.temporaryDirectory.appendingPathComponent("capri-incomplete-voice-exports", isDirectory: true)

    private func removeIncompleteCopy(_ url: URL) -> Bool {
        do { try FileManager.default.removeItem(at: url); return true }
        catch {
            let issue = error as NSError
            return issue.domain == NSCocoaErrorDomain && issue.code == NSFileNoSuchFileError
        }
    }

    @objc override func load(webview: WKWebView) {
        exportWebview = webview
        if !incompleteExportInitialized {
            // These are protected copies only, never the journal source. A
            // force-killed picker cannot clean them until the next launch.
            incompleteExportInitialized = removeIncompleteCopy(incompleteExportRoot)
        }
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
        if let directory = incompleteTemporary { try? FileManager.default.removeItem(at: directory) }
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
              (args.operationOwnerId == nil || args.operationOwnerId.flatMap(UUID.init(uuidString:)) != nil),
              (args.ownerId == nil && args.retainDestination == nil) ||
              (args.ownerId.flatMap(UUID.init(uuidString:)) != nil && VoiceRetentionBinding.validDestination(args.retainDestination)) else {
            invoke.resolve(VoiceReply.failure("invalid_voice_session", "El comando de voz no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().stop(id: args.sessionId, retainOwner: args.ownerId, retainDestination: args.retainDestination, operationOwner: args.operationOwnerId)) }
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
    @objc func exportIncompleteVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(RetainedVoiceArgs.self), args.record.state == .capturing else {
            invoke.resolve(IncompleteVoiceExportReply.failure()); return
        }
        Task { @MainActor in
            guard #available(iOS 26.0, *), !self.incompleteExportBusy, self.incompleteExporter == nil,
                  UIApplication.shared.applicationState == .active else { invoke.resolve(IncompleteVoiceExportReply.failure()); return }
            if let pending = self.incompleteTemporary {
                guard self.removeIncompleteCopy(pending) else { invoke.resolve(IncompleteVoiceExportReply.failure()); return }
                self.incompleteTemporary = nil
            }
            if !self.incompleteExportInitialized {
                guard self.removeIncompleteCopy(self.incompleteExportRoot) else { invoke.resolve(IncompleteVoiceExportReply.failure()); return }
                self.incompleteExportInitialized = true
            }
            self.incompleteExportBusy = true
            let directory = self.incompleteExportRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            self.incompleteTemporary = directory
            do {
                try FileManager.default.createDirectory(at: self.incompleteExportRoot, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                let attributes = try self.incompleteExportRoot.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { throw VoiceRecoveryJournalError.invalid }
                var root = self.incompleteExportRoot, values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.protectionKey: FileProtectionType.complete])
                let copy = directory.appendingPathComponent("capri-audio-incompleto.caf")
                try await self.controller().copyIncompleteForExport(args.record, to: copy)
                guard let presenter = self.exportWebview?.window?.rootViewController else { throw VoiceRecoveryJournalError.busy }
                let exporter = VoiceIncompleteExporter(file: copy) { [weak self] result in
                    if let self {
                        self.incompleteTemporary = self.removeIncompleteCopy(directory) ? nil : directory
                        self.incompleteExporter = nil; self.incompleteExportBusy = false
                    } else { try? FileManager.default.removeItem(at: directory) }
                    switch result {
                    case .success(let exported): invoke.resolve(IncompleteVoiceExportReply(ok: true, exported: exported, cancelled: !exported, error: nil, message: nil))
                    case .failure: invoke.resolve(IncompleteVoiceExportReply.failure())
                    }
                }
                self.incompleteExporter = exporter
                try exporter.present(from: presenter)
            } catch {
                self.incompleteTemporary = self.removeIncompleteCopy(directory) ? nil : directory
                self.incompleteExporter = nil; self.incompleteExportBusy = false
                invoke.resolve(IncompleteVoiceExportReply.failure())
            }
        }
    }
    @objc func prepareRetainedVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(PrepareRetainedVoiceArgs.self), UUID(uuidString: args.ownerId) != nil else {
            invoke.resolve(VoiceReply.failure("invalid_voice_retention", "No se pudo identificar el audio.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().prepareRetained(args.record, ownerID: args.ownerId)) }
            else { invoke.resolve(VoiceReply.failure("os_unsupported", "SpeechAnalyzer requiere iOS 26 o posterior.")) }
        }
    }
    @objc func attachRetainedVoice(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(RetainedVoiceArgs.self), args.record.state == .ready, let owner = args.ownerId, UUID(uuidString: owner) != nil else {
            invoke.resolve(VoiceReply.failure("invalid_voice_retention", "El audio guardado no es válido.")); return
        }
        Task { @MainActor in
            if #available(iOS 26.0, *) { invoke.resolve(await controller().attachRetained(args.record, ownerID: owner)) }
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
        guard let args = try? invoke.parseArgs(DocumentArgs.self), let requestId = args.requestId, UUID(uuidString: requestId) != nil else {
            invoke.resolve(DocumentReply(error: "invalid_document", message: "El documento no es válido.")); return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                invoke.resolve(DocumentReply(error: "not_foreground", message: "Abre Capri para leer el documento.")); return
            }
            guard self.document == nil else {
                invoke.resolve(DocumentReply(error: "busy", message: "Espera a que termine la lectura actual.")); return
            }
            guard self.documentOwners.begin(requestId) else {
                invoke.resolve(DocumentReply(error: "cancelled", message: "Lectura cancelada.")); return
            }
            let operation = DocumentOperation()
            self.document = operation
            let timeout = DispatchWorkItem { operation.cancel(timeout: true) }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 120, execute: timeout)
            DispatchQueue.global(qos: .userInitiated).async {
                let result = operation.recognize(args)
                timeout.cancel()
                DispatchQueue.main.async {
                    if self.document === operation { self.document = nil; self.documentOwners.finish(requestId) }
                    invoke.resolve(operation.finalResult(result))
                }
            }
        }
    }
    @objc func cancelDocument(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(DocumentRequestIdArgs.self), UUID(uuidString: args.requestId) != nil else {
            invoke.resolve(VoiceReply.failure("invalid_document_request", "No se pudo identificar la lectura.")); return
        }
        DispatchQueue.main.async {
            if self.documentOwners.cancel(args.requestId) { self.document?.cancel() }
            invoke.resolve(VoiceReply(ok: true))
        }
    }
    @objc func scanPairingCode(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(DocumentArgs.self), let requestId = args.requestId, UUID(uuidString: requestId) != nil else {
            invoke.resolve(PairingCodeReply(error: "invalid_image")); return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                invoke.resolve(PairingCodeReply(error: "not_foreground")); return
            }
            guard self.pairingCode == nil else {
                invoke.resolve(PairingCodeReply(error: "busy")); return
            }
            guard self.pairingBarrier.begin(requestId) else {
                invoke.resolve(PairingCodeReply(error: "cancelled")); return
            }
            let operation = DocumentOperation()
            self.pairingCode = operation
            let timeout = DispatchWorkItem { operation.cancel(timeout: true) }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 30, execute: timeout)
            DispatchQueue.global(qos: .userInitiated).async {
                let result = operation.scanPairingCode(args)
                timeout.cancel()
                DispatchQueue.main.async {
                    if self.pairingCode === operation {
                        self.pairingCode = nil
                        self.pairingBarrier.finish(requestId)
                    }
                    invoke.resolve(operation.finalResult(result))
                }
            }
        }
    }
    @objc func cancelPairingCode(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(DocumentRequestIdArgs.self), UUID(uuidString: args.requestId) != nil else {
            invoke.resolve(VoiceReply.failure("invalid_scan_request", "No se pudo identificar la lectura.")); return
        }
        DispatchQueue.main.async {
            let shouldCancel = self.pairingBarrier.cancel(args.requestId) { confirmed in
                if confirmed { invoke.resolve(VoiceReply(ok: true)) }
                else { invoke.resolve(VoiceReply.failure("cancel_unconfirmed", "No pude confirmar que terminó la lectura.")) }
            }
            if shouldCancel { self.pairingCode?.cancel() }
        }
    }
}

@_cdecl("init_plugin_perception")
func initPerceptionPlugin() -> Plugin { PerceptionPlugin() }

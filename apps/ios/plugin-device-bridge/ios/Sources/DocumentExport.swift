import Foundation
import CryptoKit
import UIKit

struct ExportBeginInput: Decodable { let name: String; let size: Int; let sha256: String }
struct ExportWriteInput: Decodable { let id: String; let offset: Int; let data: String }

/// The sandbox source is immutable once handed to the system picker. No destination
/// path is returned to JavaScript, and no file leaves the app without the picker.
final class DocumentExportStore {
    static let maximum = 256 * 1024 * 1024
    private final class Transfer {
        let id: String
        let directory: URL
        let url: URL
        let expectedSize: Int
        let expectedHash: String
        var handle: FileHandle?
        var digest = SHA256()
        var written = 0
        var presenting = false
        var expires = Date().addingTimeInterval(120)
        init(_ id: String, _ directory: URL, _ url: URL, _ input: ExportBeginInput, _ handle: FileHandle) {
            self.id = id; self.directory = directory; self.url = url
            expectedSize = input.size; expectedHash = input.sha256; self.handle = handle
        }
    }
    private let lock = NSLock()
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("capri-exports", isDirectory: true)
    private var transfer: Transfer?
    private var initialized = false
    private var suspended = false
    private var timer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []

    init() {
        // Retry on begin if the phone is locked while the plugin loads.
        try? initializeLocked()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.expire() }
        self.timer = timer; timer.resume()
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in self?.setSuspended(true) })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setSuspended(false) })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in self?.discardAll() })
    }
    deinit {
        timer?.cancel()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        discardAll()
    }
    private func removeLocked() {
        guard let current = transfer else { return }
        try? current.handle?.close(); current.handle = nil
        try? FileManager.default.removeItem(at: current.directory)
        transfer = nil
    }
    private func initializeLocked() throws {
        guard !initialized else { return }
        let manager = FileManager.default
        // A force-killed process cannot run a callback. Purge its protected source
        // before creating the next export; these files are never authoritative data.
        if manager.fileExists(atPath: root.path) { try manager.removeItem(at: root) }
        try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var location = root; var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
        try location.setResourceValues(attributes)
        initialized = true
    }
    func begin(_ input: ExportBeginInput) throws -> String {
        guard !input.name.isEmpty, input.name.utf8.count <= 240, input.name != ".", input.name != "..",
              !input.name.hasPrefix("."), !input.name.contains("/"), !input.name.contains("\\"), !input.name.contains(":"),
              !input.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              input.size >= 0, input.size <= Self.maximum,
              input.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw DeviceFailure.invalid("Nombre, tamaño o huella de exportación inválidos.") }
        lock.lock(); defer { lock.unlock() }
        guard !suspended else { throw DeviceFailure.unavailable("Vuelve a Capri para iniciar la exportación.") }
        if let current = transfer, !current.presenting, current.expires <= Date() { removeLocked() }
        guard transfer == nil else { throw DeviceFailure.unavailable("Ya hay una exportación en curso.") }
        try initializeLocked()
        let id = UUID().uuidString.lowercased(), directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = directory.appendingPathComponent(input.name, isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.protectionKey: FileProtectionType.complete])
            guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else { throw DeviceFailure.unavailable("No se pudo preparar el archivo temporal.") }
            transfer = Transfer(id, directory, file, input, try FileHandle(forWritingTo: file))
            return id
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    func write(_ input: ExportWriteInput) throws -> Int {
        guard input.data.utf8.count <= 349_528, let data = Data(base64Encoded: input.data), !data.isEmpty,
              data.count <= 256 * 1024 else { throw DeviceFailure.invalid("Bloque de exportación inválido.") }
        lock.lock(); defer { lock.unlock() }
        guard let current = transfer, current.id == input.id, !current.presenting,
              current.expires > Date(), let handle = current.handle else { throw DeviceFailure.invalid("La exportación ya no está activa.") }
        guard input.offset == current.written, data.count <= current.expectedSize - current.written else {
            removeLocked(); throw DeviceFailure.invalid("El archivo de exportación llegó incompleto o fuera de orden.")
        }
        do {
            try handle.write(contentsOf: data); current.digest.update(data: data)
            current.written += data.count; current.expires = Date().addingTimeInterval(120)
            return current.written
        } catch { removeLocked(); throw error }
    }
    func prepare(_ id: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        guard let current = transfer, current.id == id, !current.presenting, current.expires > Date(),
              let handle = current.handle else { throw DeviceFailure.invalid("La exportación ya no está activa.") }
        do {
            let hash = current.digest.finalize().map { String(format: "%02x", $0) }.joined()
            guard current.written == current.expectedSize, hash == current.expectedHash else { throw DeviceFailure.invalid("El archivo no coincide con el tamaño y la huella originales.") }
            try handle.synchronize(); try handle.close(); current.handle = nil
            let attributes = try FileManager.default.attributesOfItem(atPath: current.url.path)
            guard (attributes[.size] as? NSNumber)?.intValue == current.expectedSize else { throw DeviceFailure.invalid("No se confirmó el archivo temporal completo.") }
            current.presenting = true
            return current.url
        } catch { removeLocked(); throw error }
    }
    func cancel(_ id: String) { lock.lock(); defer { lock.unlock() }; if transfer?.id == id { removeLocked() } }
    func isPrepared(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return transfer?.id == id && transfer?.presenting == true }
    private func setSuspended(_ value: Bool) { lock.lock(); defer { lock.unlock() }; suspended = value; if value && transfer?.presenting == false { removeLocked() } }
    private func discardAll() { lock.lock(); defer { lock.unlock() }; removeLocked() }
    private func expire() { lock.lock(); defer { lock.unlock() }; if let current = transfer, !current.presenting, current.expires <= Date() { removeLocked() } }
}

/// UIKit owns the export itself. A selected destination is the only success path;
/// closing the sheet, cancelling or losing presentation never claims a saved copy.
@MainActor
final class DocumentExporter: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    let id: String
    private let picker: UIDocumentPickerViewController
    private var completion: ((Result<Bool, Error>) -> Void)?
    init(id: String, file: URL, completion: @escaping (Result<Bool, Error>) -> Void) {
        self.id = id
        self.picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        self.completion = completion
        super.init()
        picker.delegate = self; picker.shouldShowFileExtensions = true
    }
    func present(from controller: UIViewController) throws {
        guard UIApplication.shared.applicationState == .active, controller.viewIfLoaded?.window != nil,
              controller.presentedViewController == nil, !controller.isBeingDismissed else { throw DeviceFailure.unavailable("Cierra la otra ventana y vuelve a exportar desde Capri.") }
        controller.present(picker, animated: true)
        picker.presentationController?.delegate = self
        monitorPresentation()
    }
    private func monitorPresentation() {
        // UIKit may refuse presentation or a file-provider extension can close
        // without its normal cancellation callback. Do not leave JS waiting.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.completion != nil else { return }
            if self.picker.presentingViewController == nil {
                self.finish(.failure(DeviceFailure.unavailable("El selector se cerró sin confirmar una copia exportada.")))
            } else { self.monitorPresentation() }
        }
    }
    func cancel() { picker.dismiss(animated: true); finish(.success(false)) }
    private func finish(_ result: Result<Bool, Error>) {
        guard let callback = completion else { return }
        completion = nil; callback(result)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, urls.count == 1, urls[0].isFileURL else {
            finish(.failure(DeviceFailure.unavailable("El selector no confirmó una copia exportada."))); return
        }
        finish(.success(true))
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { if controller === picker { finish(.success(false)) } }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(.success(false)) }
}

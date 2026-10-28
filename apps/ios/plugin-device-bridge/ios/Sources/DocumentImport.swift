import Foundation
import UIKit
import UniformTypeIdentifiers

/// Private app storage, independent of SideStore's App Group rewriting. A
/// published import survives dismissal/relaunch until the JS database commits.
enum DocumentImportStore {
    static func root() throws -> URL {
        var root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("CapriDocumentInbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        return root
    }
    static func importFiles(_ urls: [URL]) throws -> SharedManifest {
        guard !urls.isEmpty, urls.count <= 10, urls.allSatisfy({ $0.isFileURL }) else { throw ShareFailure.limit }
        let root = try root(), staging = try SharedInbox.makeStaging(root: root)
        defer { try? FileManager.default.removeItem(at: staging) }
        var files: [SharedFile] = []
        var total = 0
        for url in urls {
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let file = try SharedInbox.stageFile(url, name: url.lastPathComponent, mime: mime, in: staging)
            total += file.size
            guard total <= SharedInbox.maxTotal else { throw ShareFailure.limit }
            files.append(file)
        }
        return try SharedInbox.publish(staging, title: String(files[0].name.prefix(120)), notes: "",
            files: files, root: root)
    }
}

/// UIKit provides the Files sheet, file-provider browsing, selection and drag
/// dismissal. No HTML file-input chrome or filesystem paths cross the bridge.
@MainActor
final class DocumentImporter: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
    private var completion: ((Result<SharedManifest?, Error>) -> Void)?
    private var importing = false
    init(completion: @escaping (Result<SharedManifest?, Error>) -> Void) {
        self.completion = completion
        super.init()
        picker.delegate = self
        picker.allowsMultipleSelection = true
        picker.shouldShowFileExtensions = true
        picker.modalPresentationStyle = .pageSheet
    }
    func present(from controller: UIViewController) throws {
        guard UIApplication.shared.applicationState == .active, controller.viewIfLoaded?.window != nil,
              controller.presentedViewController == nil, !controller.isBeingDismissed else {
            throw DeviceFailure.unavailable("Cierra el selector abierto antes de añadir otro archivo.")
        }
        controller.present(picker, animated: true)
        picker.presentationController?.delegate = self
        monitorPresentation()
    }
    private func monitorPresentation() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.completion != nil, !self.importing else { return }
            if self.picker.presentingViewController == nil { self.finish(.success(nil)) }
            else { self.monitorPresentation() }
        }
    }
    private func finish(_ result: Result<SharedManifest?, Error>) {
        guard let callback = completion else { return }
        completion = nil; callback(result)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, !importing, completion != nil else { return }
        importing = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try DocumentImportStore.importFiles(urls) }
            DispatchQueue.main.async { [weak self] in self?.finish(result.map { Optional($0) }) }
        }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if controller === picker, !importing { finish(.success(nil)) }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if !importing { finish(.success(nil)) }
    }
}

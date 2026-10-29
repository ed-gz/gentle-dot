import Foundation
import UIKit

/// The copy is an interrupted recording, not a validated audio document.
/// The picker is the only operation that can export it outside the sandbox.
@MainActor
final class VoiceIncompleteExporter: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private let picker: UIDocumentPickerViewController
    private var completion: ((Result<Bool, Error>) -> Void)?

    init(file: URL, completion: @escaping (Result<Bool, Error>) -> Void) {
        picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        self.completion = completion
        super.init()
        picker.delegate = self
        picker.shouldShowFileExtensions = true
    }

    func present(from controller: UIViewController) throws {
        guard UIApplication.shared.applicationState == .active, controller.viewIfLoaded?.window != nil,
              controller.presentedViewController == nil, !controller.isBeingDismissed else { throw VoiceRecoveryJournalError.busy }
        controller.present(picker, animated: true)
        picker.presentationController?.delegate = self
        monitor()
    }

    private func monitor() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.completion != nil else { return }
            if self.picker.presentingViewController == nil { self.finish(.failure(VoiceRecoveryJournalError.busy)) }
            else { self.monitor() }
        }
    }
    private func finish(_ result: Result<Bool, Error>) {
        guard let callback = completion else { return }
        completion = nil; callback(result)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, urls.count == 1, urls[0].isFileURL else { finish(.failure(VoiceRecoveryJournalError.invalid)); return }
        finish(.success(true))
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { if controller === picker { finish(.success(false)) } }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(.success(false)) }
}

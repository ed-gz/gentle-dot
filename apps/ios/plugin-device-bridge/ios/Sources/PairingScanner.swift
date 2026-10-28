import AVFoundation
import UIKit
import VisionKit

@MainActor protocol PairingScannerSession: AnyObject { func cancel() }

/// Live QR input only. It never opens a URL, pairs a device or stores a credential.
/// The frontend validates the invitation and shows its host before submission.
@available(iOS 16.0, *)
@MainActor
final class PairingScanner: NSObject, PairingScannerSession, DataScannerViewControllerDelegate {
    private var completion: ((Result<String?, Error>) -> Void)?
    private var scanner: DataScannerViewController?
    private var navigation: UINavigationController?
    private var backgroundObserver: NSObjectProtocol?

    init(completion: @escaping (Result<String?, Error>) -> Void) {
        self.completion = completion
        super.init()
    }
    func present(from presenter: UIViewController) {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in self?.cancel() }
        Task { @MainActor [weak self, weak presenter] in
            guard let self = self else { return }
            guard DataScannerViewController.isSupported else {
                self.finish(.failure(DeviceFailure.unavailable("Este iPhone no admite el escáner en vivo. Elige una foto del QR."))); return
            }
            let authorized: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: authorized = true
            case .notDetermined: authorized = await AVCaptureDevice.requestAccess(for: .video)
            default: authorized = false
            }
            guard self.completion != nil else { return }
            guard authorized, DataScannerViewController.isAvailable else {
                self.finish(.failure(DeviceFailure.unavailable("Permite Cámara para Capri en Ajustes del iPhone, o elige una foto del QR."))); return
            }
            // Camera consent briefly leaves the app inactive while its system
            // sheet dismisses. Do not mistake that transition for backgrounding.
            for _ in 0..<20 {
                if UIApplication.shared.applicationState != .inactive || self.completion == nil { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            guard self.completion != nil else { return }
            guard UIApplication.shared.applicationState == .active, let presenter = presenter,
                  presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
                self.finish(.failure(DeviceFailure.unavailable("Vuelve a Capri y cierra el selector abierto antes de escanear."))); return
            }
            let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                qualityLevel: .balanced, recognizesMultipleItems: true, isHighFrameRateTrackingEnabled: false,
                isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
            scanner.delegate = self
            scanner.title = "Vincular laptop"
            scanner.navigationItem.prompt = "Apunta al QR de Gentle Dot"
            scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel,
                target: self, action: #selector(self.cancelTapped))
            let navigation = UINavigationController(rootViewController: scanner)
            navigation.modalPresentationStyle = .fullScreen
            self.scanner = scanner; self.navigation = navigation
            presenter.present(navigation, animated: true) { [weak self] in
                guard let self = self, self.completion != nil else { return }
                do { try scanner.startScanning() }
                catch { self.finish(.failure(DeviceFailure.unavailable("No pude iniciar la cámara. Elige una foto del QR o intenta de nuevo."))) }
            }
        }
    }
    @objc private func cancelTapped() { cancel() }
    func cancel() { finish(.success(nil)) }
    private func finish(_ result: Result<String?, Error>) {
        guard let callback = completion else { return }
        completion = nil
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer); backgroundObserver = nil }
        scanner?.stopScanning(); scanner?.delegate = nil
        if let navigation = navigation, navigation.presentingViewController != nil {
            navigation.dismiss(animated: UIApplication.shared.applicationState == .active) { callback(result) }
        } else { callback(result) }
    }
    private func invitation(_ item: RecognizedItem) -> String? {
        guard case .barcode(let code) = item, let value = code.payloadStringValue, value.utf8.count <= 4096,
              let url = URLComponents(string: value), url.scheme == "gentledot", url.host == "pair" else { return nil }
        return value
    }
    private func consider(_ items: [RecognizedItem]) {
        let values = Set(items.compactMap(invitation))
        if values.count == 1, let value = values.first { finish(.success(value)) }
        else if values.count > 1 { scanner?.navigationItem.prompt = "Toca el QR de la laptop que quieres vincular" }
    }
    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        if let value = invitation(item) { finish(.success(value)) }
    }
    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) { consider(allItems) }
    func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) { consider(allItems) }
    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        finish(.failure(DeviceFailure.unavailable("La cámara dejó de estar disponible. Intenta de nuevo o elige una foto del QR.")))
    }
}

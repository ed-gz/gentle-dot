import UIKit
import UniformTypeIdentifiers

// A real Share Extension: receives local audio/text/files and never sends them to a host.
final class ShareViewController: UIViewController {
    private let titleField = UITextField()
    private let notesField = UITextView()
    private let statusLabel = UILabel()
    private let saveButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var saving = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.055, green: 0.04, blue: 0.085, alpha: 1)
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 12
        let scroll = UIScrollView(); scroll.keyboardDismissMode = .interactive
        scroll.translatesAutoresizingMaskIntoConstraints = false; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll); scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40)
        ])
        func label(_ text: String, style: UIFont.TextStyle = .body) -> UILabel {
            let item = UILabel(); item.text = text; item.font = .preferredFont(forTextStyle: style)
            item.adjustsFontForContentSizeCategory = true; item.numberOfLines = 0; item.textColor = .white
            return item
        }
        let heading = label("CAPRI · Guardar trabajo", style: .title2)
        heading.textColor = UIColor(red: 1, green: 0.30, blue: 0.66, alpha: 1)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(label("El audio y sus archivos se conservarán en este iPhone. Abre Capri para revisar y procesar el trabajo."))
        stack.addArrangedSubview(label("Título", style: .headline))
        titleField.text = "Reunión compartida"; titleField.textColor = .white
        titleField.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        titleField.borderStyle = .roundedRect; titleField.font = .preferredFont(forTextStyle: .body)
        titleField.adjustsFontForContentSizeCategory = true; titleField.accessibilityLabel = "Título del trabajo"
        titleField.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        stack.addArrangedSubview(titleField)
        stack.addArrangedSubview(label("Instrucciones opcionales", style: .headline))
        notesField.font = .preferredFont(forTextStyle: .body); notesField.adjustsFontForContentSizeCategory = true
        notesField.textColor = .white; notesField.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        notesField.accessibilityLabel = "Instrucciones opcionales"; notesField.isScrollEnabled = false
        notesField.heightAnchor.constraint(greaterThanOrEqualToConstant: 100).isActive = true
        stack.addArrangedSubview(notesField)
        statusLabel.font = .preferredFont(forTextStyle: .footnote); statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0; statusLabel.textColor = .white
        statusLabel.text = "Hasta 10 archivos · audio 128 MiB · otros 25 MiB · total 256 MiB"
        stack.addArrangedSubview(statusLabel)
        saveButton.setTitle("Guardar en Capri", for: .normal)
        saveButton.tintColor = UIColor(red: 0.72, green: 1, blue: 0.22, alpha: 1)
        cancelButton.setTitle("Cancelar", for: .normal); cancelButton.tintColor = .white
        for button in [saveButton, cancelButton] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
            stack.addArrangedSubview(button)
        }
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        do { _ = try SharedInbox.root() } catch { statusLabel.text = error.localizedDescription; saveButton.isEnabled = false }
    }
    @objc private func cancel() {
        guard !saving else { return }
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
    @objc private func save() {
        guard !saving else { return }
        let title = (titleField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = notesField.text ?? ""
        guard !title.isEmpty, title.count <= 120, notes.count <= 8000 else { statusLabel.text = "Escribe un título de hasta 120 caracteres e instrucciones de hasta 8000."; return }
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty, providers.count <= 10 else { statusLabel.text = ShareFailure.limit.localizedDescription; return }
        saving = true; saveButton.isEnabled = false; cancelButton.isEnabled = false
        titleField.isEnabled = false; notesField.isEditable = false; view.endEditing(true)
        statusLabel.text = "Copiando al almacenamiento local…"
        Task {
            do {
                let directory = try SharedInbox.makeStaging()
                var files: [SharedFile] = []
                for provider in providers {
                    let file = try await copy(provider, into: directory)
                    guard files.reduce(file.size, { $0 + $1.size }) <= SharedInbox.maxTotal else { throw ShareFailure.limit }
                    files.append(file)
                }
                _ = try SharedInbox.publish(directory, title: title, notes: notes, files: files)
                await MainActor.run {
                    self.statusLabel.text = "Guardado. Abre Capri para continuar."
                    UIAccessibility.post(notification: .announcement, argument: self.statusLabel.text)
                    self.extensionContext?.completeRequest(returningItems: nil)
                }
            } catch {
                let message = "No se completó la importación. La copia parcial se conserva; vuelve a compartir el original si está disponible."
                await MainActor.run {
                    self.statusLabel.text = message; self.saving = false
                    self.saveButton.isEnabled = true; self.cancelButton.isEnabled = true
                    self.titleField.isEnabled = true; self.notesField.isEditable = true
                    UIAccessibility.post(notification: .announcement, argument: message)
                }
            }
        }
    }
    // NSItemProvider often exposes a concrete audio UTI even when its temporary
    // URL has no useful suffix. Preserve that type so Capri recognises a meeting.
    nonisolated private static func fileMetadata(_ provider: NSItemProvider, url: URL, category: UTType) -> (String, String) {
        let suggested = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let suggestedExtension = (suggested as NSString?)?.pathExtension ?? ""
        let fromName = UTType(filenameExtension: suggestedExtension) ?? UTType(filenameExtension: url.pathExtension)
        let registered = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
            .first { $0.conforms(to: category) && $0.preferredMIMEType != nil }
        let concrete = (fromName?.conforms(to: category) == true ? fromName : nil) ?? registered
        let fallback: String
        if category == .audio { fallback = "audio/x-unknown" }
        else if category == .image { fallback = "image/x-unknown" }
        else if category == .pdf { fallback = "application/pdf" }
        else { fallback = "text/plain" }
        let rawMime = concrete?.preferredMIMEType ?? fallback
        let inappropriate = (category == .audio && !rawMime.lowercased().hasPrefix("audio/")) ||
            (category == .image && !rawMime.lowercased().hasPrefix("image/"))
        let mime = rawMime.contains("*") || inappropriate ? fallback : rawMime
        var name = (suggested?.isEmpty == false ? suggested : nil) ?? url.lastPathComponent
        if (name as NSString).pathExtension.isEmpty, !url.pathExtension.isEmpty { name += "." + url.pathExtension }
        return (name, mime)
    }
    private func copy(_ provider: NSItemProvider, into staging: URL) async throws -> SharedFile {
        let types: [UTType] = [.audio, .pdf, .image, .plainText]
        if let type = types.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) }) {
            if type == .plainText {
                return try await withCheckedThrowingContinuation { continuation in
                    provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { value, error in
                        do {
                            if error != nil { throw ShareFailure.invalid }
                            if let url = value as? URL {
                                continuation.resume(returning: try SharedInbox.stageFile(url, name: url.lastPathComponent, mime: "text/plain", in: staging)); return
                            }
                            let data: Data
                            if let string = value as? String { data = Data(string.utf8) }
                            else if let string = value as? NSAttributedString { data = Data(string.string.utf8) }
                            else if let bytes = value as? Data, String(data: bytes, encoding: .utf8) != nil { data = bytes }
                            else { throw ShareFailure.invalid }
                            guard !data.isEmpty, data.count <= SharedInbox.maxFile else { throw ShareFailure.limit }
                            let temporary = staging.appendingPathComponent(".text-\(UUID().uuidString)")
                            defer { try? FileManager.default.removeItem(at: temporary) }
                            try data.write(to: temporary, options: [.atomic, .completeFileProtection])
                            continuation.resume(returning: try SharedInbox.stageFile(temporary, name: "transcripcion.txt", mime: "text/plain", in: staging))
                        } catch { continuation.resume(throwing: error) }
                    }
                }
            }
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                    do {
                        guard error == nil, let url = url else { throw ShareFailure.invalid }
                        // The provider URL is valid only during this callback: copy before returning.
                        let (name, mime) = Self.fileMetadata(provider, url: url, category: type)
                        continuation.resume(returning: try SharedInbox.stageFile(url, name: name, mime: mime, in: staging))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, error in
                    do {
                        guard error == nil, let url = value as? URL, url.isFileURL else { throw ShareFailure.invalid }
                        let type = UTType(filenameExtension: url.pathExtension)
                        let suggested = provider.suggestedName ?? ""
                        let m4a = url.pathExtension.lowercased() == "m4a" || (suggested as NSString).pathExtension.lowercased() == "m4a"
                        guard m4a || (type != nil && types.contains(where: { type!.conforms(to: $0) })) else { throw ShareFailure.invalid }
                        let mime = m4a ? "audio/mp4" : (type?.preferredMIMEType ?? "application/octet-stream")
                        continuation.resume(returning: try SharedInbox.stageFile(url, name: m4a && !suggested.isEmpty ? suggested : url.lastPathComponent,
                            mime: mime, in: staging))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        // Some providers advertise an MPEG-4 container instead of an audio UTI
        // for an .m4a. The suffix classifies metadata only; ffprobe still checks bytes.
        if let name = provider.suggestedName, (name as NSString).pathExtension.lowercased() == "m4a",
           let identifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                    do {
                        guard error == nil, let url = url else { throw ShareFailure.invalid }
                        continuation.resume(returning: try SharedInbox.stageFile(url, name: name, mime: "audio/mp4", in: staging))
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }
        throw ShareFailure.invalid
    }
}

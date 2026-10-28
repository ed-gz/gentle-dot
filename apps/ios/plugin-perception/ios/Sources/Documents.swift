import CryptoKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct DocumentArgs: Decodable {
    let base64: String
    let mimeType: String
    let fileName: String
}
struct DocumentSource: Encodable {
    let name: String
    let mimeType: String
    let size: Int
    let sha256: String
}
struct DocumentBounds: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init(_ rect: CGRect) {
        x = Double(rect.origin.x); y = Double(rect.origin.y)
        width = Double(rect.width); height = Double(rect.height)
    }
}
struct DocumentObservation: Encodable {
    let kind: String
    let text: String
    let confidence: Float
    let bounds: DocumentBounds
    var symbology: String? = nil
}
struct DocumentPage: Encodable {
    let page: Int
    let pixelWidth: Int
    let pixelHeight: Int
    let text: String
    let observations: [DocumentObservation]
}
struct DocumentReply: Encodable {
    var ok = false
    var error: String? = nil
    var message: String? = nil
    var source: DocumentSource? = nil
    var pages: [DocumentPage]? = nil
    var text: String? = nil
    var coordinateSystem: String? = nil
    var engine: String? = nil
    var warnings: [String]? = nil
}
struct PairingCodeReply: Encodable {
    var ok = false
    var error: String? = nil
    var source: DocumentSource? = nil
    var codes: [String]? = nil
    var engine: String? = nil
}
private enum DocumentFailure: Error { case invalid, locked, tooManyPages, cancelled, timeout, textLimit }

/// Cancellation may arrive on the main queue while Vision runs on its worker.
final class DocumentOperation {
    private let lock = NSLock()
    private var cancelled = false
    private var timedOut = false
    private var requests: [VNRequest] = []

    func cancel(timeout: Bool = false) {
        lock.lock(); cancelled = true; timedOut = timeout; let active = requests; lock.unlock()
        for request in active { request.cancel() }
    }
    private func check() throws {
        lock.lock(); let stopped = cancelled; let timeout = timedOut; lock.unlock()
        if stopped { throw timeout ? DocumentFailure.timeout : DocumentFailure.cancelled }
    }
    func finalResult(_ result: DocumentReply) -> DocumentReply {
        do { try check(); return result }
        catch DocumentFailure.timeout { return failure("document_timeout", "La lectura tardó demasiado. Divide el documento.") }
        catch { return failure("cancelled", "Lectura cancelada.") }
    }
    func finalResult(_ result: PairingCodeReply) -> PairingCodeReply {
        do { try check(); return result }
        catch DocumentFailure.timeout { return PairingCodeReply(error: "scan_timeout") }
        catch { return PairingCodeReply(error: "cancelled") }
    }
    private func install(_ next: [VNRequest]) throws {
        lock.lock()
        if cancelled { let timeout = timedOut; lock.unlock(); throw timeout ? DocumentFailure.timeout : DocumentFailure.cancelled }
        requests = next
        lock.unlock()
    }

    /// QR-only local recognition. Payloads are inert strings; the frontend validates the invitation.
    func scanPairingCode(_ args: DocumentArgs) -> PairingCodeReply {
        do {
            try check()
            let maximum = 12 * 1024 * 1024
            guard ["image/png", "image/jpeg", "image/heic", "image/heif", "image/webp", "image/tiff"].contains(args.mimeType),
                  args.base64.utf8.count <= ((maximum + 2) / 3) * 4,
                  let data = Data(base64Encoded: args.base64), !data.isEmpty, data.count <= maximum,
                  !args.fileName.isEmpty, args.fileName.count <= 255,
                  !args.fileName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  let imageSource = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let identifier = CGImageSourceGetType(imageSource) as String?,
                  let mime = UTType(identifier)?.preferredMIMEType,
                  mime == args.mimeType || (["image/heic", "image/heif"].contains(mime) && ["image/heic", "image/heif"].contains(args.mimeType)),
                  CGImageSourceGetCount(imageSource) == 1 else { throw DocumentFailure.invalid }
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400,
                kCGImageSourceShouldCacheImmediately: true]
            guard let image = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, options as CFDictionary) else { throw DocumentFailure.invalid }
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr]
            try install([request])
            try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
            try check()
            let results = request.results ?? []
            guard results.count <= 16 else { return PairingCodeReply(error: "too_many_codes") }
            var codes: [String] = []
            for result in results {
                guard let payload = result.payloadStringValue, !payload.isEmpty else { continue }
                guard payload.utf8.count <= 4096 else { return PairingCodeReply(error: "invalid_code") }
                if !codes.contains(payload) { codes.append(payload) }
            }
            let source = DocumentSource(name: args.fileName, mimeType: args.mimeType, size: data.count,
                sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
            return PairingCodeReply(ok: true, source: source, codes: codes, engine: "apple-vision")
        } catch {
            do { try check() }
            catch DocumentFailure.timeout { return PairingCodeReply(error: "scan_timeout") }
            catch { return PairingCodeReply(error: "cancelled") }
            return PairingCodeReply(error: error is DocumentFailure ? "invalid_image" : "recognition_failed")
        }
    }

    func recognize(_ args: DocumentArgs) -> DocumentReply {
        do {
            try check()
            let maximum = 12 * 1024 * 1024
            guard args.base64.utf8.count <= ((maximum + 2) / 3) * 4,
                  let data = Data(base64Encoded: args.base64), !data.isEmpty, data.count <= maximum,
                  !args.fileName.isEmpty, args.fileName.count <= 255,
                  !args.fileName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw DocumentFailure.invalid }
            let source = DocumentSource(name: args.fileName, mimeType: args.mimeType, size: data.count,
                sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
            var pages: [DocumentPage] = []
            var textCount = 0
            if args.mimeType == "application/pdf" {
                guard let provider = CGDataProvider(data: data as CFData), let pdf = CGPDFDocument(provider) else { throw DocumentFailure.invalid }
                guard !pdf.isEncrypted || pdf.isUnlocked else { throw DocumentFailure.locked }
                guard pdf.numberOfPages > 0, pdf.numberOfPages <= 20 else { throw DocumentFailure.tooManyPages }
                for index in 1...pdf.numberOfPages {
                    try check()
                    let page = try autoreleasepool { () throws -> DocumentPage in
                        guard let sourcePage = pdf.page(at: index), let rendered = render(sourcePage) else { throw DocumentFailure.invalid }
                        return try recognizePage(rendered, index: index)
                    }
                    textCount += page.text.count + (pages.isEmpty ? 0 : 2)
                    guard textCount <= 200_000 else { throw DocumentFailure.textLimit }
                    pages.append(page)
                }
            } else {
                guard let imageSource = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                      let identifier = CGImageSourceGetType(imageSource) as String?,
                      let mime = UTType(identifier)?.preferredMIMEType,
                      mime == args.mimeType || (["image/heic", "image/heif"].contains(mime) && ["image/heic", "image/heif"].contains(args.mimeType)),
                      CGImageSourceGetCount(imageSource) == 1 else { throw DocumentFailure.invalid }
                let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400,
                    kCGImageSourceShouldCacheImmediately: true]
                guard let image = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, options as CFDictionary) else { throw DocumentFailure.invalid }
                let page = try recognizePage(image, index: 1)
                guard page.text.count <= 200_000 else { throw DocumentFailure.textLimit }
                pages.append(page)
            }
            try check()
            return DocumentReply(ok: true, source: source, pages: pages,
                text: pages.map { $0.text }.joined(separator: "\n\n"), coordinateSystem: "normalized-bottom-left",
                engine: "apple-vision", warnings: ["El OCR puede contener errores. Contrasta las observaciones con el archivo original antes de actuar."])
        } catch {
            // A cancelled VNRequest can throw a Vision error; retain our reason.
            do { try check() } catch DocumentFailure.timeout { return failure("document_timeout", "La lectura tardó demasiado. Divide el documento.") }
            catch { return failure("cancelled", "Lectura cancelada.") }
            switch error {
            case DocumentFailure.locked: return failure("pdf_locked", "El PDF está protegido. Importa una copia desbloqueada.")
            case DocumentFailure.tooManyPages: return failure("page_limit", "Importa un PDF de 1 a 20 páginas.")
            case DocumentFailure.textLimit: return failure("text_limit", "El documento supera el límite de lectura. Divídelo en partes.")
            case DocumentFailure.invalid: return failure("invalid_document", "Importa una imagen de una sola página o un PDF válido de hasta 12 MiB.")
            default: return failure("recognition_failed", "No pude leer el documento con Vision. El archivo original se conserva en su origen.")
            }
        }
    }

    private func failure(_ error: String, _ message: String) -> DocumentReply {
        DocumentReply(error: error, message: message)
    }

    private func recognizePage(_ image: CGImage, index: Int) throws -> DocumentPage {
        try check()
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        // Technical identifiers/error codes must not be spelling-corrected.
        text.usesLanguageCorrection = false
        let supported = try text.supportedRecognitionLanguages()
        let desired = ["es-ES", "en-US"].filter { supported.contains($0) }
        if !desired.isEmpty { text.recognitionLanguages = desired }
        let barcodes = VNDetectBarcodesRequest()
        try install([text, barcodes])
        try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([text, barcodes])
        try check()
        let words = text.results ?? []
        let codes = barcodes.results ?? []
        guard words.count + codes.count <= 2_000 else { throw DocumentFailure.textLimit }
        var observations: [DocumentObservation] = words.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return DocumentObservation(kind: "text", text: candidate.string, confidence: candidate.confidence,
                bounds: DocumentBounds(observation.boundingBox))
        }
        observations.append(contentsOf: codes.compactMap { observation in
            guard let payload = observation.payloadStringValue else { return nil }
            return DocumentObservation(kind: "barcode", text: payload, confidence: observation.confidence,
                bounds: DocumentBounds(observation.boundingBox), symbology: observation.symbology.rawValue)
        })
        // Preserve all observation boxes; this ordering is a convenience, not a
        // claim that OCR reconstructs complex tables or multi-column documents.
        observations.sort {
            if $0.bounds.y != $1.bounds.y { return $0.bounds.y > $1.bounds.y }
            return $0.bounds.x < $1.bounds.x
        }
        let combined = observations.map { $0.text }.joined(separator: "\n")
        return DocumentPage(page: index, pixelWidth: image.width, pixelHeight: image.height, text: combined, observations: observations)
    }

    private func render(_ page: CGPDFPage) -> CGImage? {
        let box = page.getBoxRect(.cropBox)
        guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else { return nil }
        let rotated = abs(page.rotationAngle % 180) == 90
        let sourceWidth = rotated ? box.height : box.width
        let sourceHeight = rotated ? box.width : box.height
        let scale = min(2400 / max(sourceWidth, sourceHeight), 3)
        let width = max(1, Int(ceil(sourceWidth * scale)))
        let height = max(1, Int(ceil(sourceHeight * scale)))
        guard width <= 2400, height <= 2400,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let target = CGRect(x: 0, y: 0, width: width, height: height)
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(target)
        context.concatenate(page.getDrawingTransform(.cropBox, rect: target, rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(page)
        return context.makeImage()
    }
}

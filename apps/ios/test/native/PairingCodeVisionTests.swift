// macOS runner: swiftc Documents.swift PairingCodeVisionTests.swift -o /tmp/capri-qr-tests && /tmp/capri-qr-tests
import CoreImage
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

@main
struct PairingCodeVisionTests {
    static func main() throws {
        let payload = "gentledot://pair?url=https%3A%2F%2Flaptop.example.ts.net&code=fixture-code-12345678901234567890&name=Fixture"
        let filter = CIFilter(name: "CIQRCodeGenerator")!
        filter.setValue(Data(payload.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        let qr = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let border = CIImage(color: .white).cropped(to: qr.extent.insetBy(dx: -24, dy: -24))
        let image = CIContext().createCGImage(qr.composited(over: border), from: border.extent)!
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        precondition(CGImageDestinationFinalize(destination))
        let args = DocumentArgs(base64: (data as Data).base64EncodedString(), mimeType: "image/png", fileName: "qr.png")
        let result = DocumentOperation().scanPairingCode(args)
        precondition(result.ok && result.engine == "apple-vision" && result.codes == [payload], "Vision must decode the generated QR exactly")
        precondition(result.source?.size == data.length && result.source?.sha256.count == 64, "Result must identify original bytes")
        let readQR = DocumentOperation().recognize(args)
        precondition(readQR.ok && readQR.pages?.first?.observations.contains(where: { $0.kind == "barcode" && $0.text == payload }) == true,
                     "Document Vision must retain the barcode as evidence")
        let bitmap = CGContext(data: nil, width: 800, height: 220, bitsPerComponent: 8, bytesPerRow: 0,
                               space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        bitmap.setFillColor(CGColor(gray: 1, alpha: 1)); bitmap.fill(CGRect(x: 0, y: 0, width: 800, height: 220))
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 100, nil)
        let text = NSAttributedString(string: "E-503", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
        ])
        bitmap.textPosition = CGPoint(x: 60, y: 70)
        CTLineDraw(CTLineCreateWithAttributedString(text), bitmap)
        let screenshot = NSMutableData()
        let output = CGImageDestinationCreateWithData(screenshot, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(output, bitmap.makeImage()!, nil)
        precondition(CGImageDestinationFinalize(output))
        let imageArgs = DocumentArgs(base64: (screenshot as Data).base64EncodedString(), mimeType: "image/png", fileName: "error.png")
        let readImage = DocumentOperation().recognize(imageArgs)
        precondition(readImage.ok && readImage.pages?.first?.observations.contains(where: { $0.kind == "text" && $0.text.contains("503") }) == true,
                     "Document Vision must recognize the generated error code")
        precondition(readImage.source?.size == screenshot.length && readImage.source?.sha256.count == 64,
                     "OCR evidence must identify the original image")
        let wrongType = DocumentArgs(base64: args.base64, mimeType: "image/jpeg", fileName: "qr.jpg")
        precondition(DocumentOperation().scanPairingCode(wrongType).error == "invalid_image", "Reject MIME mismatch")
        let pdf = DocumentArgs(base64: args.base64, mimeType: "application/pdf", fileName: "qr.pdf")
        precondition(DocumentOperation().scanPairingCode(pdf).error == "invalid_image", "QR entry accepts images only")
        let cancelled = DocumentOperation(); cancelled.cancel()
        precondition(cancelled.scanPairingCode(args).error == "cancelled", "Cancellation must not produce an invitation")
        print("Document and pairing Vision: QR and OCR evidence checks passed")
    }
}

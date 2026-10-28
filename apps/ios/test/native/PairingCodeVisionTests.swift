// macOS runner: swiftc Documents.swift PairingCodeVisionTests.swift -o /tmp/capri-qr-tests && /tmp/capri-qr-tests
import CoreImage
import CoreGraphics
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
        let wrongType = DocumentArgs(base64: args.base64, mimeType: "image/jpeg", fileName: "qr.jpg")
        precondition(DocumentOperation().scanPairingCode(wrongType).error == "invalid_image", "Reject MIME mismatch")
        let pdf = DocumentArgs(base64: args.base64, mimeType: "application/pdf", fileName: "qr.pdf")
        precondition(DocumentOperation().scanPairingCode(pdf).error == "invalid_image", "QR entry accepts images only")
        let cancelled = DocumentOperation(); cancelled.cancel()
        precondition(cancelled.scanPairingCode(args).error == "cancelled", "Cancellation must not produce an invitation")
        print("Pairing QR Vision: 5 checks passed")
    }
}

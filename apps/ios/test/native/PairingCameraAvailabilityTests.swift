import Foundation

@main
struct PairingCameraAvailabilityTests {
    static func main() {
        let denied = pairingCameraIssue(authorized: false, available: false)
        precondition(denied?.contains("Permite Cámara") == true)
        let restricted = pairingCameraIssue(authorized: true, available: false)
        precondition(restricted?.contains("cámara está autorizada") == true)
        precondition(restricted?.contains("restricciones") == true)
        precondition(restricted?.contains("Permite Cámara") == false)
        precondition(pairingCameraIssue(authorized: true, available: true) == nil)
        print("Pairing camera availability: 3 checks passed")
    }
}

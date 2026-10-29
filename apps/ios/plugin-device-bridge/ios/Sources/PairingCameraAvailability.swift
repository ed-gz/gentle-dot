/// Camera authorization and VisionKit availability are separate checks.
func pairingCameraIssue(authorized: Bool, available: Bool) -> String? {
    if !authorized {
        return "Permite Cámara para Capri en Ajustes del iPhone, o elige una foto del QR."
    }
    if !available {
        return "La cámara está autorizada, pero el escáner no está disponible. Revisa las restricciones de Cámara del iPhone o elige una foto del QR."
    }
    return nil
}

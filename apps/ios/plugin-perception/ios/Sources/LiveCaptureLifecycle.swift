import Foundation

/// Mutated under the capture state's lock. A configuration notification from
/// a running engine must invalidate the recording; an intentional stop or an
/// initialization notification must not invent an interruption.
struct LiveCaptureLifecycle {
    private(set) var accepting = false
    private var hardwareMonitor = false

    mutating func begin() { accepting = true; hardwareMonitor = false }
    mutating func enableHardwareMonitor() { hardwareMonitor = true }
    mutating func close() { accepting = false }
    mutating func hardwareChanged() -> Bool {
        guard accepting && hardwareMonitor else { return false }
        accepting = false
        return true
    }
}

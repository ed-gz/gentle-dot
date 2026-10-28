import Foundation

@main
struct LiveCaptureLifecycleTests {
    static func main() {
        var state = LiveCaptureLifecycle()
        precondition(!state.hardwareChanged())
        state.begin()
        precondition(!state.hardwareChanged(), "engine initialization is not an interruption")
        state.enableHardwareMonitor()
        precondition(state.accepting)
        precondition(state.hardwareChanged(), "route change during capture must invalidate the CAF")
        precondition(!state.accepting && !state.hardwareChanged())
        state.begin(); state.enableHardwareMonitor(); state.close()
        precondition(!state.hardwareChanged(), "notification after an intentional stop is ignored")
        print("LiveCaptureLifecycle: route-change and intentional stop passed.")
    }
}

import Foundation

/// Wait for every previously queued buffer before closing a file or ending a
/// stream. Concurrent stop/cancel calls each wait for the same queue boundary.
enum LiveVoiceDrain {
    static func barrier(on queue: DispatchQueue, perform action: @escaping () -> Void) async {
        await withCheckedContinuation { waiter in
            queue.async { action(); waiter.resume() }
        }
    }
}

import BackgroundTasks
import Foundation
import UIKit

/// Extends a single, explicitly requested native model step. It does not run
/// the WebView agent or execute another tool while the app is in the background.
final class ContinuedInferenceLease {
    // Methods and callbacks mutate this state on the main queue.
    // Dynamic registrations have no documented removal API. Bound them per
    // process and use the ordinary UIKit lease when this budget is exhausted.
    private static var registrations = 0
    private static let maximumRegistrations = 32
    private var shortLease: UIBackgroundTaskIdentifier = .invalid
    private var activeTask: AnyObject?
    private var gate = InferenceStartGate()
    private var epoch = InferenceLeaseEpoch()
    private var continuation: CheckedContinuation<Void, Never>?
    private var onExpire: (() -> Void)?

    var holdsRuntime: Bool { shortLease != .invalid || activeTask != nil }

    func begin(onExpire: @escaping () -> Void) {
        finish(success: false)
        let generation = epoch.begin()
        self.onExpire = onExpire
        shortLease = UIApplication.shared.beginBackgroundTask(withName: "Completar paso de Capri") { [weak self] in
            Task { @MainActor in self?.expireShort(generation: generation) }
        }
    }

    /// Runs the model only after the system calls the continued-task handler.
    /// If unsupported, not permitted, refused, or delayed, keep the UIKit lease.
    @MainActor func waitForStart() async {
        guard #available(iOS 26.0, *), UIApplication.shared.applicationState == .active,
              Self.registrations < Self.maximumRegistrations,
              let bundle = Bundle.main.bundleIdentifier,
              let allowed = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String],
              allowed.contains("\(bundle).capri-inference.*") else { return }
        let identifier = "\(bundle).capri-inference.\(UUID().uuidString)"
        await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { (waiter: CheckedContinuation<Void, Never>) in
                guard !Task.isCancelled else { waiter.resume(); return }
                gate.begin(identifier)
                continuation = waiter
                Self.registrations += 1
                let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { [weak self] task in
                    Task { @MainActor in
                        guard let self = self else { task.setTaskCompleted(success: false); return }
                        self.granted(task, identifier: identifier)
                    }
                }
                guard registered else { settlePending(identifier); return }
                let request = BGContinuedProcessingTaskRequest(identifier: identifier,
                    title: "Capri", subtitle: "Paso de análisis local")
                request.strategy = .fail
                do {
                    try BGTaskScheduler.shared.submit(request)
                    // A missing or late launch must not trap the foreground reply.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                        self?.settlePending(identifier)
                    }
                } catch { settlePending(identifier) }
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in self?.settlePending(identifier) }
        })
    }

    @available(iOS 26.0, *)
    private func granted(_ task: BGTask, identifier: String) {
        guard let continued = task as? BGContinuedProcessingTask else {
            settlePending(identifier)
            task.setTaskCompleted(success: false)
            return
        }
        guard gate.consume(identifier) else {
            task.setTaskCompleted(success: false)
            return
        }
        activeTask = continued
        // The response has no true incremental progress API. Report only the
        // completion of this one step; iOS may expire it for lack of progress.
        continued.progress.totalUnitCount = 1
        continued.progress.completedUnitCount = 0
        let generation = epoch.currentIdentifier
        continued.expirationHandler = { [weak self] in
            guard let generation = generation else { return }
            Task { @MainActor in self?.expire(generation: generation) }
        }
        endShortLease()
        let waiter = continuation; continuation = nil; waiter?.resume()
    }

    private func settlePending(_ identifier: String) {
        guard gate.consume(identifier) else { return }
        if #available(iOS 26.0, *) { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier) }
        let waiter = continuation; continuation = nil; waiter?.resume()
    }

    private func expire(generation: UUID) {
        guard epoch.isActive(generation) else { return }
        let action = onExpire
        finish(success: false)
        action?()
    }

    // The short lease may expire just as the scheduler grants the longer one.
    // A callback already queued after that handoff must not cancel the new task.
    private func expireShort(generation: UUID) {
        guard epoch.shouldExpireShort(generation, held: shortLease != .invalid) else { return }
        expire(generation: generation)
    }

    func finish(success: Bool) {
        epoch.end()
        onExpire = nil
        if let identifier = gate.identifier { settlePending(identifier) }
        if #available(iOS 26.0, *), let active = activeTask as? BGContinuedProcessingTask {
            activeTask = nil
            active.expirationHandler = nil
            if success { active.progress.completedUnitCount = 1 }
            active.setTaskCompleted(success: success)
        }
        endShortLease()
    }

    private func endShortLease() {
        let identifier = shortLease
        shortLease = .invalid
        if identifier != .invalid { UIApplication.shared.endBackgroundTask(identifier) }
    }
}

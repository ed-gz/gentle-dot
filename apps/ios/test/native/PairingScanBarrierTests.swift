import Foundation

@main
struct PairingScanBarrierTests {
    @MainActor static func main() async {
        let barrier = PairingScanBarrier()
        let old = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        let current = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"
        let next = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"
        var early: Bool?
        precondition(!barrier.cancel(old.lowercased()) { early = $0 })
        precondition(early == true && !barrier.begin(old))
        precondition(barrier.begin(current))
        var wrong: Bool?
        precondition(!barrier.cancel(old) { wrong = $0 })
        precondition(wrong == true)
        var timedOut: Bool?
        precondition(barrier.cancel(current.lowercased(), timeout: 0.02) { timedOut = $0 })
        precondition(timedOut == nil)
        try? await Task.sleep(nanoseconds: 100_000_000)
        precondition(timedOut == false && !barrier.begin(next))
        var retry: Bool?
        precondition(barrier.cancel(current) { retry = $0 })
        barrier.finish(old)
        precondition(retry == nil)
        barrier.finish(current)
        precondition(retry == true && barrier.begin(next))
        var completed: Bool?
        precondition(barrier.cancel(next) { completed = $0 })
        precondition(completed == nil)
        barrier.finish(next)
        precondition(completed == true)
        print("PairingScanBarrier: early and stale cancellation, delayed finish and timeout passed.")
    }
}

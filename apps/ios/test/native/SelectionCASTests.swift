import Foundation

@main
struct SelectionCASTests {
    static func main() {
        let cas = SelectionCAS()
        var value: String? = "initial"
        let start = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        let guardLock = NSLock()
        var results: [Bool] = []
        group.enter()
        DispatchQueue.global().async {
            let result = cas.compareAndSet(expected: "initial", value: "first", read: {
                start.signal(); release.wait(); return value
            }, write: { value = $0 })
            guardLock.lock(); results.append(result); guardLock.unlock(); group.leave()
        }
        start.wait()
        group.enter()
        DispatchQueue.global().async {
            let result = cas.compareAndSet(expected: "initial", value: "second", read: { value }, write: { value = $0 })
            guardLock.lock(); results.append(result); guardLock.unlock(); group.leave()
        }
        release.signal(); group.wait()
        precondition(results.filter { $0 }.count == 1 && value == "first")
        precondition(!cas.compareAndSet(expected: "initial", value: "late", read: { value }, write: { value = $0 }))
        precondition(value == "first")
        precondition(cas.compareAndSet(expected: "first", value: "second", read: { value }, write: { value = $0 }))
        precondition(value == "second")
        print("SelectionCAS: concurrent and delayed writers passed")
    }
}

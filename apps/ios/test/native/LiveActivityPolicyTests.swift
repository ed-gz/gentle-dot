import Foundation

@main
enum LiveActivityPolicyTests {
    static func main() throws {
        let id = "d3dba896-4b5c-4c1c-98c9-4e60238fe6b9"
        func request(_ origin: String = "iphone", _ phase: String = "working", _ sequence: Int = 1, _ activity: String? = nil) -> LiveActivityRequest {
            LiveActivityRequest(turnId: id, origin: origin, phase: phase, sequence: sequence, id: activity)
        }
        precondition(LiveActivityPolicy.valid(request(), ending: false, requireActivityID: false))
        precondition(LiveActivityPolicy.valid(request("laptop", "attention", 4, "activity-123"), ending: false, requireActivityID: true))
        precondition(LiveActivityPolicy.valid(request("iphone", "finished", 5, "activity-123"), ending: true, requireActivityID: true))
        precondition(!LiveActivityPolicy.valid(request("cloud"), ending: false, requireActivityID: false))
        precondition(!LiveActivityPolicy.valid(request("iphone", "finished"), ending: false, requireActivityID: false))
        precondition(!LiveActivityPolicy.valid(request("iphone", "working", -1), ending: false, requireActivityID: false))
        precondition(!LiveActivityPolicy.valid(request("iphone", "working", 1_000_000_001), ending: false, requireActivityID: false))
        precondition(!LiveActivityPolicy.valid(request("iphone", "working", 0, "../../escape"), ending: false, requireActivityID: true))
        precondition(!LiveActivityPolicy.valid(request("iphone", "working", 0, "activity-123"), ending: false, requireActivityID: false))
        precondition(!LiveActivityPolicy.validID("D3DBA896-4B5C-4C1C-98C9-4E60238FE6B9"))
        precondition(!LiveActivityPolicy.validActivityID(String(repeating: "a", count: 129)))
        precondition(LiveActivityPolicy.canUpdate(previous: 0, next: 1))
        precondition(!LiveActivityPolicy.canUpdate(previous: 1, next: 1))
        precondition(!LiveActivityPolicy.canUpdate(previous: 2, next: 1))
        print("LiveActivityPolicy: 14 checks passed")
    }
}

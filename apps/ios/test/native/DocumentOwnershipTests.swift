import Foundation

@main
struct DocumentOwnershipTests {
    static func main() {
        let old = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        let next = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"
        var owners = DocumentOwnership()
        precondition(!owners.cancel(old.lowercased()))
        precondition(!owners.begin(old))
        precondition(owners.begin(next))
        precondition(!owners.cancel(old))
        precondition(owners.cancel(next.lowercased()))
        owners.finish(old)
        precondition(!owners.begin("CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"))
        owners.finish(next)
        precondition(owners.begin("CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"))
        print("DocumentOwnership: early, late and owner-scoped cancellations passed.")
    }
}

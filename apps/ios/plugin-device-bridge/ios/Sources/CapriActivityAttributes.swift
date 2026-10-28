#if os(iOS)
import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct CapriActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let phase: String
        let sequence: Int
        let observedAt: Date
    }
    let turnId: String
    let origin: String
}
#endif

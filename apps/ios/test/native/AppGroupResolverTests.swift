import Foundation

private struct TestFailure: Error { let message: String }
private func expect(_ value: Bool, _ message: String) throws { if !value { throw TestFailure(message: message) } }
private func rejects(_ message: String, _ action: () throws -> Void) throws {
    do { try action() } catch { return }
    throw TestFailure(message: "Accepted invalid input: " + message)
}
private func word(_ value: UInt32, big: Bool = false) -> Data {
    let shifts = big ? [24, 16, 8, 0] : [0, 8, 16, 24]
    return Data(shifts.map { UInt8((value >> $0) & 255) })
}
private func replaceWord(_ data: inout Data, _ offset: Int, _ value: UInt32, big: Bool = false) { data.replaceSubrange(offset..<offset + 4, with: word(value, big: big)) }
private func signature(_ entries: [(UInt32, Data)]) -> Data {
    var index = Data(), content = Data(), offset = 12 + entries.count * 8
    for (slot, blob) in entries {
        index.append(word(slot, big: true)); index.append(word(UInt32(offset), big: true))
        content.append(blob); offset += blob.count
    }
    return word(0xfade0cc0, big: true) + word(UInt32(offset), big: true) + word(UInt32(entries.count), big: true) + index + content
}
private func entitlement(_ groups: Any) throws -> Data {
    let xml = try PropertyListSerialization.data(fromPropertyList: ["com.apple.security.application-groups": groups], format: .xml, options: 0)
    return word(0xfade7171, big: true) + word(UInt32(xml.count + 8), big: true) + xml
}
private func macho(_ signature: Data) -> Data {
    // One LC_CODE_SIGNATURE with a 16-byte gap before the linkedit payload.
    let header = word(0xfeedfacf) + word(0x0100000c) + word(0) + word(2) + word(1) + word(16) + word(0) + word(0)
    let command = word(0x1d) + word(16) + word(64) + word(UInt32(signature.count))
    return header + command + Data(repeating: 0, count: 16) + signature
}

@main
private struct AppGroupResolverTests {
    static func main() throws {
        let configured = "group.dev.gentledot.capri", adjusted = "group.dev.gentledot.capri.ABC123XYZ9"
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("capri-app-group-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let executable = temporary.appendingPathComponent("Capri")
        let xml = try entitlement([adjusted, "group.unrelated.service"])
        let signed = signature([(5, xml)]), valid = macho(signed)
        func read(_ data: Data) throws -> [String] { try data.write(to: executable); return try AppGroupResolver.signedGroups(executable: executable) }

        try expect(try read(valid) == [adjusted, "group.unrelated.service"], "thin arm64 signature parsing")
        try expect(try AppGroupResolver.groups(inSignature: signed) == [adjusted, "group.unrelated.service"], "big-endian signature parsing")
        try rejects("truncated Mach-O header") { _ = try read(Data(valid.prefix(12))) }
        var modified = valid; replaceWord(&modified, 0, 0xcffaedfe)
        try rejects("wrong Mach-O endianness") { _ = try read(modified) }
        modified = valid; replaceWord(&modified, 16, UInt32.max)
        try rejects("unbounded command count") { _ = try read(modified) }
        modified = valid; replaceWord(&modified, 20, UInt32.max)
        try rejects("unbounded command allocation") { _ = try read(modified) }
        modified = valid; replaceWord(&modified, 36, 0)
        try rejects("zero-length load command") { _ = try read(modified) }
        modified = valid; replaceWord(&modified, 40, UInt32.max)
        try rejects("signature outside executable") { _ = try read(modified) }
        modified = valid; replaceWord(&modified, 44, UInt32.max)
        try rejects("unbounded signature allocation") { _ = try read(modified) }
        modified = valid; replaceWord(&modified, 32, 0x19)
        try rejects("unsigned executable") { _ = try read(modified) }
        var malformed = signed; replaceWord(&malformed, 16, 12, big: true)
        try rejects("signature slot overlaps index table") { _ = try AppGroupResolver.groups(inSignature: malformed) }
        malformed = signed; replaceWord(&malformed, 24, UInt32.max, big: true)
        try rejects("XML blob outside signature") { _ = try AppGroupResolver.groups(inSignature: malformed) }
        let other = word(0xfade0c02, big: true) + word(8, big: true)
        malformed = signature([(0, other), (5, xml)])
        replaceWord(&malformed, 32, UInt32(other.count + xml.count), big: true)
        try rejects("non-XML blob overlaps the XML entitlement") { _ = try AppGroupResolver.groups(inSignature: malformed) }
        malformed = signature([(0, other), (1, other), (5, xml)])
        replaceWord(&malformed, 24, 36, big: true)
        try rejects("non-XML entries alias the same blob") { _ = try AppGroupResolver.groups(inSignature: malformed) }
        try rejects("duplicate XML entitlement slots") { _ = try AppGroupResolver.groups(inSignature: signature([(5, xml), (5, xml)])) }
        try rejects("DER-only signature is not guessed") { _ = try AppGroupResolver.groups(inSignature: signature([(7, word(0xfade7172, big: true) + word(8, big: true))])) }
        try rejects("malformed group value") { _ = try AppGroupResolver.groups(inSignature: signature([(5, try entitlement("not-an-array"))])) }
        let link = temporary.appendingPathComponent("link")
        try valid.write(to: executable); try FileManager.default.createSymbolicLink(at: link, withDestinationURL: executable)
        try rejects("executable symlink") { _ = try AppGroupResolver.signedGroups(executable: link) }

        let candidates = try AppGroupResolver.candidates(configured: configured, signedGroups: [adjusted, adjusted, configured,
            "group.foreign.dev.gentledot.capri", configured + ".abc123xyz9", configured + ".ABC123XYZ9.extra", configured + "evil"])
        try expect(candidates == [configured, adjusted], "exact original or one signed team suffix, deduplicated")
        var requested: [String] = []
        let destination = temporary.appendingPathComponent("authorized")
        let resolved = try AppGroupResolver.resolve(configured: configured, signedGroups: [adjusted, "group.unrelated.service"]) { group in
            requested.append(group); return group == adjusted ? destination : nil
        }
        try expect(resolved == destination && requested == [adjusted], "iOS authorization boundary only receives matched signed candidates")
        try rejects("an XML claim is insufficient without OS access") { _ = try AppGroupResolver.resolve(configured: configured, signedGroups: [adjusted]) { _ in nil } }
        try rejects("multiple authorized groups are ambiguous") { _ = try AppGroupResolver.resolve(configured: configured, signedGroups: [configured, adjusted]) { _ in destination } }
        try rejects("invalid configured group") { _ = try AppGroupResolver.candidates(configured: "bad/group", signedGroups: [adjusted]) }
        print("AppGroupResolver: 23 native fixture checks passed")
    }
}

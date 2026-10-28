import Foundation

enum AppGroupResolutionError: Error {
    case invalidSignature, unsupportedSignature, invalidConfiguration, unavailableContainer, ambiguousGroup
}

/// Reads candidates from this process's own signed executable, using the public
/// Mach-O/code-signing formats. It does not grant access: FileManager asks iOS to
/// confirm each candidate's entitlement. No private SecTask APIs or profile guesses.
enum AppGroupResolver {
    private static let maximumCommands = 1024 * 1024
    private static let maximumSignature = 4 * 1024 * 1024

    private static func word(_ data: Data, _ offset: Int, bigEndian: Bool = false) throws -> UInt32 {
        guard offset >= 0, offset <= data.count - 4 else { throw AppGroupResolutionError.invalidSignature }
        let bytes = (0..<4).map { UInt32(data[offset + $0]) }
        return bigEndian ? (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3])
            : (bytes[3] << 24 | bytes[2] << 16 | bytes[1] << 8 | bytes[0])
    }
    private static func read(_ handle: FileHandle, offset: Int, count: Int, fileSize: Int) throws -> Data {
        guard offset >= 0, count >= 0, count <= maximumSignature, offset <= fileSize, count <= fileSize - offset else { throw AppGroupResolutionError.invalidSignature }
        try handle.seek(toOffset: UInt64(offset))
        guard let data = try handle.read(upToCount: count), data.count == count else { throw AppGroupResolutionError.invalidSignature }
        return data
    }
    static func signedGroups(executable: URL) throws -> [String] {
        let attributes = try executable.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
              let fileSize = attributes.fileSize, fileSize >= 32 else { throw AppGroupResolutionError.invalidSignature }
        let handle = try FileHandle(forReadingFrom: executable); defer { try? handle.close() }
        let header = try read(handle, offset: 0, count: 32, fileSize: fileSize)
        // Capri's installed iPhone executable is thin arm64 Mach-O, little endian.
        guard try word(header, 0) == 0xfeedfacf, try word(header, 4) == 0x0100000c else { throw AppGroupResolutionError.unsupportedSignature }
        let count = Int(try word(header, 16)), size = Int(try word(header, 20))
        guard count > 0, count <= 4096, size >= count * 8, size <= maximumCommands else { throw AppGroupResolutionError.invalidSignature }
        let commands = try read(handle, offset: 32, count: size, fileSize: fileSize)
        var position = 0, signature: (offset: Int, size: Int)?
        for _ in 0..<count {
            let command = try word(commands, position), length = Int(try word(commands, position + 4))
            guard length >= 8, length % 8 == 0, position <= size, length <= size - position else { throw AppGroupResolutionError.invalidSignature }
            if command == 0x1d { // LC_CODE_SIGNATURE / linkedit_data_command
                guard length == 16, signature == nil else { throw AppGroupResolutionError.invalidSignature }
                let offset = Int(try word(commands, position + 8)), signatureSize = Int(try word(commands, position + 12))
                guard offset >= 32 + size, signatureSize >= 12 else { throw AppGroupResolutionError.invalidSignature }
                signature = (offset, signatureSize)
            }
            position += length
        }
        guard position == size else { throw AppGroupResolutionError.invalidSignature }
        guard let signature = signature else { throw AppGroupResolutionError.unsupportedSignature }
        let blob = try read(handle, offset: signature.offset, count: signature.size, fileSize: fileSize)
        return try groups(inSignature: blob)
    }
    static func groups(inSignature blob: Data) throws -> [String] {
        guard blob.count <= maximumSignature, try word(blob, 0, bigEndian: true) == 0xfade0cc0 else { throw AppGroupResolutionError.invalidSignature }
        let size = Int(try word(blob, 4, bigEndian: true)), count = Int(try word(blob, 8, bigEndian: true))
        guard count > 0, count <= 128, size >= 12 + count * 8, size <= blob.count else { throw AppGroupResolutionError.invalidSignature }
        var xml: Data?
        var ranges: [Range<Int>] = []
        for index in 0..<count {
            let kind = try word(blob, 12 + index * 8, bigEndian: true)
            let offset = Int(try word(blob, 16 + index * 8, bigEndian: true))
            guard offset >= 12 + count * 8, offset <= size - 8 else { throw AppGroupResolutionError.invalidSignature }
            let magic = try word(blob, offset, bigEndian: true), length = Int(try word(blob, offset + 4, bigEndian: true))
            guard length >= 8, length <= size - offset else { throw AppGroupResolutionError.invalidSignature }
            let range = offset ..< offset + length
            guard !ranges.contains(where: { $0.overlaps(range) }) else { throw AppGroupResolutionError.invalidSignature }
            ranges.append(range)
            if kind == 5 { // CSSLOT_ENTITLEMENTS; XML plist in CSMAGIC_EMBEDDED_ENTITLEMENTS.
                guard magic == 0xfade7171, xml == nil, length <= 1024 * 1024 else { throw AppGroupResolutionError.invalidSignature }
                xml = blob.subdata(in: offset + 8 ..< offset + length)
            }
        }
        // DER-only signing needs an explicit future parser; never guess a group.
        guard let xml = xml else { throw AppGroupResolutionError.unsupportedSignature }
        guard let dictionary = try PropertyListSerialization.propertyList(from: xml, options: [], format: nil) as? [String: Any],
              let groups = dictionary["com.apple.security.application-groups"] as? [String], groups.count <= 64,
              groups.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else { throw AppGroupResolutionError.invalidSignature }
        return groups
    }
    static func candidates(configured: String, signedGroups: [String]) throws -> [String] {
        guard configured.range(of: "^group\\.[A-Za-z0-9.-]{3,200}$", options: .regularExpression) != nil else { throw AppGroupResolutionError.invalidConfiguration }
        let prefix = configured + "."
        return Array(Set(signedGroups.filter { group in
            if group == configured { return true }
            guard group.hasPrefix(prefix) else { return false }
            let suffix = String(group.dropFirst(prefix.count))
            return suffix.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
        })).sorted()
    }
    static func resolve(configured: String, signedGroups: [String], container: (String) -> URL?) throws -> URL {
        let candidates = try candidates(configured: configured, signedGroups: signedGroups)
        let authorized = candidates.compactMap(container)
        guard !authorized.isEmpty else { throw AppGroupResolutionError.unavailableContainer }
        guard authorized.count == 1 else { throw AppGroupResolutionError.ambiguousGroup }
        return authorized[0]
    }
    static func container(configured: String, bundle: Bundle = .main) throws -> URL {
        guard let executable = bundle.executableURL else { throw AppGroupResolutionError.unavailableContainer }
        return try resolve(configured: configured, signedGroups: signedGroups(executable: executable)) {
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)
        }
    }
}

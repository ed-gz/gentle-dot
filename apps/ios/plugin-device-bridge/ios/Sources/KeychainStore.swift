import Foundation
import Security

enum DeviceFailure: Error {
    case invalid(String)
    case unavailable(String)
    case storage
    case network
    case oversized
    case cancelled
}

enum KeychainStore {
    static let scopes: Set<String> = ["daemon-pairing", "daemon-manual", "external-connections"]
    static let selectionAccount = "capri.selected-connection.v1"
    private static let selectionCAS = SelectionCAS()
    static func compareSelection(_ expected: String?, _ value: String) throws -> Bool {
        try selectionCAS.compareAndSet(expected: expected, value: value,
            read: { try get("daemon-manual", selectionAccount) },
            write: { try set("daemon-manual", selectionAccount, $0) })
    }
    static func query(_ scope: String, _ account: String) throws -> [String: Any] {
        guard scopes.contains(scope), !account.isEmpty, account.utf8.count <= 2048,
              !account.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw DeviceFailure.invalid("Identificador de credencial inválido.")
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "dev.gentledot.capri.\(scope)",
                kSecAttrAccount as String: account,
                kSecAttrSynchronizable as String: false]
    }
    static func get(_ scope: String, _ account: String) throws -> String? {
        var parameters = try query(scope, account)
        parameters[kSecReturnData as String] = true
        parameters[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(parameters as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data,
              data.count <= 16 * 1024, let text = String(data: data, encoding: .utf8) else {
            throw DeviceFailure.storage
        }
        return text
    }
    static func set(_ scope: String, _ account: String, _ value: String) throws {
        let data = Data(value.utf8)
        guard !data.isEmpty, data.count <= 16 * 1024 else { throw DeviceFailure.oversized }
        let parameters = try query(scope, account)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(parameters as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let status = SecItemAdd(parameters.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard status == errSecSuccess else { throw DeviceFailure.storage }
        } else if updated != errSecSuccess { throw DeviceFailure.storage }
    }
    static func delete(_ scope: String, _ account: String) throws {
        let status = SecItemDelete(try query(scope, account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DeviceFailure.storage }
    }
}

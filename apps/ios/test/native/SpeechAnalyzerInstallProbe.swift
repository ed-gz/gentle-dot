import CryptoKit
import Darwin
import Foundation
import Speech

// The probe consumes only generated speech. Do not print descriptions, paths,
// userInfo values or arbitrary strings from a system error.
private func diagnosticIdentifier(_ value: String, allowed: Set<String>) -> String {
    let safe = !value.isEmpty && value.utf8.count <= 100 && value.utf8.allSatisfy {
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 46 || $0 == 95
    }
    if safe && allowed.contains(value) { return value }
    let digest = SHA256.hash(data: Data(value.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    return "other-sha256-\(digest)"
}
func errorIdentity(_ error: Error) -> String {
    let native = error as NSError
    let domain = diagnosticIdentifier(native.domain, allowed: ["NSOSStatusErrorDomain", "NSCocoaErrorDomain", "AVFoundationErrorDomain", "SFSpeechErrorDomain", "kAFAssistantErrorDomain", "Swift.CancellationError"])
    let type = diagnosticIdentifier(String(reflecting: Swift.type(of: error)), allowed: ["Swift.CancellationError", "Foundation.NSError", "Foundation._GenericObjCError", "Speech.SpeechError"])
    let code = (-999_999...999_999).contains(native.code) ? String(native.code) : "out-of-range"
    let cancelled = error is CancellationError
    return "domain=\(domain) type=\(type) code=\(code) cancelled=\(cancelled)"
}

// Explicit, isolated macOS probe. It never requests a microphone and never
// builds an IPA. A system download may continue after failure or termination.
@available(macOS 26.0, *)
private func probe() async -> Int32 {
    let noPreviewOnly = ProcessInfo.processInfo.environment["CAPRI_NO_PREVIEW_SYNTHETIC_ONLY"] == "1"
    let requested = Locale(identifier: "es-MX")
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: requested),
          locale.identifier.lowercased().replacingOccurrences(of: "_", with: "-") == "es-mx" else {
        print("SKIP: exact es-MX DictationTranscriber is unavailable; no assets requested and no transcription run.")
        return noPreviewOnly ? 1 : 0
    }
    let final = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    let preview = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    let modules: [any SpeechModule] = noPreviewOnly ? [final] : [final, preview]
    let status = await AssetInventory.status(forModules: modules)
    guard status == .installed || status == .supported || status == .downloading else {
        print("SKIP: exact es-MX module configuration is unsupported or unknown; no assets requested.")
        return noPreviewOnly ? 1 : 0
    }
    let canonical: (Locale) -> String = { $0.identifier.lowercased().replacingOccurrences(of: "_", with: "-") }
    let before = Set((await AssetInventory.reservedLocales).map(canonical))
    var reservationAdded: Bool?
    var stage = "reserve"
    var assetsReady = false
    var exitCode: Int32 = 1
    do {
        print("INSTALL: requesting only es-MX DictationTranscriber assets on this ephemeral runner.")
        // false means the system already had this locale reservation. Its
        // reported identifier may be a variant, so preserve prior entries.
        reservationAdded = try await AssetInventory.reserve(locale: locale)
        stage = "asset-request"
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            stage = "asset-download"
            try await request.downloadAndInstall()
        }
        stage = "asset-verification"
        guard await AssetInventory.status(forModules: modules) == .installed else { throw InstallProbeError.notInstalled }
        assetsReady = true
        print("PASS: es-MX DictationTranscriber assets installed; beginning synthetic audio probe.")
        let result = try await run(selected: .dictation(final, preview)) { phase in
            stage = phase
            print("STAGE: \(phase)")
        }
        print(result)
        // A skipped synthesis or unsupported analyzer is never a transcript pass.
        if result.hasPrefix("PASS: real DictationTranscriber") {
            stage = "captured-formats"
            try await runCaptureFormatProbe(locale: locale)
            if noPreviewOnly {
                print("SKIP: live preview buffer comparison is outside this no-preview gate.")
            } else {
                stage = "preview-buffers"
                try await runPreviewBufferProbe(locale: locale)
            }
            exitCode = 0
        } else if result.hasPrefix("SKIP:") { exitCode = noPreviewOnly ? 1 : 0 }
        else { print("FAIL: no real synthetic transcript was confirmed.") }
    } catch {
        // Only fixed phase names, known domains and bounded codes leave the
        // probe. Never print NSError descriptions, paths or audio contents.
        let reason = (error as? ProbeError)?.rawValue ?? (error is InstallProbeError ? "assets-not-installed" : "system-error")
        print("FAIL: stage=\(stage) \(errorIdentity(error)) reason=\(reason); no transcript confirmed.")
        let native = error as NSError
        if let underlying = native.userInfo[NSUnderlyingErrorKey] as? Error {
            print("CAUSE: \(errorIdentity(underlying))")
        }
        if assetsReady { await runReferenceMatrix(locale: locale) }
    }
    let current = await AssetInventory.reservedLocales
    if reservationAdded == true {
        let added = current.filter { !before.contains(canonical($0)) }
        if added.count == 1, let exactAddition = added.first, canonical(exactAddition) == canonical(locale) {
            let released = await AssetInventory.release(reservedLocale: exactAddition)
            print(released ? "CLEANUP: locale reservation released; Apple controls asset removal." : "CLEANUP: locale release was not confirmed; Apple controls asset removal.")
        } else {
            print("CLEANUP: new locale reservation could not be uniquely identified; release was not confirmed.")
        }
    } else {
        print(reservationAdded == false ? "CLEANUP: preserved the pre-existing locale reservation." : "CLEANUP: reservation outcome was not confirmed.")
    }
    return exitCode
}

private enum InstallProbeError: Error { case notInstalled }
@main struct SpeechAnalyzerInstallProbe {
    static func main() async {
        setbuf(stdout, nil); setbuf(stderr, nil)
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--preview-buffer-child" {
            if #available(macOS 26.0, *) { exit(await runPreviewBufferChild(arguments: arguments)) }
            print("PREVIEW SKIP: macOS 26 required."); exit(2)
        }
        if arguments == ["--diagnostics-self-test"] {
            let unknown = "com.apple.private-token"
            let output = diagnosticIdentifier(unknown, allowed: ["SFSpeechErrorDomain"])
            let known = diagnosticIdentifier("SFSpeechErrorDomain", allowed: ["SFSpeechErrorDomain"])
            let error = NSError(domain: unknown, code: 12, userInfo: [NSLocalizedDescriptionKey: "/private/sensitive-audio"])
            let rendered = errorIdentity(error)
            guard output.hasPrefix("other-sha256-"), !output.contains(unknown), known == "SFSpeechErrorDomain",
                  !rendered.contains(unknown), !rendered.contains("/private/sensitive-audio"), rendered.contains("code=12") else {
                print("FAIL: diagnostic redaction self-test failed; no assets requested."); exit(1)
            }
            print("PASS: diagnostic redaction self-test; no assets requested."); return
        }
        if #available(macOS 26.0, *) { exit(await probe()) }
        print("SKIP: macOS 26 is required; no assets requested and no transcription run.")
    }
}

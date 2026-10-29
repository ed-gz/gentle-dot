import Darwin
import Foundation
import Speech

// Explicit, isolated macOS probe. It never requests a microphone and never
// builds an IPA. A system download may continue after failure or termination.
@available(macOS 26.0, *)
private func probe() async -> Int32 {
    let requested = Locale(identifier: "es-MX")
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: requested),
          locale.identifier.lowercased().replacingOccurrences(of: "_", with: "-") == "es-mx" else {
        print("SKIP: exact es-MX DictationTranscriber is unavailable; no assets requested and no transcription run.")
        return 0
    }
    let final = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    let preview = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    let modules: [any SpeechModule] = [final, preview]
    let status = await AssetInventory.status(forModules: modules)
    guard status == .installed || status == .supported || status == .downloading else {
        print("SKIP: exact es-MX module configuration is unsupported or unknown; no assets requested.")
        return 0
    }
    let canonical: (Locale) -> String = { $0.identifier.lowercased().replacingOccurrences(of: "_", with: "-") }
    let before = Set((await AssetInventory.reservedLocales).map(canonical))
    var reservationAdded: Bool?
    var exitCode: Int32 = 1
    do {
        print("INSTALL: requesting only es-MX DictationTranscriber assets on this ephemeral runner.")
        // false means the system already had this locale reservation. Its
        // reported identifier may be a variant, so preserve prior entries.
        reservationAdded = try await AssetInventory.reserve(locale: locale)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            try await request.downloadAndInstall()
        }
        guard await AssetInventory.status(forModules: modules) == .installed else { throw InstallProbeError.notInstalled }
        print("PASS: es-MX DictationTranscriber assets installed; beginning synthetic audio probe.")
        let result = try await run(selected: .dictation(final, preview))
        print(result)
        // A skipped synthesis or unsupported analyzer is never a transcript pass.
        if result.hasPrefix("PASS: real DictationTranscriber") || result.hasPrefix("SKIP:") { exitCode = 0 }
        else { print("FAIL: no real synthetic transcript was confirmed.") }
    } catch {
        print("FAIL: installation or synthetic transcription did not complete; no transcript was confirmed.")
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
        if #available(macOS 26.0, *) { exit(await probe()) }
        print("SKIP: macOS 26 is required; no assets requested and no transcription run.")
    }
}

import AVFoundation
import Foundation

/// MPEG-4 is an ambiguous container. Inspect the staged bytes before
/// publishing them as a meeting recording, without altering the source copy.
enum SharedMediaInspection {
    static func requireAudioOnly(file: SharedFile, in staging: URL) async throws {
        let source = staging.appendingPathComponent("\(file.id).blob")
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard SharedInbox.validID(file.id), values.isRegularFile == true,
              values.isSymbolicLink != true, values.fileSize == file.size else { throw ShareFailure.integrity }

        // AVURLAsset may use the suffix when choosing a parser. A hard link in
        // the same private staging directory provides a temporary .m4a name
        // without copying or mutating the preserved .blob.
        let alias = staging.appendingPathComponent(".inspect-\(UUID().uuidString.lowercased()).m4a")
        do { try FileManager.default.linkItem(at: source, to: alias) }
        catch { throw ShareFailure.integrity }
        defer { try? FileManager.default.removeItem(at: alias) }
        do {
            let asset = AVURLAsset(url: alias)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            let video = try await asset.loadTracks(withMediaType: .video)
            guard !audio.isEmpty, video.isEmpty else { throw ShareFailure.unsupportedMedia }
            let after = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard after.isRegularFile == true, after.isSymbolicLink != true, after.fileSize == file.size else { throw ShareFailure.integrity }
        } catch let failure as ShareFailure {
            throw failure
        } catch {
            throw ShareFailure.unsupportedMedia
        }
    }
}

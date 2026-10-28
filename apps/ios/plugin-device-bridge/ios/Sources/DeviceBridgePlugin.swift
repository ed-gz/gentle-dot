import Foundation
import Tauri
import UIKit
import WebKit
import AuthenticationServices
import Security
import CryptoKit

struct PairedConnection: Codable {
    let url: String
    let token: String
    let deviceId: String
    let name: String
}
private struct BridgeReply: Encodable {
    var ok = true
    var error: String? = nil
    var message: String? = nil
    var value: String? = nil
    var persisted: Bool? = nil
    var status: Int? = nil
    var body: String? = nil
    var headers: [String: String]? = nil
    var callbackUrl: String? = nil
    var data: String? = nil
    var hex: String? = nil
    var id: String? = nil
    var connection: PairedConnection? = nil
    var items: [SharedManifest]? = nil
    var schemes: [String]? = nil
    var written: Int? = nil
    var exported: Bool? = nil
    var cancelled: Bool? = nil
}
private struct SecretInput: Decodable { let scope: String; let account: String; let value: String? }
private struct PairInput: Decodable { let origin: String; let code: String; let deviceName: String }
private struct UnpairInput: Decodable { let origin: String; let token: String? }
private struct OAuthInput: Decodable { let authorizationUrl: String; let callbackScheme: String }
private struct ReadInput: Decodable { let id: String; let fileId: String; let offset: Int; let length: Int }
private struct IDInput: Decodable { let id: String }
private struct RandomInput: Decodable { let length: Int }
private struct HashInput: Decodable { let data: String }
private struct HashUpdateInput: Decodable { let id: String; let data: String }
private struct URLInput: Decodable { let url: String }

final class DeviceBridgePlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
    private weak var webview: WKWebView?
    private var authSession: ASWebAuthenticationSession?
    private var authInvoke: Invoke?
    private let hashes = StreamingHash()
    private let exports = DocumentExportStore()
    private var documentExporter: DocumentExporter?

    @objc override func load(webview: WKWebView) { self.webview = webview }
    private func fail(_ invoke: Invoke, _ error: Error) {
        var reply = BridgeReply(ok: false)
        switch error {
        case DeviceFailure.invalid(let message): reply.error = "invalid_request"; reply.message = message
        case DeviceFailure.unavailable(let message): reply.error = "unavailable"; reply.message = message
        case DeviceFailure.storage: reply.error = "keychain_unavailable"; reply.message = "No se pudo acceder al Llavero. Desbloquea el iPhone y vuelve a intentar."
        case DeviceFailure.oversized: reply.error = "size_limit"; reply.message = "El contenido supera el límite permitido."
        case DeviceFailure.cancelled: reply.error = "cancelled"; reply.message = "Autorización cancelada."
        case let error as ShareFailure: reply.error = "share_unavailable"; reply.message = error.localizedDescription
        default: reply.error = "request_failed"; reply.message = "La operación no se completó. Revisa la conexión y vuelve a intentar."
        }
        invoke.resolve(reply)
    }
    private func work(_ invoke: Invoke, _ body: @escaping () throws -> BridgeReply) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { invoke.resolve(try body()) } catch { self.fail(invoke, error) }
        }
    }
    @objc func secretGet(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(SecretInput.self); return BridgeReply(value: try KeychainStore.get(args.scope, args.account)) }
    }
    @objc func secretSet(_ invoke: Invoke) {
        work(invoke) {
            let args = try invoke.parseArgs(SecretInput.self)
            guard let value = args.value else { throw DeviceFailure.invalid("Falta la credencial.") }
            try KeychainStore.set(args.scope, args.account, value)
            return BridgeReply(persisted: true)
        }
    }
    @objc func secretDelete(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(SecretInput.self); try KeychainStore.delete(args.scope, args.account); return BridgeReply() }
    }
    @objc func httpsRequest(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(HTTPInput.self)
            BoundedHTTP.run(args) { result in
                switch result {
                case .success(let response): invoke.resolve(BridgeReply(status: response.status, body: response.body, headers: response.headers))
                case .failure(let error): self.fail(invoke, error)
                }
            }
        } catch { fail(invoke, error) }
    }
    private static func privateOrigin(_ input: String) throws -> String {
        guard let url = URLComponents(string: input), url.scheme == "https", let host = url.host,
              host.range(of: "^[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\.ts\\.net$", options: .regularExpression) != nil,
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw DeviceFailure.invalid("El enlace requiere el origen HTTPS privado de Tailscale.") }
        return "https://\(host)"
    }
    @objc func pairDevice(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(PairInput.self)
            let origin = try Self.privateOrigin(args.origin)
            guard args.code.range(of: "^[A-Za-z0-9_-]{20,100}$", options: .regularExpression) != nil,
                  !args.deviceName.isEmpty, args.deviceName.count <= 80,
                  !args.deviceName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw DeviceFailure.invalid("Invitación inválida.") }
            let data = try JSONSerialization.data(withJSONObject: ["code": args.code, "deviceName": args.deviceName])
            let request = HTTPInput(url: origin + "/api/mobile/pair", method: "POST", headers: ["Content-Type": "application/json"], body: String(data: data, encoding: .utf8))
            BoundedHTTP.run(request, timeout: 150) { result in
                do {
                    let response = try result.get()
                    guard response.status == 200 else {
                        // Do not expose a reflected response body containing the pairing code.
                        var code = "pairing_failed"
                        if let data = response.body.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           json["code"] as? String == "PAIRING_IN_PROGRESS" { code = "PAIRING_IN_PROGRESS" }
                        invoke.resolve(BridgeReply(ok: false, error: code, status: response.status)); return
                    }
                    guard let data = response.body.data(using: .utf8), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let token = json["token"] as? String,
                          token.range(of: "^[A-Za-z0-9_-]{32,1024}$", options: .regularExpression) != nil,
                          let deviceId = json["deviceId"] as? String, !deviceId.isEmpty, deviceId.count <= 128 else { throw DeviceFailure.network }
                    let connection = PairedConnection(url: origin.replacingOccurrences(of: "https://", with: "wss://") + "/ws", token: token, deviceId: deviceId, name: args.deviceName)
                    let value = String(data: try JSONEncoder().encode(connection), encoding: .utf8)!
                    do {
                        try KeychainStore.set("daemon-pairing", origin, value)
                        invoke.resolve(BridgeReply(persisted: true, connection: connection))
                    } catch {
                        // A successful redemption is not repeated. Retain the issued credential in
                        // the UI's memory and allow saving it again; never claim persistence.
                        invoke.resolve(BridgeReply(message: "El host vinculó este dispositivo, pero no se guardó en Llavero. Conserva la app abierta y vuelve a guardar.", persisted: false, connection: connection))
                    }
                } catch { self.fail(invoke, error) }
            }
        } catch { fail(invoke, error) }
    }
    @objc func unpairDevice(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(UnpairInput.self)
            let origin = try Self.privateOrigin(args.origin)
            let stored = try KeychainStore.get("daemon-pairing", origin)
            let connection = stored.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(PairedConnection.self, from: $0) }
            guard let token = args.token ?? connection?.token,
                  token.range(of: "^[A-Za-z0-9_-]{32,1024}$", options: .regularExpression) != nil else { throw DeviceFailure.invalid("No existe un dispositivo vinculado para este host.") }
            BoundedHTTP.run(HTTPInput(url: origin + "/api/mobile/disconnect", method: "POST",
                headers: ["Authorization": "Bearer \(token)", "Content-Type": "application/json"], body: "{}"), timeout: 15) { result in
                do {
                    let response = try result.get()
                    guard response.status == 200 || response.status == 401 else {
                        invoke.resolve(BridgeReply(ok: false, error: "revoke_unconfirmed", status: response.status)); return
                    }
                    // Avoid removing a new credential if a separate pairing completed meanwhile.
                    if try KeychainStore.get("daemon-pairing", origin) == stored { try KeychainStore.delete("daemon-pairing", origin) }
                    invoke.resolve(BridgeReply())
                } catch { self.fail(invoke, error) }
            }
        } catch { fail(invoke, error) }
    }
    @objc func cryptoRandom(_ invoke: Invoke) {
        work(invoke) {
            let args = try invoke.parseArgs(RandomInput.self)
            guard args.length > 0 && args.length <= 64 else { throw DeviceFailure.invalid("Longitud aleatoria inválida.") }
            var bytes = [UInt8](repeating: 0, count: args.length)
            let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
            guard status == errSecSuccess else { throw DeviceFailure.unavailable("No se pudo generar aleatoriedad segura.") }
            let data = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            return BridgeReply(data: data)
        }
    }
    @objc func cryptoSha256(_ invoke: Invoke) {
        work(invoke) {
            let args = try invoke.parseArgs(HashInput.self)
            guard args.data.utf8.count <= 2 * 1024 * 1024 else { throw DeviceFailure.oversized }
            return BridgeReply(hex: SHA256.hash(data: Data(args.data.utf8)).map { String(format: "%02x", $0) }.joined())
        }
    }
    @objc func shareList(_ invoke: Invoke) { work(invoke) { BridgeReply(items: try SharedInbox.list()) } }
    @objc func cryptoHashBegin(_ invoke: Invoke) { work(invoke) { BridgeReply(id: try self.hashes.begin()) } }
    @objc func cryptoHashUpdate(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(HashUpdateInput.self); try self.hashes.update(args.id, args.data); return BridgeReply() }
    }
    @objc func cryptoHashFinish(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(IDInput.self); return BridgeReply(hex: try self.hashes.finish(args.id)) }
    }
    @objc func cryptoHashCancel(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(IDInput.self); self.hashes.cancel(args.id); return BridgeReply() }
    }
    @objc func shareRead(_ invoke: Invoke) {
        work(invoke) {
            let args = try invoke.parseArgs(ReadInput.self)
            return BridgeReply(data: try SharedInbox.read(args.id, args.fileId, args.offset, args.length).base64EncodedString())
        }
    }
    @objc func shareAck(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(IDInput.self); try SharedInbox.acknowledge(args.id); return BridgeReply() }
    }
    @objc func exportBegin(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else {
                self.fail(invoke, DeviceFailure.unavailable("Abre Capri para exportar el archivo.")); return
            }
            self.work(invoke) {
                let args = try invoke.parseArgs(ExportBeginInput.self)
                return BridgeReply(id: try self.exports.begin(args))
            }
        }
    }
    @objc func exportWrite(_ invoke: Invoke) {
        work(invoke) { let args = try invoke.parseArgs(ExportWriteInput.self); return BridgeReply(written: try self.exports.write(args)) }
    }
    @objc func exportPresent(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(IDInput.self)
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let url = try self.exports.prepare(args.id)
                    DispatchQueue.main.async {
                        do {
                            guard self.exports.isPrepared(args.id), self.documentExporter == nil, self.authSession == nil,
                                  let presenter = self.webview?.window?.rootViewController else {
                                throw DeviceFailure.unavailable("Abre Capri y cierra otras ventanas antes de exportar.")
                            }
                            let exporter = DocumentExporter(id: args.id, file: url) { result in
                                self.exports.cancel(args.id)
                                if self.documentExporter?.id == args.id { self.documentExporter = nil }
                                switch result {
                                case .success(let exported): invoke.resolve(BridgeReply(exported: exported, cancelled: !exported))
                                case .failure(let error): self.fail(invoke, error)
                                }
                            }
                            self.documentExporter = exporter
                            do { try exporter.present(from: presenter) }
                            catch { self.documentExporter = nil; throw error }
                        } catch { self.exports.cancel(args.id); self.fail(invoke, error) }
                    }
                } catch { self.exports.cancel(args.id); self.fail(invoke, error) }
            }
        } catch { fail(invoke, error) }
    }
    @objc func exportCancel(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                let args = try invoke.parseArgs(IDInput.self)
                if self.documentExporter?.id == args.id { self.documentExporter?.cancel() }
                else { self.exports.cancel(args.id) }
                invoke.resolve(BridgeReply())
            } catch { self.fail(invoke, error) }
        }
    }
    @objc func oauthAuthorize(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                guard self.authSession == nil else { throw DeviceFailure.unavailable("Ya hay una autorización abierta.") }
                let args = try invoke.parseArgs(OAuthInput.self)
                let forbiddenSchemes: Set<String> = ["http", "https", "file", "javascript", "data", "tauri", "mailto", "tel", "sms"]
                guard args.callbackScheme.range(of: "^[A-Za-z][A-Za-z0-9+.-]{2,127}$", options: .regularExpression) != nil,
                      !forbiddenSchemes.contains(args.callbackScheme.lowercased()), args.authorizationUrl.utf8.count <= 8192,
                      let url = URLComponents(string: args.authorizationUrl), url.scheme == "https",
                      url.host != nil, url.user == nil, url.password == nil, url.fragment == nil,
                      let authorizationURL = url.url else { throw DeviceFailure.invalid("Dirección de autorización inválida.") }
                self.authInvoke = invoke
                let session = ASWebAuthenticationSession(url: authorizationURL, callbackURLScheme: args.callbackScheme) { callback, error in
                    DispatchQueue.main.async {
                        guard let pending = self.authInvoke else { return }
                        self.authInvoke = nil; self.authSession = nil
                        if let callback = callback, callback.absoluteString.utf8.count <= 16 * 1024 {
                            pending.resolve(BridgeReply(callbackUrl: callback.absoluteString))
                        } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                            self.fail(pending, DeviceFailure.cancelled)
                        } else { self.fail(pending, DeviceFailure.network) }
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = true
                self.authSession = session
                guard session.start() else {
                    self.authInvoke = nil; self.authSession = nil
                    throw DeviceFailure.unavailable("No se pudo abrir la autorización.")
                }
            } catch { self.fail(invoke, error) }
        }
    }
    @objc func oauthCancel(_ invoke: Invoke) {
        DispatchQueue.main.async {
            let pending = self.authInvoke; self.authInvoke = nil
            self.authSession?.cancel(); self.authSession = nil
            if let pending = pending { self.fail(pending, DeviceFailure.cancelled) }
            invoke.resolve(BridgeReply())
        }
    }
    // These commands serve explicit account-setup controls, never model tools.
    @objc func openExternalURL(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                guard UIApplication.shared.applicationState == .active else { throw DeviceFailure.unavailable("Abre Capri para continuar con la autorización.") }
                let args = try invoke.parseArgs(URLInput.self)
                let request = try BoundedHTTP.validated(HTTPInput(url: args.url, method: "GET", headers: [:], body: nil))
                guard let url = request.url else { throw DeviceFailure.invalid("Dirección de autorización inválida.") }
                UIApplication.shared.open(url, options: [:]) { opened in
                    if opened { invoke.resolve(BridgeReply()) }
                    else { self.fail(invoke, DeviceFailure.unavailable("No se pudo abrir el navegador para autorizar la cuenta.")) }
                }
            } catch { self.fail(invoke, error) }
        }
    }
    @objc func registeredURLSchemes(_ invoke: Invoke) {
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
            .filter { $0.range(of: "^[A-Za-z][A-Za-z0-9+.-]{2,127}$", options: .regularExpression) != nil }
        invoke.resolve(BridgeReply(schemes: Array(Set(schemes)).sorted()))
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        webview?.window ?? ASPresentationAnchor()
    }
}

@_cdecl("init_plugin_device_bridge")
func initDeviceBridgePlugin() -> Plugin { DeviceBridgePlugin() }

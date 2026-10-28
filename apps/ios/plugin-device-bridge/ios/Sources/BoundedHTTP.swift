import Foundation

struct HTTPInput: Decodable {
    let url: String
    let method: String
    let headers: [String: String]
    let body: String?
}
struct HTTPOutput {
    let status: Int
    let body: String
    let headers: [String: String]
}

// An ephemeral, bounded transport. No redirect can forward credentials to another origin.
// Delegate streaming is required: data(for:) would buffer unbounded bytes before checking size.
final class BoundedHTTP: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private static let maximum = 2 * 1024 * 1024
    private var bytes = Data()
    private var response: HTTPURLResponse?
    private var finished = false
    private var session: URLSession?
    private let queue = OperationQueue()
    private let completion: (Result<HTTPOutput, Error>) -> Void

    private init(completion: @escaping (Result<HTTPOutput, Error>) -> Void) {
        self.completion = completion
        queue.maxConcurrentOperationCount = 1
    }

    static func validated(_ input: HTTPInput) throws -> URLRequest {
        guard input.url.utf8.count <= 8192, let components = URLComponents(string: input.url),
              components.scheme?.lowercased() == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.fragment == nil,
              let url = components.url else { throw DeviceFailure.invalid("Se requiere una dirección HTTPS sin credenciales en la URL.") }
        let deniedQueries: Set<String> = ["token", "access_token", "refresh_token", "api_key", "apikey", "key", "client_secret", "password", "authorization"]
        guard !(components.queryItems ?? []).contains(where: { deniedQueries.contains($0.name.lowercased()) }) else {
            throw DeviceFailure.invalid("Las credenciales deben viajar en cabeceras o cuerpo, nunca en la URL.")
        }
        let method = input.method.uppercased()
        guard ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(method), input.headers.count <= 32,
              (input.body?.utf8.count ?? 0) <= maximum else { throw DeviceFailure.oversized }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let forbidden: Set<String> = ["host", "cookie", "connection", "content-length", "transfer-encoding", "proxy-authorization", "proxy-authenticate", "upgrade"]
        var headerBytes = 0
        for (name, value) in input.headers {
            headerBytes += name.utf8.count + value.utf8.count
            guard !name.isEmpty, name.utf8.count <= 128,
                  name.range(of: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$", options: .regularExpression) != nil,
                  !forbidden.contains(name.lowercased()), value.utf8.count <= 16 * 1024,
                  !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  headerBytes <= 32 * 1024 else { throw DeviceFailure.invalid("Cabeceras HTTP inválidas.") }
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = input.body.map { Data($0.utf8) }
        return request
    }
    static func run(_ input: HTTPInput, timeout: TimeInterval = 30, completion: @escaping (Result<HTTPOutput, Error>) -> Void) {
        do {
            let request = try validated(input)
            let delegate = BoundedHTTP(completion: completion)
            delegate.start(request, file: nil, timeout: timeout)
        } catch { completion(.failure(error)) }
    }
    /// File-backed uploads use the same bounded response and redirect policy.
    /// The caller owns this immutable sandbox file until completion, including cancellation.
    static func upload(_ request: URLRequest, file: URL, completion: @escaping (Result<HTTPOutput, Error>) -> Void) -> BoundedHTTP {
        let delegate = BoundedHTTP(completion: completion)
        delegate.start(request, file: file, timeout: 120)
        return delegate
    }
    private func start(_ input: URLRequest, file: URL?, timeout: TimeInterval) {
        var request = input; request.timeoutInterval = timeout
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = timeout; config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session
        if let file = file { session.uploadTask(with: request, fromFile: file).resume() }
        else { session.dataTask(with: request).resume() }
    }
    func cancel() {
        // All terminal transitions share the delegate queue, including caller cancellation.
        queue.addOperation { self.finish(.failure(DeviceFailure.cancelled)) }
    }
    private func finish(_ result: Result<HTTPOutput, Error>) {
        guard !finished else { return }
        finished = true
        session?.invalidateAndCancel()
        session = nil
        completion(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else { completionHandler(.cancel); finish(.failure(DeviceFailure.network)); return }
        guard response.expectedContentLength <= Int64(Self.maximum) else { completionHandler(.cancel); finish(.failure(DeviceFailure.oversized)); return }
        self.response = http
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        guard bytes.count + data.count <= Self.maximum else { finish(.failure(DeviceFailure.oversized)); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        guard error == nil, let response = response, let body = String(data: bytes, encoding: .utf8) else {
            finish(.failure(DeviceFailure.network)); return
        }
        let allowed: Set<String> = ["content-type", "etag", "retry-after", "link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-github-request-id", "mcp-session-id", "mcp-protocol-version", "www-authenticate"]
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            let name = String(describing: key).lowercased()
            if allowed.contains(name) { headers[name] = String(describing: value) }
        }
        finish(.success(HTTPOutput(status: response.statusCode, body: body, headers: headers)))
    }
}

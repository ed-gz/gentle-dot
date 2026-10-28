// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-device-bridge",
    platforms: [.iOS(.v14)],
    products: [.library(name: "tauri-plugin-device-bridge", type: .static, targets: ["tauri-plugin-device-bridge"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-device-bridge", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

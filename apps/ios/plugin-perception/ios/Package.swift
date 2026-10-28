// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-perception",
    platforms: [.iOS(.v14)],
    products: [.library(name: "tauri-plugin-perception", type: .static, targets: ["tauri-plugin-perception"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-perception", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)

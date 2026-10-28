// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-local-intelligence",
    platforms: [.iOS(.v14)],
    products: [.library(name: "tauri-plugin-local-intelligence", type: .static,
                        targets: ["tauri-plugin-local-intelligence"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-local-intelligence", dependencies: [.byName(name: "Tauri")],
                      path: "Sources")]
)

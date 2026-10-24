//! Shared by build.rs and tests: optimized binaries must never use the Vite development URL.
pub fn require_embedded_release(
    profile: &str,
    development_protocol: bool,
) -> Result<(), &'static str> {
    if profile == "release" && development_protocol {
        return Err("Refusing a desktop release that opens the Vite development server. Build the UI, then use `cargo build --release --features custom-protocol` or `tauri build`. The installed desktop must embed its frontend.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optimized_development_protocol_is_not_a_distribution() {
        assert!(require_embedded_release("release", true).is_err());
        assert!(require_embedded_release("release", false).is_ok());
    }
    #[test]
    fn development_and_embedded_debug_tests_stay_available() {
        assert!(require_embedded_release("debug", true).is_ok());
        assert!(require_embedded_release("debug", false).is_ok());
    }
}

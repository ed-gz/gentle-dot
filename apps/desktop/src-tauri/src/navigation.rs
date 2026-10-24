//! Keep every chat/companion document inside the app while opening ordinary web links externally.
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Destination {
    Internal,
    Browser,
    Block,
}

fn destination_for_backend(
    url: &tauri::Url,
    dev_url: Option<&tauri::Url>,
    http_backend: bool,
) -> Destination {
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Destination::Block;
    }
    let embedded = url.port().is_none()
        && match (http_backend, url.scheme()) {
            (false, "tauri") => url.host_str() == Some("localhost"),
            (true, "http" | "https") => url.host_str() == Some("tauri.localhost"),
            _ => false,
        };
    let development = dev_url.is_some_and(|dev| {
        matches!(dev.scheme(), "http" | "https")
            && dev.username().is_empty()
            && dev.password().is_none()
            && url.scheme() == dev.scheme()
            && url.host_str() == dev.host_str()
            && url.port_or_known_default() == dev.port_or_known_default()
    });
    if embedded || development {
        Destination::Internal
    } else if matches!(url.scheme(), "http" | "https") {
        Destination::Browser
    } else {
        Destination::Block
    }
}

pub(crate) fn handler(app: tauri::AppHandle) -> impl Fn(&tauri::Url) -> bool + Send + 'static {
    // A production build must never admit a Vite server merely because its URL is in config.
    let dev_url = if cfg!(dev) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let http_backend = cfg!(any(target_os = "windows", target_os = "android"));
    move |url| match destination_for_backend(url, dev_url.as_ref(), http_backend) {
        Destination::Internal => true,
        Destination::Browser => {
            if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
                // URLs can carry private query strings; do not write them to daemon logs.
                eprintln!("gentle-dot: could not open external link");
            }
            false
        }
        Destination::Block => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(value: &str) -> tauri::Url {
        tauri::Url::parse(value).unwrap()
    }
    fn destination(url: &tauri::Url, dev: Option<&tauri::Url>) -> Destination {
        destination_for_backend(url, dev, false)
    }

    #[test]
    fn bundled_surfaces_and_anchors_stay_in_the_app() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            for surface in ["dot", "panel", "companion-launcher", "companion-bubble"] {
                assert_eq!(
                    destination_for_backend(
                        &url(&format!("{origin}/index.html?surface={surface}#section")),
                        None,
                        origin.starts_with("http")
                    ),
                    Destination::Internal
                );
            }
        }
    }

    #[test]
    fn http_asset_aliases_are_not_trusted_on_unix() {
        for alias in ["http://tauri.localhost/", "https://tauri.localhost/"] {
            assert_eq!(destination(&url(alias), None), Destination::Browser);
        }
        assert_eq!(
            destination_for_backend(&url("tauri://localhost/"), None, true),
            Destination::Block
        );
    }

    #[test]
    fn development_allows_only_the_configured_origin_and_port() {
        let dev = url("http://127.0.0.1:5173/");
        assert_eq!(
            destination(
                &url("http://127.0.0.1:5173/index.html?surface=panel"),
                Some(&dev)
            ),
            Destination::Internal
        );
        for external in [
            "http://127.0.0.1:4317/",
            "http://localhost:5173/",
            "https://127.0.0.1:5173/",
        ] {
            assert_eq!(
                destination(&url(external), Some(&dev)),
                Destination::Browser
            );
        }
        assert_eq!(destination(&dev, None), Destination::Browser);
        let remote_dev = url("https://dev.example.com:5173/");
        assert_eq!(
            destination(
                &url("https://dev.example.com:5173/index.html"),
                Some(&remote_dev)
            ),
            Destination::Internal
        );
        assert_eq!(
            destination(&url("https://dev.example.com/"), Some(&remote_dev)),
            Destination::Browser
        );
    }

    #[test]
    fn external_web_links_cannot_replace_the_document() {
        for external in [
            "https://example.com/guide",
            "https://tauri.localhost.example.com/",
            "http://tauri.localhost:4317/",
        ] {
            assert_eq!(destination(&url(external), None), Destination::Browser);
        }
    }

    #[test]
    fn credentials_local_files_and_executable_schemes_are_refused() {
        for blocked in [
            "tauri://elsewhere/index.html",
            "tauri://localhost:4317/",
            "https://user@example.com/",
            "https://user@tauri.localhost/",
            "file:///tmp/report",
            "javascript:alert(1)",
            "data:text/html,test",
            "about:blank",
        ] {
            assert_eq!(destination(&url(blocked), None), Destination::Block);
        }
    }
}

//! Bounded native startup diagnostics. This observes only app mount/assets, never chat text,
//! tokens, inputs or external pages. No endpoint, screenshots or recurring polling are added.
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    Manager, WebviewWindow,
};

// This must stay structural: don't inspect body text or serialize the DOM into logs.
#[cfg(target_os = "linux")]
const PROBE: &str = r#"(()=>{
  const root=document.getElementById('root');
  if(!root?.childElementCount || document.readyState!=='complete') return false;
  const sources=[...new Set([...root.querySelectorAll('svg image')].map(i=>i.getAttribute('href')).filter(Boolean))];
  const assets=window.__gentleDotNativeAssets ??= Object.create(null);
  for(const src of sources) if(!(src in assets)) {
    assets[src]=false;
    const img=new Image(); img.onload=()=>{assets[src]=img.naturalWidth>0};
    img.onerror=()=>{assets[src]=false}; img.src=src;
  }
  return sources.every(src=>assets[src]===true);
})()"#;

fn own_document(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

pub(crate) fn page_loaded(window: WebviewWindow, payload: PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    if !matches!(window.label(), "dot" | "panel" | "companion-launcher" | "companion-bubble") {
        return;
    }
    if !own_document(payload.url()) {
        // Development keeps its normal local Vite server. Never certify it as an embedded UI.
        #[cfg(not(dev))]
        eprintln!(
            "gentle-dot frontend failed label={} reason=unexpected-document-origin",
            window.label()
        );
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let label = window.label().to_owned();
        let expect_capri = label == "dot"
            && (crate::desktop_companion::enabled(window.app_handle())
                || crate::desktop_companion::starts_enabled(window.app_handle()));
        if let Err(error) =
            window.with_webview(move |native| probe(native.inner(), label, expect_capri, 60))
        {
            eprintln!("gentle-dot frontend failed reason=native-view-unavailable {error}");
        }
    }
}

#[cfg(target_os = "linux")]
fn probe(view: webkit2gtk::WebView, label: String, expect_capri: bool, remaining: u8) {
    use javascriptcore::ValueExt;
    use webkit2gtk::WebViewExt;
    // A later navigation cancels this document's checks. URLs and their query/fragment stay private.
    if !view
        .uri()
        .and_then(|uri| tauri::Url::parse(&uri).ok())
        .is_some_and(|url| own_document(&url))
    {
        return;
    }
    let next = view.clone();
    let required = if expect_capri {
        "!!document.querySelector('.desktop-companion-surface svg image')"
    } else if label == "companion-launcher" {
        "!!document.querySelector('.desktop-companion-launcher svg image')"
    } else {
        "true"
    };
    let script = format!("{required} && ({PROBE})");
    view.evaluate_javascript(&script,None,None,None::<&webkit2gtk::gio::Cancellable>,move |result| {
        if result.is_ok_and(|value|value.to_boolean()) {
            eprintln!("gentle-dot frontend ready label={label} origin=embedded mount=true assets=true");
        } else if remaining>1 {
            gtk::glib::timeout_add_local_once(std::time::Duration::from_millis(500),move ||probe(next,label,expect_capri,remaining-1));
        } else {
            eprintln!("gentle-dot frontend failed label={label} reason=mount-or-assets-timeout");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_development_server_or_error_document_cannot_be_certified_as_embedded() {
        assert!(own_document(
            &tauri::Url::parse("tauri://localhost/index.html?surface=dot").unwrap()
        ));
        for url in [
            "http://127.0.0.1:5173/",
            "http://127.0.0.1:4317/",
            "about:blank",
            "tauri://another-host/",
        ] {
            assert!(!own_document(&tauri::Url::parse(url).unwrap()));
        }
    }
}

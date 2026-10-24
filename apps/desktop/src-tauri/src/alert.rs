//! Native yes/no alerts owned by the app, never the webview, whose default button is the safe one
//! (L75 A2). Only a click on the allowing button allows: the refusing button, Return, Escape,
//! closing, aborting, an alert that cannot be shown, and any answer not recognized here refuse.
//!
//! macOS: an `NSAlert` run modally on the main thread, asked from a worker thread that waits for
//! the answer. The refusing button is added first (`NSAlertFirstButtonReturn`) with Return as its
//! key equivalent; the allowing button is second and has none, so no key allows. Only the second
//! button's response allows; `abortModal` (the approvals' stale-dialog dismissal) answers
//! `NSModalResponseAbort`, which refuses. The dialog plugin is not used there: with no parent window
//! rfd shows a `CFUserNotification` and reports cancels and failures as `Cancel`, which the plugin
//! turns into the second label of `OkCancelCustom` (T23c B1).
//!
//! Elsewhere (Linux): the dialog plugin with the allowing label in the OK slot and the refusing one
//! in the cancel slot, so every outcome rfd reports as `Cancel` (the refusing button, Escape,
//! closing, a dialog that failed) arrives as the refusing label. rfd's GTK dialog sets no default
//! response, so Return does not pick the allowing button either (not verified on a Linux desktop).

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult};

/// The `NSAlert` response of the refusing button, added first (`NSAlertFirstButtonReturn`).
pub const REFUSE_RESPONSE: isize = 1000;
/// The `NSAlert` response of the allowing button, added second (`NSAlertSecondButtonReturn`).
pub const ALLOW_RESPONSE: isize = 1001;

/// The two buttons of a yes/no alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub allow: &'static str,
    pub refuse: &'static str,
}

impl Choice {
    /// The `NSAlert` buttons in the order they are added: the first is the default (Return).
    pub fn alert_buttons(&self) -> [&'static str; 2] {
        [self.refuse, self.allow]
    }

    /// True only for the allowing button's response; `None` is an alert that never ran.
    pub fn allows_response(&self, response: Option<isize>) -> bool {
        self.allow != self.refuse && response == Some(ALLOW_RESPONSE)
    }

    /// The plugin's buttons (off macOS): the refusing label takes the cancel slot, where rfd puts
    /// Escape, closing, and failures.
    pub fn buttons(&self) -> MessageDialogButtons {
        MessageDialogButtons::OkCancelCustom(self.allow.into(), self.refuse.into())
    }

    /// True only when the plugin reports the allowing button itself.
    pub fn allowed(&self, result: &MessageDialogResult) -> bool {
        self.allow != self.refuse && matches!(result, MessageDialogResult::Custom(label) if label == self.allow)
    }
}

/// Shows the alert and waits for the answer. Blocks, so it never runs on the main thread (there it
/// refuses at once).
pub fn ask(app: &AppHandle, title: &str, message: &str, choice: Choice) -> bool {
    ask_cancellable(app, title, message, choice, Arc::new(AtomicBool::new(false)))
}

/// Carry cancellation through the main-thread queue. A mobile answer can arrive before the
/// desktop is ready to display its alert; that stale alert must never appear afterwards.
pub fn ask_cancellable(
    app: &AppHandle,
    title: &str,
    message: &str,
    choice: Choice,
    cancelled: Arc<AtomicBool>,
) -> bool {
    if cancelled.load(Ordering::SeqCst) {
        return false;
    }
    #[cfg(target_os = "macos")]
    return macos::ask(app, title, message, choice, cancelled, &std::sync::atomic::AtomicU64::new(0));

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        let result = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(choice.buttons())
            .blocking_show_with_result();
        !cancelled.load(Ordering::SeqCst) && choice.allowed(&result)
    }
}

/// An owned macOS approval uses an exact dialog id for cancellation; other alerts are untouched.
#[cfg(target_os = "macos")]
pub fn ask_owned_cancellable(
    app: &AppHandle,
    title: &str,
    message: &str,
    choice: Choice,
    cancelled: Arc<AtomicBool>,
    active: &std::sync::atomic::AtomicU64,
) -> bool {
    macos::ask(app, title, message, choice, cancelled, active)
}

#[cfg(target_os = "macos")]
pub fn dismiss_owned(app: &AppHandle, id: u64) {
    macos::dismiss(app, id);
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{Arc, AtomicBool, Choice, Ordering};
    use block2::RcBlock;
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication};
    use objc2_foundation::{MainThreadMarker, NSString};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::atomic::AtomicU64;
    use tauri::AppHandle;

    static NEXT: AtomicU64 = AtomicU64::new(1);
    // Window pointers stay valid while their owning NSAlert is on the `run` stack. Only the
    // main thread reads this table, and an ended alert removes its entry before being dropped.
    thread_local! { static DIALOGS: RefCell<HashMap<u64, usize>> = RefCell::new(HashMap::new()); }

    pub fn ask(
        app: &AppHandle,
        title: &str,
        message: &str,
        choice: Choice,
        cancelled: Arc<AtomicBool>,
        active: &AtomicU64,
    ) -> bool {
        if MainThreadMarker::new().is_some() {
            eprintln!("gentle-dot: a confirmation was asked on the main thread, so it was refused");
            return false;
        }
        if cancelled.load(Ordering::SeqCst) {
            return false;
        }
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        if active.compare_exchange(0, id, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return false;
        }
        let (answer, answered) = std::sync::mpsc::channel();
        let (title, message) = (title.to_owned(), message.to_owned());
        let pending = cancelled.clone();
        let scheduled = app.run_on_main_thread(move || {
            let response = if pending.load(Ordering::SeqCst) {
                None
            } else {
                MainThreadMarker::new().and_then(|mtm| run(mtm, id, &title, &message, choice, &pending))
            };
            let _ = answer.send(response);
        });
        // The task dropped without running (the app is quitting) reads as no answer.
        let response = if scheduled.is_ok() { answered.recv().ok().flatten() } else { None };
        let _ = active.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst);
        !cancelled.load(Ordering::SeqCst) && choice.allows_response(response)
    }

    fn run(
        mtm: MainThreadMarker,
        id: u64,
        title: &str,
        message: &str,
        choice: Choice,
        cancelled: &AtomicBool,
    ) -> Option<isize> {
        if cancelled.load(Ordering::SeqCst) {
            return None;
        }
        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(message));
        let [refuse, allow] = choice.alert_buttons();
        alert.addButtonWithTitle(&NSString::from_str(refuse)).setKeyEquivalent(&NSString::from_str("\r"));
        alert.addButtonWithTitle(&NSString::from_str(allow)).setKeyEquivalent(&NSString::from_str(""));
        // Gentle Dot is an accessory app; without this the alert can open behind the front app.
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        if cancelled.load(Ordering::SeqCst) {
            return None;
        }
        // SAFETY: NSAlert owns its window; it stays alive until this synchronous run returns.
        let window: *mut AnyObject = unsafe { msg_send![&*alert, window] };
        if window.is_null() {
            return None;
        }
        DIALOGS.with(|dialogs| {
            dialogs.borrow_mut().insert(id, window as usize);
        });
        let response = alert.runModal();
        // Make dismissal explicit after an aborted modal loop as well as a button response.
        // SAFETY: the same NSAlert still owns this window on the main thread.
        unsafe {
            let _: () = msg_send![window, orderOut: std::ptr::null::<AnyObject>()];
        }
        DIALOGS.with(|dialogs| {
            dialogs.borrow_mut().remove(&id);
        });
        Some(response)
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRunLoopGetMain() -> *mut c_void;
        fn CFRunLoopPerformBlock(run_loop: *mut c_void, mode: *const c_void, block: *const c_void);
        fn CFRunLoopWakeUp(run_loop: *mut c_void);
        static kCFRunLoopCommonModes: *const c_void;
    }
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSModalPanelRunLoopMode: *const c_void;
    }

    pub fn dismiss(_app: &AppHandle, id: u64) {
        if id == 0 {
            return;
        }
        let close = RcBlock::new(move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let owned = DIALOGS.with(|dialogs| dialogs.borrow().get(&id).copied());
            let Some(owned) = owned else { return };
            let application = NSApplication::sharedApplication(mtm);
            // SAFETY: AppKit is queried on the main thread, and `owned` belongs to a still-live
            // NSAlert. Identity comparison does not dereference the stored pointer.
            let current: *mut AnyObject = unsafe { msg_send![&*application, modalWindow] };
            if !current.is_null() && current as usize == owned {
                application.abortModal();
            }
        });
        // Tao deliberately defers user-message callbacks while a callback is in a nested modal
        // loop. Schedule directly in that loop instead of `run_on_main_thread`, which would
        // only dismiss after the alert had already closed. Core Foundation copies the block;
        // it captures only a Send/Sync id, and runs exclusively on the main run loop. The two
        // mode registrations are idempotent and also handle a modal ending before dispatch.
        unsafe {
            let run_loop = CFRunLoopGetMain();
            let block = RcBlock::as_ptr(&close).cast::<c_void>();
            CFRunLoopPerformBlock(run_loop, NSModalPanelRunLoopMode, block);
            CFRunLoopPerformBlock(run_loop, kCFRunLoopCommonModes, block);
            CFRunLoopWakeUp(run_loop);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHOICE: Choice = Choice { allow: "Allow", refuse: "Cancel" };

    #[test]
    fn only_the_allowing_buttons_response_allows_an_alert() {
        assert!(CHOICE.allows_response(Some(ALLOW_RESPONSE)));
        // The refusing button (also Return), an aborted alert (a stale one dismissed after the
        // timeout), a stopped or cancelled modal session, an OK nobody can press, a button that
        // does not exist, and an alert that never ran: every one refuses.
        for response in [Some(REFUSE_RESPONSE), Some(-1001), Some(-1000), Some(0), Some(1), Some(1002), Some(-1), None]
        {
            assert!(!CHOICE.allows_response(response), "{response:?}");
        }
        let same = Choice { allow: "OK", refuse: "OK" };
        assert!(!same.allows_response(Some(ALLOW_RESPONSE)));
    }

    #[test]
    fn the_refusing_button_is_added_first_so_it_is_the_default() {
        assert_eq!(CHOICE.alert_buttons(), ["Cancel", "Allow"]);
        assert_eq!((REFUSE_RESPONSE, ALLOW_RESPONSE), (1000, 1001));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(REFUSE_RESPONSE, objc2_app_kit::NSAlertFirstButtonReturn);
            assert_eq!(ALLOW_RESPONSE, objc2_app_kit::NSAlertSecondButtonReturn);
            assert_eq!(objc2_app_kit::NSModalResponseAbort, -1001);
        }
    }

    /// What tauri-plugin-dialog 2.8.1 returns for `OkCancelCustom(ok, cancel)` (desktop.rs:227-252):
    /// rfd's `Ok` becomes `Custom(ok)`, rfd's `Cancel` (Cancel, Escape, closing, a dialog that failed)
    /// becomes `Custom(cancel)`, anything else passes through.
    fn plugin_result(rfd_ok: Option<bool>, buttons: &MessageDialogButtons) -> MessageDialogResult {
        match (rfd_ok, buttons) {
            (Some(true), MessageDialogButtons::OkCancelCustom(ok, _)) => MessageDialogResult::Custom(ok.clone()),
            (Some(false), MessageDialogButtons::OkCancelCustom(_, cancel)) => {
                MessageDialogResult::Custom(cancel.clone())
            }
            (Some(true), _) => MessageDialogResult::Ok,
            _ => MessageDialogResult::Cancel,
        }
    }

    #[test]
    fn with_the_plugin_cancelling_closing_or_failing_refuses() {
        let buttons = CHOICE.buttons();
        assert!(
            matches!(&buttons, MessageDialogButtons::OkCancelCustom(ok, cancel) if ok == "Allow" && cancel == "Cancel")
        );
        // Only the allowing button.
        assert!(CHOICE.allowed(&plugin_result(Some(true), &buttons)));
        // The refusing button, Escape, closing, and failures all arrive as rfd's Cancel.
        assert!(!CHOICE.allowed(&plugin_result(Some(false), &buttons)));
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Cancel,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Custom("allow".into()),
            MessageDialogResult::Custom("Cancel".into()),
            MessageDialogResult::Custom(String::new()),
        ] {
            assert!(!CHOICE.allowed(&result), "{result:?}");
        }
    }

    #[test]
    fn identical_labels_never_allow() {
        let same = Choice { allow: "OK", refuse: "OK" };
        assert!(!same.allowed(&MessageDialogResult::Custom("OK".into())));
    }
}

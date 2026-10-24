//! The real approval dialog: an alert shown by the app (an `NSAlert` on macOS, as computer control
//! does, S24.3), "Decline" as the default button.

use super::{ApprovalDialog, Prompt, APPROVAL_CHOICE};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::atomic::AtomicU64;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;

pub struct NativePrompt {
    app: AppHandle,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    active: AtomicU64,
}

impl NativePrompt {
    pub fn new(app: AppHandle) -> Self {
        NativePrompt {
            app,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            active: AtomicU64::new(0),
        }
    }
}

impl Prompt for NativePrompt {
    fn ask(&self, dialog: &ApprovalDialog) -> bool {
        self.ask_cancellable(dialog, Arc::new(AtomicBool::new(false)))
    }

    fn ask_cancellable(&self, dialog: &ApprovalDialog, cancelled: Arc<AtomicBool>) -> bool {
        #[cfg(target_os = "linux")]
        return linux::ask(&self.app, dialog, cancelled, &self.active);
        #[cfg(target_os = "macos")]
        return crate::alert::ask_owned_cancellable(
            &self.app,
            &dialog.title,
            &dialog.message,
            APPROVAL_CHOICE,
            cancelled,
            &self.active,
        );
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            crate::alert::ask_cancellable(&self.app, &dialog.title, &dialog.message, APPROVAL_CHOICE, cancelled)
        }
    }

    /// Both desktops dismiss the exact owned approval only. A stale cancellation cannot close
    /// a later dialog or an unrelated modal alert.
    fn dismiss(&self) {
        #[cfg(target_os = "linux")]
        linux::dismiss(&self.app, self.active.load(Ordering::SeqCst));
        #[cfg(target_os = "macos")]
        crate::alert::dismiss_owned(&self.app, self.active.load(Ordering::SeqCst));
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::mpsc;

    static NEXT: AtomicU64 = AtomicU64::new(1);
    thread_local! { static DIALOGS: RefCell<HashMap<u64, gtk::MessageDialog>> = RefCell::new(HashMap::new()); }

    pub(super) fn ask(app: &AppHandle, text: &ApprovalDialog, cancelled: Arc<AtomicBool>, active: &AtomicU64) -> bool {
        if cancelled.load(Ordering::SeqCst) || gtk::is_initialized_main_thread() {
            return false;
        }
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        if active.compare_exchange(0, id, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return false;
        }
        let (title, message) = (text.title.clone(), text.message.clone());
        let (answer, answered) = mpsc::channel();
        let shown = app.run_on_main_thread(move || {
            if cancelled.load(Ordering::SeqCst) {
                let _ = answer.send(false);
                return;
            }
            show(id, &title, &message, cancelled, answer);
        });
        let allowed = shown.is_ok() && answered.recv().unwrap_or(false);
        let _ = active.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst);
        allowed
    }

    fn show(id: u64, title: &str, message: &str, cancelled: Arc<AtomicBool>, answer: mpsc::Sender<bool>) {
        if cancelled.load(Ordering::SeqCst) {
            let _ = answer.send(false);
            return;
        }
        let dialog = gtk::MessageDialog::builder()
            .title(title)
            .text(message)
            .message_type(gtk::MessageType::Warning)
            .modal(true)
            .build();
        dialog.add_button(APPROVAL_CHOICE.refuse, gtk::ResponseType::Cancel);
        dialog.add_button(APPROVAL_CHOICE.allow, gtk::ResponseType::Accept);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        let closed_answer = answer.clone();
        dialog.connect_destroy(move |_| {
            DIALOGS.with(|dialogs| {
                dialogs.borrow_mut().remove(&id);
            });
            let _ = closed_answer.send(false);
        });
        dialog.connect_response(move |dialog, response| {
            let allowed = response == gtk::ResponseType::Accept && !cancelled.load(Ordering::SeqCst);
            DIALOGS.with(|dialogs| {
                dialogs.borrow_mut().remove(&id);
            });
            let _ = answer.send(allowed);
            // This exact owned dialog has completed. No widget is used again after destruction.
            unsafe {
                dialog.destroy();
            }
        });
        DIALOGS.with(|dialogs| {
            dialogs.borrow_mut().insert(id, dialog.clone());
        });
        dialog.show_all();
        dialog.present();
    }

    pub(super) fn dismiss(app: &AppHandle, id: u64) {
        if id == 0 {
            return;
        }
        let _ = app.run_on_main_thread(move || close(id));
    }
    fn close(id: u64) {
        // Release the RefCell borrow before response invokes its synchronous callback.
        let dialog = DIALOGS.with(|dialogs| dialogs.borrow().get(&id).cloned());
        if let Some(dialog) = dialog {
            dialog.response(gtk::ResponseType::Cancel);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        #[ignore = "needs a GTK display; creates inert test dialogs and closes them synchronously"]
        fn owned_gtk_dialog_cancellation_never_closes_the_next_dialog() {
            gtk::init().expect("GTK display");
            let (one_tx, one_rx) = mpsc::channel();
            let (two_tx, two_rx) = mpsc::channel();
            let one_cancel = Arc::new(AtomicBool::new(false));
            let two_cancel = Arc::new(AtomicBool::new(false));
            show(8001, "Gentle Dot — inert dialog test", "This test performs no operation.", one_cancel, one_tx);
            show(
                8002,
                "Gentle Dot — inert dialog test",
                "This test performs no operation.",
                two_cancel.clone(),
                two_tx,
            );
            let first = DIALOGS.with(|dialogs| dialogs.borrow().get(&8001).unwrap().clone());
            let second = DIALOGS.with(|dialogs| dialogs.borrow().get(&8002).unwrap().clone());
            assert!(first.is_visible() && second.is_visible());
            close(8001);
            assert!(!one_rx.recv().unwrap());
            assert!(!first.is_visible() && second.is_visible());
            close(8001);
            assert!(second.is_visible(), "a late cancellation must leave the other dialog open");
            two_cancel.store(true, Ordering::SeqCst);
            second.response(gtk::ResponseType::Accept);
            assert!(!two_rx.recv().unwrap(), "a late Allow after cancellation is a refusal");
            assert!(!second.is_visible());
            assert!(DIALOGS.with(|dialogs| dialogs.borrow().is_empty()));
            let (tx, rx) = mpsc::channel();
            show(8003, "Must not appear", "Already cancelled", Arc::new(AtomicBool::new(true)), tx);
            assert!(!rx.recv().unwrap());
            assert!(DIALOGS.with(|dialogs| dialogs.borrow().is_empty()));
        }
    }
}

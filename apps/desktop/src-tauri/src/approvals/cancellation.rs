//! Per-channel approval identities. Registration happens before a dialog worker is scheduled.
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub type Token = Arc<AtomicBool>;
#[derive(Default)]
pub(crate) struct Cancellations {
    pending: HashMap<String, Token>,
    seen: HashSet<String>,
    order: VecDeque<String>,
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
impl Cancellations {
    pub fn begin(&mut self, params: &Value, frame_id: u64) -> Option<(String, Token)> {
        let id = match params.get("requestId") {
            Some(Value::String(id)) if valid_id(id) => id.clone(),
            // Older daemons still work, but only new callers can explicitly cancel by ID.
            None => format!("legacy-{frame_id}"),
            _ => return None,
        };
        if self.pending.len() >= 32 || self.seen.contains(&id) {
            return None;
        }
        let token = Arc::new(AtomicBool::new(false));
        self.pending.insert(id.clone(), token.clone());
        self.seen.insert(id.clone());
        self.order.push_back(id.clone());
        // Pending identities must not be evicted, including a long running dialog at the front.
        while self.order.len() > 1024 {
            let removable = self
                .order
                .iter()
                .position(|id| !self.pending.contains_key(id));
            let Some(index) = removable else {
                break;
            };
            if let Some(old) = self.order.remove(index) {
                self.seen.remove(&old);
            }
        }
        Some((id, token))
    }
    pub fn cancel(&self, id: &str) -> bool {
        if !valid_id(id) {
            return false;
        }
        let Some(token) = self.pending.get(id) else {
            return false;
        };
        token.store(true, Ordering::SeqCst);
        true
    }
    pub fn finish(&mut self, id: &str) {
        self.pending.remove(id);
    }
    pub fn cancel_all(&self) {
        for token in self.pending.values() {
            token.store(true, Ordering::SeqCst);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cancellation_before_worker_start_is_retained_and_is_scoped() {
        let mut registry = Cancellations::default();
        let (_, first) = registry.begin(&json!({"requestId":"first"}), 1).unwrap();
        assert!(registry.cancel("first"));
        let (_, next) = registry.begin(&json!({"requestId":"next"}), 2).unwrap();
        assert!(first.load(Ordering::SeqCst));
        assert!(!next.load(Ordering::SeqCst));
        registry.finish("first");
        assert!(!registry.cancel("first"));
        assert!(!next.load(Ordering::SeqCst));
        assert!(registry.begin(&json!({"requestId":"first"}), 3).is_none());
    }
    #[test]
    fn disconnect_cancels_every_pending_request_and_bad_ids_never_enter() {
        let mut registry = Cancellations::default();
        for id in [
            json!(null),
            json!(""),
            json!("x\ny"),
            json!(17),
            json!("x".repeat(97)),
        ] {
            assert!(registry.begin(&json!({"requestId":id}), 1).is_none());
        }
        let (_, a) = registry.begin(&json!({"requestId":"a"}), 1).unwrap();
        let (_, b) = registry.begin(&json!({}), 2).unwrap();
        registry.cancel_all();
        assert!(a.load(Ordering::SeqCst) && b.load(Ordering::SeqCst));
    }
    #[test]
    fn replay_memory_is_bounded_without_evicting_pending_identity() {
        let mut registry = Cancellations::default();
        registry.begin(&json!({"requestId":"pending"}), 1).unwrap();
        for n in 0..1100 {
            let id = format!("request-{n}");
            registry.begin(&json!({"requestId":id}), n + 2).unwrap();
            registry.finish(&id);
        }
        assert_eq!(registry.seen.len(), 1024);
        assert!(registry
            .begin(&json!({"requestId":"pending"}), 9999)
            .is_none());
        assert!(registry.cancel("pending"));
    }
}

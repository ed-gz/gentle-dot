//! Bounded, expiring audio assembly on the existing private channel.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use super::audio::MAX_WAV_BYTES;

struct Upload { id: String, data: Vec<u8>, started: Instant }
#[derive(Default)]
pub struct Transfers { upload: Arc<Mutex<Option<Upload>>>, decoding: Mutex<()> }
impl Transfers {
    pub fn clear(&self) { *self.upload.lock().unwrap() = None; }
    pub fn request(&self, method: &str, params: &Value, recognize: impl FnOnce(&[u8]) -> Result<String,String>) -> Result<Value,String> {
        let id = params.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 100).ok_or("Invalid voice transfer id.")?;
        let mut slot = self.upload.lock().unwrap();
        if slot.as_ref().is_some_and(|s| s.started.elapsed() >= Duration::from_secs(90)) { *slot = None; }
        if method == "voice_begin" {
            if slot.is_some() || self.decoding.try_lock().is_err() { return Err("PC voice is busy.".into()); }
            *slot = Some(Upload {id:id.into(),data:Vec::new(),started:Instant::now()});
            let weak = Arc::downgrade(&self.upload);
            let key = id.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(90));
                if let Some(upload) = weak.upgrade() {
                    let mut slot = upload.lock().unwrap();
                    if slot.as_ref().is_some_and(|s| s.id == key && s.started.elapsed() >= Duration::from_secs(90)) { *slot = None; }
                }
            });
            return Ok(json!({}));
        }
        if method == "voice_cancel" {
            if slot.as_ref().is_some_and(|s| s.id == id) { *slot = None; }
            return Ok(json!({}));
        }
        let upload = slot.as_mut().filter(|s| s.id == id).ok_or("Voice transfer expired.")?;
        if method == "voice_chunk" {
            let encoded = params.get("data").and_then(Value::as_str).filter(|s| s.len() <= 256_000).ok_or("Invalid voice chunk.")?;
            let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid voice audio.")?;
            if upload.data.len() + bytes.len() > MAX_WAV_BYTES { *slot = None; return Err("Voice recording exceeds one minute.".into()); }
            upload.data.extend_from_slice(&bytes);
            return Ok(json!({}));
        }
        if method != "voice_finish" { return Err("Unknown voice request.".into()); }
        let _busy = self.decoding.try_lock().map_err(|_| "PC voice is busy.")?;
        let audio = slot.take().unwrap().data;
        drop(slot);
        recognize(&audio).map(|text| json!({"text":text}))
    }
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn total_audio_is_capped_and_expired_transfers_are_freed() {
  let transfers = Transfers::default();
  transfers.request("voice_begin", &json!({"id":"one"}), |_| unreachable!()).unwrap();
  let chunk = STANDARD.encode(vec![0;192_000]);
  for _ in 0..10 { transfers.request("voice_chunk", &json!({"id":"one","data":chunk}), |_| unreachable!()).unwrap(); }
  assert!(transfers.request("voice_chunk", &json!({"id":"one","data":STANDARD.encode(vec![0;45])}), |_| unreachable!()).is_err());
  assert!(transfers.upload.lock().unwrap().is_none());
  transfers.request("voice_begin", &json!({"id":"two"}), |_| unreachable!()).unwrap();
  transfers.upload.lock().unwrap().as_mut().unwrap().started = Instant::now()-Duration::from_secs(91);
  assert!(transfers.request("voice_finish", &json!({"id":"two"}), |_| unreachable!()).is_err());
  assert!(transfers.upload.lock().unwrap().is_none());
 }
 #[test]
 fn transfers_are_bounded_owned_and_consumed_once() {
  let transfers = Transfers::default();
  let request = |method, params| transfers.request(method, &params, |bytes| { assert_eq!(bytes, &[1,2,3]); Ok("hola".into()) });
  request("voice_begin",json!({"id":"one"})).unwrap();
  assert!(request("voice_begin",json!({"id":"two"})).is_err());
  assert!(request("voice_chunk",json!({"id":"two","data":"AQID"})).is_err());
  request("voice_chunk",json!({"id":"one","data":"AQID"})).unwrap();
  assert_eq!(request("voice_finish",json!({"id":"one"})).unwrap()["text"], "hola");
  assert!(request("voice_finish",json!({"id":"one"})).is_err());
  request("voice_begin",json!({"id":"two"})).unwrap();
  assert!(request("voice_chunk",json!({"id":"two","data":"A".repeat(256004)})).is_err());
  request("voice_cancel",json!({"id":"two"})).unwrap();
  assert!(request("voice_finish",json!({"id":"two"})).is_err());
 }
}

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;

const VENDOR_PUBLIC_HEX: &str = "4fde975e6ad2c8328f7b8411d50e30c7a32a2641d97fc3953f044bcd71fef73c";

#[derive(serde::Deserialize)]
struct Payload {
    org: String,
    kind: String,
    exp: i64,
    #[allow(dead_code)]
    id: String,
}

#[derive(Serialize, Clone)]
pub struct LicenseInfo {
    pub org: String,
    pub kind: String,
    pub exp: i64,
    pub valid: bool,
    pub reason: String,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub fn verify(code: &str) -> Result<LicenseInfo, String> {
    let parts: Vec<&str> = code.trim().split('.').collect();
    if parts.len() != 2 {
        return Err("Неверный формат лицензии".into());
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| "Неверная лицензия".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Неверная лицензия".to_string())?;
    let vk_bytes: [u8; 32] = hex::decode(VENDOR_PUBLIC_HEX)
        .unwrap()
        .try_into()
        .unwrap();
    let vk = VerifyingKey::from_bytes(&vk_bytes).map_err(|e| e.to_string())?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "Неверная подпись".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(&payload_bytes, &sig)
        .map_err(|_| "Лицензия недействительна (подпись не наша)".to_string())?;
    let p: Payload =
        serde_json::from_slice(&payload_bytes).map_err(|_| "Повреждённая лицензия".to_string())?;
    let expired = p.exp != 0 && now() > p.exp;
    Ok(LicenseInfo {
        org: p.org,
        kind: p.kind,
        exp: p.exp,
        valid: !expired,
        reason: if expired {
            "Срок лицензии истёк".into()
        } else {
            String::new()
        },
    })
}

#[tauri::command]
pub fn sv_check_license(code: String) -> Result<LicenseInfo, String> {
    verify(&code)
}

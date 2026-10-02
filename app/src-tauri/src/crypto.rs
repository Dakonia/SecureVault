use secrecy::ExposeSecret;
use std::io::{Read, Write};

pub fn generate() -> (String, String) {
    let id = age::x25519::Identity::generate();
    let public = id.to_public().to_string();
    let secret = id.to_string().expose_secret().to_string();
    (secret, public)
}

pub fn encrypt(plaintext: &[u8], recipients: &[String]) -> Result<Vec<u8>, String> {
    let mut recips: Vec<Box<dyn age::Recipient + Send>> = Vec::new();
    for r in recipients {
        let rec = r
            .parse::<age::x25519::Recipient>()
            .map_err(|e| format!("bad recipient: {e}"))?;
        recips.push(Box::new(rec));
    }
    let enc = age::Encryptor::with_recipients(recips).ok_or_else(|| "no recipients".to_string())?;
    let mut out = Vec::new();
    let mut w = enc.wrap_output(&mut out).map_err(|e| e.to_string())?;
    w.write_all(plaintext).map_err(|e| e.to_string())?;
    w.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn decrypt(ciphertext: &[u8], identity: &str) -> Result<Vec<u8>, String> {
    let id = identity
        .parse::<age::x25519::Identity>()
        .map_err(|e| format!("bad identity: {e}"))?;
    let dec = age::Decryptor::new(ciphertext).map_err(|e| e.to_string())?;
    let mut reader = match dec {
        age::Decryptor::Recipients(d) => d
            .decrypt(std::iter::once(&id as &dyn age::Identity))
            .map_err(|e| e.to_string())?,
        _ => return Err("not recipient-encrypted".to_string()),
    };
    let mut out = Vec::new();
    reader.read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct KeyPair {
    pub secret: String,
    pub public: String,
}

#[tauri::command]
pub fn sv_keygen() -> KeyPair {
    let (secret, public) = generate();
    KeyPair { secret, public }
}

#[tauri::command]
pub fn sv_encrypt(plaintext: String, recipients: Vec<String>) -> Result<Vec<u8>, String> {
    encrypt(plaintext.as_bytes(), &recipients)
}

#[tauri::command]
pub fn sv_decrypt(ciphertext: Vec<u8>, identity: String) -> Result<String, String> {
    let bytes = decrypt(&ciphertext, &identity)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_isolation() {
        let (a_sec, a_pub) = generate();
        let (b_sec, b_pub) = generate();
        let (out_sec, _out_pub) = generate();

        let ct = encrypt("секрет: выручка 812000".as_bytes(), &[a_pub, b_pub]).unwrap();

        assert_eq!(decrypt(&ct, &a_sec).unwrap(), "секрет: выручка 812000".as_bytes());
        assert_eq!(decrypt(&ct, &b_sec).unwrap(), "секрет: выручка 812000".as_bytes());
        assert!(decrypt(&ct, &out_sec).is_err());
    }
}

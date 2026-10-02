use reqwest::blocking::multipart::{Form, Part};

fn cfg(name: &str) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    std::fs::read_to_string(format!("{home}/.securevault-dev/{name}"))
        .map_err(|e| format!("config {name}: {e}"))
}

fn server_url() -> Result<String, String> {
    Ok(cfg("server_url")?.trim().trim_end_matches('/').to_string())
}

fn client(ca_pem: &str, client_pem: &str) -> Result<reqwest::blocking::Client, String> {
    let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|e| e.to_string())?;
    let id = reqwest::Identity::from_pem(client_pem.as_bytes()).map_err(|e| e.to_string())?;
    reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .add_root_certificate(ca)
        .identity(id)
        .build()
        .map_err(|e| e.to_string())
}

fn client_from_cfg() -> Result<reqwest::blocking::Client, String> {
    client(&cfg("ca.crt")?, &cfg("client.pem")?)
}

pub fn server_health(url: &str, ca_pem: &str, client_pem: &str) -> Result<String, String> {
    let c = client(ca_pem, client_pem)?;
    let resp = c
        .get(format!("{}/health", url.trim_end_matches('/')))
        .send()
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "{} {}",
        resp.status(),
        resp.text().map_err(|e| e.to_string())?
    ))
}

#[tauri::command]
pub fn sv_health(server_url: String, ca_pem: String, client_pem: String) -> Result<String, String> {
    server_health(&server_url, &ca_pem, &client_pem)
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct Rec {
    pub id: String,
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    pub by: Option<String>,
    pub name: Option<String>,
    pub size: i64,
    pub at: String,
}

#[tauri::command]
pub fn sv_submit(
    space: String,
    kind: String,
    author: String,
    name: String,
    content: String,
) -> Result<String, String> {
    let recipients: Vec<String> = cfg("age_recipients.txt")?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let ct = crate::crypto::encrypt(content.as_bytes(), &recipients)?;
    let form = Form::new()
        .text("space", space)
        .text("type", kind)
        .text("by", author)
        .text("name", name)
        .part("file", Part::bytes(ct).file_name("blob"));
    let resp = client_from_cfg()?
        .post(format!("{}/records", server_url()?))
        .multipart(form)
        .send()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    Ok(v["id"].as_str().unwrap_or("").to_string())
}

#[tauri::command]
pub fn sv_list(space: String) -> Result<Vec<Rec>, String> {
    let resp = client_from_cfg()?
        .get(format!("{}/records?space={}", server_url()?, space))
        .send()
        .map_err(|e| e.to_string())?;
    resp.json::<Vec<Rec>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sv_open(id: String) -> Result<String, String> {
    let ident = cfg("age_id.txt")?;
    let resp = client_from_cfg()?
        .get(format!("{}/blobs/{}", server_url()?, id))
        .send()
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().map_err(|e| e.to_string())?.to_vec();
    let pt = crate::crypto::decrypt(&bytes, ident.trim())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct AuthMethods {
    pub password: bool,
    pub usb: bool,
    pub yubikey: bool,
}

fn detect_usb() -> bool {
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for e in entries.flatten() {
            if e.path().join(".securevault").join("key").exists() {
                return true;
            }
        }
    }
    false
}

fn detect_yubikey() -> bool {
    // Быстрый дешёвый детект через ioreg (system_profiler слишком медленный и тормозил UI).
    // Пока без YubiKey-железа вернёт false; полноценная привязка к YubiKey — отдельным шагом.
    std::process::Command::new("ioreg")
        .args(["-rc", "IOUSBHostDevice", "-k", "USB Vendor Name"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("Yubico"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn sv_auth_methods() -> AuthMethods {
    tauri::async_runtime::spawn_blocking(|| AuthMethods {
        password: true,
        usb: detect_usb(),
        yubikey: detect_yubikey(),
    })
    .await
    .unwrap_or(AuthMethods {
        password: true,
        usb: false,
        yubikey: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn live_flow() {
        let id = sv_submit(
            "resto-7".into(),
            "Отчёт недели".into(),
            "Директор №7".into(),
            "otchet.txt".into(),
            "Выручка: 999000".into(),
        )
        .unwrap();
        println!("submit id => {id}");
        let list = sv_list("resto-7".into()).unwrap();
        println!("list count => {}", list.len());
        assert!(list.iter().any(|r| r.id == id));
        let opened = sv_open(id).unwrap();
        println!("opened => {opened}");
        assert!(opened.contains("999000"));
    }
}

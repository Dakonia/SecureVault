use crate::license::{self, LicenseInfo};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    Key, XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

// Подготовленный мастер-аккаунт, созданный локально и ещё НЕ загруженный на сервер.
// Держится только в памяти процесса: на диск ничего секретного не пишем, лицензия не сожжена.
struct Pending {
    org: String,
    login: String,
    salt: [u8; 16],
    auth_token: [u8; 32],
    enc_vault: Vec<u8>,
    license_code: String,
}

fn pending() -> &'static Mutex<Option<Pending>> {
    static P: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Profile {
    pub name: String,
    pub role: String,
    pub method: String,
    pub age_public: String,
    pub cert_serial: String,
    pub revoked: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RoleDef {
    pub key: String,
    pub name: String,
    pub perms: Vec<String>,
}

fn all_perms() -> Vec<String> {
    ["submit", "view_own", "view_all", "edit", "delete", "comments", "chat", "view_log", "export"]
        .iter().map(|s| s.to_string()).collect()
}

fn default_roles() -> Vec<RoleDef> {
    vec![
        RoleDef {
            key: "director".into(),
            name: "Директор".into(),
            perms: vec!["submit".into(), "view_own".into(), "edit".into(), "delete".into(), "comments".into(), "export".into(), "chat".into(), "view_log".into()],
        },
        RoleDef {
            key: "reviewer".into(),
            name: "Проверяющий".into(),
            perms: vec!["view_all".into(), "view_own".into(), "edit".into(), "delete".into(), "comments".into(), "export".into(), "chat".into(), "view_log".into()],
        },
    ]
}

// эффективные права аккаунта: из его сейфа, иначе из дефолтной роли (мастер — все)
fn perms_for(v: &Vault) -> Vec<String> {
    if !v.my_perms.is_empty() {
        return v.my_perms.clone();
    }
    let role = if v.role.is_empty() { "master" } else { &v.role };
    if role == "master" {
        return all_perms();
    }
    default_roles().into_iter().find(|r| r.key == role).map(|r| r.perms).unwrap_or_default()
}

#[derive(Serialize, Deserialize, Default)]
struct Vault {
    org: String,
    server: String,
    #[serde(default)]
    role: String,
    ca_cert: String,
    ca_key: String,
    master_secret: String,
    master_public: String,
    login: String,
    license: String,
    profiles: Vec<Profile>,
    #[serde(default)]
    roles: Vec<RoleDef>,
    #[serde(default)]
    orgs: Vec<String>,
    #[serde(default)]
    me_name: String,
    #[serde(default)]
    me_company: String,
    #[serde(default)]
    my_perms: Vec<String>,
}

// домашняя папка пользователя: HOME (macOS/Linux) или USERPROFILE (Windows)
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok())
}

// адрес сервера на время сессии — держим в памяти, на диск в открытом виде не пишем
static SESSION_SERVER: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_session_server(s: &str) {
    if let Ok(mut g) = SESSION_SERVER.lock() {
        *g = Some(s.trim().to_string());
    }
}

fn default_server() -> String {
    if let Ok(g) = SESSION_SERVER.lock() {
        if let Some(s) = g.as_ref() {
            if !s.is_empty() {
                return s.clone();
            }
        }
    }
    if let Some(home) = home_dir() {
        if let Ok(s) = std::fs::read_to_string(format!("{home}/.securevault-dev/server")) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    "https://127.0.0.1:18088".to_string()
}

// путь к запечатанному адресу подключения (разовый код)
fn conn_file() -> Option<String> {
    home_dir().map(|h| format!("{h}/.securevault-dev/conn"))
}

// адрес из запечатанного кода, открывается паролем пользователя
fn sealed_server(password: &str) -> Option<String> {
    let p = conn_file()?;
    let raw = std::fs::read_to_string(&p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let salt = STANDARD.decode(v["salt"].as_str()?).ok()?;
    let sealed = STANDARD.decode(v["sealed"].as_str()?).ok()?;
    let (enc_key, _) = derive(password, &salt).ok()?;
    open_vault(&sealed, &enc_key).ok()
}

fn remember_server(server: &str) {
    if let Some(home) = home_dir() {
        let _ = std::fs::create_dir_all(format!("{home}/.securevault-dev"));
        let _ = std::fs::write(format!("{home}/.securevault-dev/server"), server.trim());
    }
}

// Адрес нашего сервера лицензий (LA) — всегда наш, вшит в приложение.
fn la_url() -> String {
    std::env::var("SV_LA").unwrap_or_else(|_| "https://31.44.7.33:8099".to_string())
}

#[tauri::command]
pub fn sv_get_server() -> String {
    default_server()
}

#[derive(Serialize)]
pub struct LicenseStatus {
    pub org: String,
    pub kind: String,
    pub exp: i64,
    pub valid: bool,
    pub reason: String,
    pub used: bool,
    pub used_known: bool,
}

// Полный статус лицензии при вводе: подпись+срок (локально) + активирована ли уже ГЛОБАЛЬНО (сервер лицензий).
// Адрес сервера лицензий вшит, поэтому «использована» известна сразу, не дожидаясь выбора сервера клиента.
pub fn sv_license_status_impl(code: String) -> Result<LicenseStatus, String> {
    let info = license::verify(&code)?;
    let mut used = false;
    let mut used_known = false;
    if let Ok(c) = http() {
        if let Ok(r) = c
            .post(format!("{}/license", la_url()))
            .timeout(std::time::Duration::from_secs(6))
            .json(&serde_json::json!({ "license": code }))
            .send()
        {
            if let Ok(j) = r.json::<serde_json::Value>() {
                used = j["used"].as_bool().unwrap_or(false);
                used_known = true;
            }
        }
    }
    Ok(LicenseStatus {
        org: info.org,
        kind: info.kind,
        exp: info.exp,
        valid: info.valid,
        reason: info.reason,
        used,
        used_known,
    })
}

// из пароля: 64 байта argon2 → enc_key[32] (шифрует ячейку, не уходит) + auth_token[32] (доказательство серверу)
fn derive(password: &str, salt: &[u8]) -> Result<([u8; 32], [u8; 32]), String> {
    let mut out = [0u8; 64];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    let mut enc = [0u8; 32];
    let mut tok = [0u8; 32];
    enc.copy_from_slice(&out[..32]);
    tok.copy_from_slice(&out[32..]);
    Ok((enc, tok))
}

fn seal_vault(json: &str, enc_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(enc_key));
    let nonce: [u8; 24] = rand::random();
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), json.as_bytes())
        .map_err(|_| "encrypt".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open_vault(data: &[u8], enc_key: &[u8; 32]) -> Result<String, String> {
    if data.len() < 24 {
        return Err("bad vault".into());
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(enc_key));
    let pt = cipher
        .decrypt(XNonce::from_slice(&data[..24]), &data[24..])
        .map_err(|_| "Неверный пароль".to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

fn gen_ca(org: &str) -> Result<(String, String), String> {
    let mut p = rcgen::CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    p.distinguished_name
        .push(rcgen::DnType::CommonName, format!("SecureVault CA — {org}"));
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = p.self_signed(&key).map_err(|e| e.to_string())?;
    Ok((cert.pem(), key.serialize_pem()))
}

// CA встроен в приложение — чтобы установленная сборка проверяла TLS без dev-файлов.
// В dev можно переопределить своим ~/.securevault-dev/ca.crt.
const EMBEDDED_CA: &str = include_str!("../ca.crt");

fn http() -> Result<reqwest::blocking::Client, String> {
    let ca_pem = home_dir()
        .and_then(|home| std::fs::read_to_string(format!("{home}/.securevault-dev/ca.crt")).ok())
        .unwrap_or_else(|| EMBEDDED_CA.to_string());
    let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|e| e.to_string())?;
    reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .add_root_certificate(ca)
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct MasterInfo {
    pub org: String,
    pub login: String,
    pub server: String,
    pub role: String,
    pub profiles: Vec<Profile>,
    pub roles: Vec<RoleDef>,
    pub orgs: Vec<String>,
    pub me_name: String,
    pub me_company: String,
    pub perms: Vec<String>,
    pub license: Option<LicenseInfo>,
}

fn info_from(v: &Vault) -> MasterInfo {
    MasterInfo {
        org: v.org.clone(),
        login: v.login.clone(),
        server: v.server.clone(),
        role: if v.role.is_empty() { "master".into() } else { v.role.clone() },
        profiles: v.profiles.clone(),
        roles: if v.roles.is_empty() { default_roles() } else { v.roles.clone() },
        orgs: if v.orgs.is_empty() { vec![v.org.clone()] } else { v.orgs.clone() },
        me_name: v.me_name.clone(),
        me_company: v.me_company.clone(),
        perms: perms_for(v),
        license: license::verify(&v.license).ok(),
    }
}

#[derive(Serialize)]
pub struct MasterDraft {
    pub org: String,
    pub login: String,
    pub role: String,
}

// Шаг 1: создать мастер-аккаунт ЛОКАЛЬНО (ключи, CA, зашифрованная ячейка).
// На сервер ничего не уходит, лицензия НЕ гасится. Держим в памяти до выбора сервера.
pub fn sv_prepare_master_impl(
    license_code: String,
    org: String,
    login: String,
    password: String,
) -> Result<MasterDraft, String> {
    let org = org.trim().to_string();
    if org.is_empty() {
        return Err("Укажите название организации".into());
    }
    if login.trim().is_empty() {
        return Err("Укажите логин".into());
    }
    if password.len() < 6 {
        return Err("Пароль не короче 6 символов".into());
    }
    let info = license::verify(&license_code)?;
    if !info.valid {
        return Err(info.reason);
    }
    let salt: [u8; 16] = rand::random();
    let (enc_key, auth_token) = derive(&password, &salt)?;
    let (ca_cert, ca_key) = gen_ca(&org)?;
    let (master_secret, master_public) = crate::crypto::generate();
    let v = Vault {
        org: org.clone(),
        server: String::new(),
        role: "master".into(),
        ca_cert,
        ca_key,
        master_secret,
        master_public,
        login: login.trim().to_string(),
        license: license_code.clone(),
        profiles: vec![],
        roles: default_roles(),
        orgs: vec![org.clone()],
        me_name: String::new(),
        me_company: String::new(),
        my_perms: vec![],
    };
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    *pending().lock().unwrap() = Some(Pending {
        org: org.clone(),
        login: login.trim().to_string(),
        salt,
        auth_token,
        enc_vault,
        license_code,
    });
    Ok(MasterDraft {
        org,
        login: login.trim().to_string(),
        role: "master".into(),
    })
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub ok: bool,
    pub service: String,
    pub version: String,
    pub license_used: bool,
    pub login_taken: bool,
}

// Шаг 2: проверить, что по указанному адресу отвечает именно сервер SecureVault,
// и ПРОТИВ ЭТОГО сервера — не использована ли лицензия и не занят ли логин.
// Проверка имеет смысл только относительно выбранного сервера (у каждого своя база).
pub fn sv_check_server_impl(server: String) -> Result<ServerInfo, String> {
    let server = server.trim().trim_end_matches('/').to_string();
    if !server.starts_with("https://") {
        return Err("Адрес должен начинаться с https://".into());
    }
    let c = http()?;
    let resp = c
        .get(format!("{server}/health"))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .map_err(|e| format!("Сервер не отвечает: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    let snippet: String = body.chars().take(90).collect();
    if !status.is_success() {
        return Err(format!("Сервер ответил {status}: {snippet}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| format!("Ответ не похож на SecureVault: {snippet}"))?;
    if v["service"].as_str() != Some("securevault") {
        return Err(format!("Это не сервер SecureVault (service={:?})", v["service"].as_str()));
    }
    // подготовленный черновик: лицензию проверяем ГЛОБАЛЬНО (на сервере лицензий),
    // а логин — на выбранном сервере клиента (логины уникальны в рамках сервера).
    let (code, login) = {
        let g = pending().lock().unwrap();
        match g.as_ref() {
            Some(p) => (p.license_code.clone(), p.login.clone()),
            None => (String::new(), String::new()),
        }
    };
    let mut license_used = false;
    let mut login_taken = false;
    if !code.is_empty() {
        if let Ok(r) = c
            .post(format!("{}/license", la_url()))
            .json(&serde_json::json!({ "license": code }))
            .send()
        {
            if let Ok(j) = r.json::<serde_json::Value>() {
                license_used = j["used"].as_bool().unwrap_or(false);
            }
        }
    }
    if !login.is_empty() {
        if let Ok(r) = c.get(format!("{server}/auth/salt?login={login}")).send() {
            login_taken = r.status().is_success();
        }
    }
    Ok(ServerInfo {
        ok: true,
        service: "securevault".into(),
        version: v["version"].as_str().unwrap_or("?").to_string(),
        license_used,
        login_taken,
    })
}

// Шаг 3: загрузить подготовленный аккаунт на выбранный сервер. Здесь лицензия ГАСИТСЯ.
pub fn sv_finish_master_impl(server: String) -> Result<MasterInfo, String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let p = pending()
        .lock()
        .unwrap()
        .take()
        .ok_or("Сначала создайте мастер-аккаунт")?;
    let restore = |p: Pending| *pending().lock().unwrap() = Some(p);
    let c = match http() {
        Ok(c) => c,
        Err(e) => {
            restore(p);
            return Err(e);
        }
    };

    // 0. логин свободен на сервере клиента? (иначе не тратим активацию лицензии)
    if let Ok(r) = c.get(format!("{server}/auth/salt?login={}", p.login)).send() {
        if r.status().is_success() {
            restore(p);
            return Err("Логин уже занят на этом сервере — вернитесь и смените его".into());
        }
    }

    // 1. глобальная активация на сервере лицензий — тут код гаснет НАВСЕГДА
    let act = match c
        .post(format!("{}/activate", la_url()))
        .json(&serde_json::json!({ "license": p.license_code }))
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            restore(p);
            return Err(format!("Сервер лицензий недоступен: {e}"));
        }
    };
    if !act.status().is_success() {
        let msg = act
            .json::<serde_json::Value>()
            .ok()
            .and_then(|j| j["error"].as_str().map(String::from))
            .unwrap_or_else(|| "Активация отклонена".into());
        restore(p);
        return Err(msg);
    }
    let token = act
        .json::<serde_json::Value>()
        .ok()
        .and_then(|j| j["token"].as_str().map(String::from))
        .unwrap_or_default();

    // 2. регистрация на сервере клиента с подтверждением активации
    let body = serde_json::json!({
        "license": p.license_code,
        "activation_token": token,
        "org": p.org,
        "login": p.login,
        "salt": STANDARD.encode(p.salt),
        "auth_token": STANDARD.encode(p.auth_token),
        "enc_vault": STANDARD.encode(&p.enc_vault),
    });
    let resp = match c.post(format!("{server}/auth/register")).json(&body).send() {
        Ok(r) => r,
        Err(e) => {
            restore(p);
            return Err(format!("Сервер недоступен: {e}"));
        }
    };
    if !resp.status().is_success() {
        let msg = resp.text().unwrap_or_else(|_| "ошибка регистрации".into());
        restore(p);
        return Err(msg);
    }
    remember_server(&server);
    Ok(MasterInfo {
        org: p.org.clone(),
        login: p.login,
        server,
        role: "master".into(),
        profiles: vec![],
        roles: default_roles(),
        orgs: vec![p.org],
        me_name: String::new(),
        me_company: String::new(),
        perms: all_perms(),
        license: license::verify(&p.license_code).ok(),
    })
}

fn fetch_vault(server: &str, login: &str, password: &str) -> Result<([u8; 32], Vault), String> {
    let c = http()?;
    let salt_resp = c
        .get(format!("{server}/auth/salt?login={login}"))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !salt_resp.status().is_success() {
        return Err("Аккаунт не найден".into());
    }
    let sv: serde_json::Value = salt_resp.json().map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let (enc_key, auth_token) = derive(password, &salt)?;
    let login_resp = c
        .post(format!("{server}/auth/login"))
        .json(&serde_json::json!({"login": login, "auth_token": STANDARD.encode(auth_token)}))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !login_resp.status().is_success() {
        return Err("Неверный логин или пароль".into());
    }
    let lv: serde_json::Value = login_resp.json().map_err(|e| e.to_string())?;
    let enc_vault = STANDARD
        .decode(lv["enc_vault"].as_str().unwrap_or(""))
        .map_err(|_| "bad vault".to_string())?;
    let json = open_vault(&enc_vault, &enc_key)?;
    let v: Vault = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok((enc_key, v))
}

pub fn sv_login_impl(login: String, password: String) -> Result<MasterInfo, String> {
    let server = sealed_server(&password).unwrap_or_else(default_server);
    set_session_server(&server);
    let (_enc, v) = fetch_vault(&server, login.trim(), &password)?;
    Ok(info_from(&v))
}

// разовый код подключения: декодируем адрес и запечатываем паролем (на диск — только шифротекст)
pub fn sv_connect_code_impl(code: String, password: String) -> Result<String, String> {
    let body = code.trim().strip_prefix("SV1.").ok_or("Неверный код подключения")?;
    let raw = STANDARD.decode(body.trim()).map_err(|_| "Неверный код подключения".to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "Неверный код подключения".to_string())?;
    let addr = v["s"].as_str().ok_or("Неверный код подключения")?.trim().to_string();
    if !addr.starts_with("https://") && !addr.starts_with("http://") {
        return Err("Неверный код подключения".into());
    }
    let salt: [u8; 16] = rand::random();
    let (enc_key, _) = derive(&password, &salt)?;
    let sealed = seal_vault(&addr, &enc_key)?;
    let p = conn_file().ok_or("нет HOME")?;
    if let Some(dir) = std::path::Path::new(&p).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let out = serde_json::json!({"salt": STANDARD.encode(salt), "sealed": STANDARD.encode(sealed)}).to_string();
    std::fs::write(&p, out).map_err(|e| e.to_string())?;
    set_session_server(&addr);
    Ok(addr)
}

// есть ли уже сохранённое подключение (разовый код введён)
pub fn sv_conn_status_impl() -> bool {
    conn_file().map(|p| std::path::Path::new(&p).exists()).unwrap_or(false)
}

// сгенерировать код подключения для сотрудников (у мастера/владельца)
pub fn sv_make_conn_code_impl() -> String {
    let addr = default_server();
    let j = serde_json::json!({ "s": addr }).to_string();
    format!("SV1.{}", STANDARD.encode(j.as_bytes()))
}

#[tauri::command]
pub async fn sv_connect_code(code: String, password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sv_connect_code_impl(code, password)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn sv_conn_status() -> bool {
    sv_conn_status_impl()
}
#[tauri::command]
pub fn sv_make_conn_code() -> String {
    sv_make_conn_code_impl()
}

pub fn sv_renew_license_impl(
    server: String,
    login: String,
    password: String,
    license_code: String,
) -> Result<LicenseInfo, String> {
    let info = license::verify(&license_code)?;
    if !info.valid {
        return Err(info.reason);
    }
    let server = server.trim().trim_end_matches('/').to_string();
    let (enc_key, mut v) = fetch_vault(&server, login.trim(), &password)?;
    v.license = license_code;
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    // auth_token снова выводим из пароля+соли (повторный fetch дал бы соль; упрощённо — повторный вход)
    let c = http()?;
    let sv: serde_json::Value = c
        .get(format!("{server}/auth/salt?login={}", login.trim()))
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let (_e, auth_token) = derive(&password, &salt)?;
    let resp = c
        .post(format!("{server}/auth/vault"))
        .json(&serde_json::json!({
            "login": login.trim(),
            "auth_token": STANDARD.encode(auth_token),
            "enc_vault": STANDARD.encode(&enc_vault),
        }))
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err("не удалось обновить".into());
    }
    Ok(info)
}

// auth_token + организация для логина по паролю (авторизация операций мастера)
fn auth_token_and_org(
    c: &reqwest::blocking::Client,
    server: &str,
    login: &str,
    password: &str,
) -> Result<([u8; 32], String), String> {
    let resp = c
        .get(format!("{server}/auth/salt?login={login}"))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("Аккаунт не найден".into());
    }
    let sv: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let org = sv["org"].as_str().unwrap_or("").to_string();
    let (_enc, tok) = derive(password, &salt)?;
    Ok((tok, org))
}

#[derive(Serialize)]
pub struct ProfileRow {
    pub login: String,
    pub role: String,
    pub org: String,
    pub created_at: String,
    pub revoked: bool,
}

pub fn sv_create_profile_impl(
    master_login: String,
    master_password: String,
    org: String,
    login: String,
    password: String,
    role: String,
    perms: Vec<String>,
) -> Result<ProfileRow, String> {
    if login.trim().is_empty() {
        return Err("Укажите логин".into());
    }
    if password.len() < 6 {
        return Err("Пароль не короче 6 символов".into());
    }
    if role.trim().is_empty() || role == "master" {
        return Err("Недопустимая роль".into());
    }
    let server = default_server();
    let c = http()?;
    let (master_tok, master_org) = auth_token_and_org(&c, &server, master_login.trim(), &master_password)?;
    let org = if org.trim().is_empty() { master_org } else { org.trim().to_string() };
    let salt: [u8; 16] = rand::random();
    let (enc_key, auth_token) = derive(&password, &salt)?;
    let (dsec, dpub) = crate::crypto::generate();
    let v = Vault {
        org: org.clone(),
        server: server.clone(),
        role: role.clone(),
        ca_cert: String::new(),
        ca_key: String::new(),
        master_secret: dsec,
        master_public: dpub.clone(),
        login: login.trim().to_string(),
        license: String::new(),
        profiles: vec![],
        roles: vec![],
        orgs: vec![],
        me_name: String::new(),
        me_company: String::new(),
        my_perms: perms.clone(),
    };
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    let see_all = perms.iter().any(|p| p == "view_all");
    let body = serde_json::json!({
        "master_login": master_login.trim(),
        "master_auth_token": STANDARD.encode(master_tok),
        "org": org,
        "login": login.trim(),
        "role": role,
        "salt": STANDARD.encode(salt),
        "auth_token": STANDARD.encode(auth_token),
        "enc_vault": STANDARD.encode(&enc_vault),
        "pub_key": dpub,
        "perms": perms,
        "see_all": see_all,
    });
    let resp = c
        .post(format!("{server}/auth/create_account"))
        .json(&body)
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка создания".into()));
    }
    Ok(ProfileRow {
        login: login.trim().to_string(),
        role,
        org,
        created_at: String::new(),
        revoked: false,
    })
}

pub fn sv_list_profiles_impl(
    master_login: String,
    master_password: String,
) -> Result<Vec<ProfileRow>, String> {
    let server = default_server();
    let c = http()?;
    let (master_tok, _org) = auth_token_and_org(&c, &server, master_login.trim(), &master_password)?;
    let resp = c
        .post(format!("{server}/auth/accounts"))
        .json(&serde_json::json!({
            "master_login": master_login.trim(),
            "master_auth_token": STANDARD.encode(master_tok),
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    let arr: Vec<serde_json::Value> = resp.json().map_err(|e| e.to_string())?;
    Ok(arr
        .into_iter()
        .map(|j| ProfileRow {
            login: j["login"].as_str().unwrap_or("").to_string(),
            role: j["role"].as_str().unwrap_or("").to_string(),
            org: j["org"].as_str().unwrap_or("").to_string(),
            created_at: j["created_at"].as_str().unwrap_or("").to_string(),
            revoked: j["revoked"].as_bool().unwrap_or(false),
        })
        .collect())
}

// мастер сбрасывает пароль профиля: перевыдаёт ячейку с новым паролем (org/role сохраняются)
pub fn sv_reset_profile_password_impl(
    master_login: String,
    master_password: String,
    login: String,
    org: String,
    role: String,
    new_password: String,
    perms: Vec<String>,
) -> Result<(), String> {
    if new_password.len() < 6 {
        return Err("Пароль не короче 6 символов".into());
    }
    let server = default_server();
    let c = http()?;
    let (master_tok, _mo) = auth_token_and_org(&c, &server, master_login.trim(), &master_password)?;
    let salt: [u8; 16] = rand::random();
    let (enc_key, auth_token) = derive(&new_password, &salt)?;
    let (dsec, dpub) = crate::crypto::generate();
    let v = Vault {
        org,
        server: server.clone(),
        role,
        ca_cert: String::new(),
        ca_key: String::new(),
        master_secret: dsec,
        master_public: dpub.clone(),
        login: login.trim().to_string(),
        license: String::new(),
        profiles: vec![],
        roles: vec![],
        orgs: vec![],
        me_name: String::new(),
        me_company: String::new(),
        my_perms: perms.clone(),
    };
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    let see_all = perms.iter().any(|p| p == "view_all");
    let resp = c
        .post(format!("{server}/auth/reset_account"))
        .json(&serde_json::json!({
            "master_login": master_login.trim(),
            "master_auth_token": STANDARD.encode(master_tok),
            "login": login.trim(),
            "salt": STANDARD.encode(salt),
            "auth_token": STANDARD.encode(auth_token),
            "enc_vault": STANDARD.encode(&enc_vault),
            "pub_key": dpub,
            "perms": perms,
            "see_all": see_all,
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка сброса".into()));
    }
    Ok(())
}

pub fn sv_set_profile_revoked_impl(
    master_login: String,
    master_password: String,
    login: String,
    revoked: bool,
) -> Result<(), String> {
    let server = default_server();
    let c = http()?;
    let (master_tok, _mo) = auth_token_and_org(&c, &server, master_login.trim(), &master_password)?;
    let resp = c
        .post(format!("{server}/auth/revoke"))
        .json(&serde_json::json!({
            "master_login": master_login.trim(),
            "master_auth_token": STANDARD.encode(master_tok),
            "login": login.trim(),
            "revoked": revoked,
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    Ok(())
}

// добавить организацию в ячейку мастера
pub fn sv_add_org_impl(
    master_login: String,
    master_password: String,
    org: String,
) -> Result<Vec<String>, String> {
    let org = org.trim().to_string();
    if org.is_empty() {
        return Err("Укажите название".into());
    }
    let server = default_server();
    let (enc_key, mut v) = fetch_vault(&server, master_login.trim(), &master_password)?;
    if v.orgs.is_empty() {
        v.orgs.push(v.org.clone());
    }
    if v.orgs.iter().any(|o| o.eq_ignore_ascii_case(&org)) {
        return Err("Такая организация уже есть".into());
    }
    v.orgs.push(org.clone());
    let orgs = v.orgs.clone();
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    let c = http()?;
    let sv: serde_json::Value = c
        .get(format!("{server}/auth/salt?login={}", master_login.trim()))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let (_e, auth_token) = derive(&master_password, &salt)?;
    let resp = c
        .post(format!("{server}/auth/vault"))
        .json(&serde_json::json!({
            "login": master_login.trim(),
            "auth_token": STANDARD.encode(auth_token),
            "enc_vault": STANDARD.encode(&enc_vault),
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("Не удалось сохранить".into());
    }
    Ok(orgs)
}

pub fn sv_change_password_impl(
    login: String,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.len() < 6 {
        return Err("Новый пароль не короче 6 символов".into());
    }
    let server = default_server();
    let c = http()?;
    let resp = c
        .get(format!("{server}/auth/salt?login={}", login.trim()))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("Аккаунт не найден".into());
    }
    let sv: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let (enc_old, old_tok) = derive(&old_password, &salt)?;
    let lr = c
        .post(format!("{server}/auth/login"))
        .json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(old_tok)}))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !lr.status().is_success() {
        return Err("Неверный текущий пароль".into());
    }
    let lv: serde_json::Value = lr.json().map_err(|e| e.to_string())?;
    let enc_vault_old = STANDARD
        .decode(lv["enc_vault"].as_str().unwrap_or(""))
        .map_err(|_| "bad vault".to_string())?;
    let json = open_vault(&enc_vault_old, &enc_old)?;
    let v: Vault = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    let new_salt: [u8; 16] = rand::random();
    let (new_enc, new_tok) = derive(&new_password, &new_salt)?;
    let enc_vault_new = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &new_enc)?;
    let resp = c
        .post(format!("{server}/auth/change_password"))
        .json(&serde_json::json!({
            "login": login.trim(),
            "old_auth_token": STANDARD.encode(old_tok),
            "new_salt": STANDARD.encode(new_salt),
            "new_auth_token": STANDARD.encode(new_tok),
            "enc_vault": STANDARD.encode(&enc_vault_new),
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка смены пароля".into()));
    }
    Ok(())
}

// сохранить набор ролей/прав в ячейку мастера (обновить на сервере)
pub fn sv_save_roles_impl(
    master_login: String,
    master_password: String,
    roles: Vec<RoleDef>,
) -> Result<(), String> {
    let server = default_server();
    let (enc_key, mut v) = fetch_vault(&server, master_login.trim(), &master_password)?;
    v.roles = roles;
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    let c = http()?;
    let sv: serde_json::Value = c
        .get(format!("{server}/auth/salt?login={}", master_login.trim()))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let (_e, auth_token) = derive(&master_password, &salt)?;
    let resp = c
        .post(format!("{server}/auth/vault"))
        .json(&serde_json::json!({
            "login": master_login.trim(),
            "auth_token": STANDARD.encode(auth_token),
            "enc_vault": STANDARD.encode(&enc_vault),
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("Не удалось сохранить роли".into());
    }
    Ok(())
}

// сохранить данные мастера (имя, компания) в его ячейку
pub fn sv_save_me_impl(
    master_login: String,
    master_password: String,
    name: String,
    company: String,
) -> Result<(), String> {
    let server = default_server();
    let (enc_key, mut v) = fetch_vault(&server, master_login.trim(), &master_password)?;
    v.me_name = name.trim().to_string();
    v.me_company = company.trim().to_string();
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    let c = http()?;
    let sv: serde_json::Value = c
        .get(format!("{server}/auth/salt?login={}", master_login.trim()))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?
        .json()
        .map_err(|e| e.to_string())?;
    let salt = STANDARD
        .decode(sv["salt"].as_str().unwrap_or(""))
        .map_err(|_| "bad salt".to_string())?;
    let (_e, auth_token) = derive(&master_password, &salt)?;
    let resp = c
        .post(format!("{server}/auth/vault"))
        .json(&serde_json::json!({
            "login": master_login.trim(),
            "auth_token": STANDARD.encode(auth_token),
            "enc_vault": STANDARD.encode(&enc_vault),
        }))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("Не удалось сохранить".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn sv_save_me(master_login: String, master_password: String, name: String, company: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_save_me_impl(master_login, master_password, name, company))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct AuditEntry {
    pub action: String,
    pub target: String,
    pub org: String,
    pub at: String,
}
#[derive(Serialize)]
pub struct LogResult {
    pub entries: Vec<AuditEntry>,
    pub chain_ok: bool,
}

pub fn sv_log_impl(master_login: String, master_password: String) -> Result<LogResult, String> {
    let server = default_server();
    let c = http()?;
    let (master_tok, _mo) = auth_token_and_org(&c, &server, master_login.trim(), &master_password)?;
    let resp = c
        .post(format!("{server}/auth/log"))
        .json(&serde_json::json!({"master_login": master_login.trim(), "master_auth_token": STANDARD.encode(master_tok)}))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let entries = v["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|j| AuditEntry {
            action: j["action"].as_str().unwrap_or("").to_string(),
            target: j["target"].as_str().unwrap_or("").to_string(),
            org: j["org"].as_str().unwrap_or("").to_string(),
            at: j["at"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    Ok(LogResult {
        entries,
        chain_ok: v["chain_ok"].as_bool().unwrap_or(false),
    })
}

pub fn sv_rename_org_impl(master_login: String, master_password: String, old: String, new: String) -> Result<Vec<String>, String> {
    let old = old.trim().to_string();
    let new = new.trim().to_string();
    if new.is_empty() {
        return Err("Укажите название".into());
    }
    let server = default_server();
    let c = http()?;
    let (master_tok, _mo) = auth_token_and_org(&c, &server, master_login.trim(), &master_password)?;
    let resp = c
        .post(format!("{server}/auth/rename_org"))
        .json(&serde_json::json!({"master_login": master_login.trim(), "master_auth_token": STANDARD.encode(master_tok), "old": old, "new": new}))
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    let (enc_key, mut v) = fetch_vault(&server, master_login.trim(), &master_password)?;
    if v.orgs.is_empty() {
        v.orgs.push(v.org.clone());
    }
    for o in v.orgs.iter_mut() {
        if o.eq_ignore_ascii_case(&old) {
            *o = new.clone();
        }
    }
    if v.org.eq_ignore_ascii_case(&old) {
        v.org = new.clone();
    }
    let orgs = v.orgs.clone();
    let enc_vault = seal_vault(&serde_json::to_string(&v).map_err(|e| e.to_string())?, &enc_key)?;
    let sv: serde_json::Value = c
        .get(format!("{server}/auth/salt?login={}", master_login.trim()))
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let salt = STANDARD.decode(sv["salt"].as_str().unwrap_or("")).map_err(|_| "bad salt".to_string())?;
    let (_e, auth_token) = derive(&master_password, &salt)?;
    let r2 = c
        .post(format!("{server}/auth/vault"))
        .json(&serde_json::json!({"login": master_login.trim(), "auth_token": STANDARD.encode(auth_token), "enc_vault": STANDARD.encode(&enc_vault)}))
        .send()
        .map_err(|e| e.to_string())?;
    if !r2.status().is_success() {
        return Err("Не удалось сохранить".into());
    }
    Ok(orgs)
}

#[tauri::command]
pub async fn sv_log(master_login: String, master_password: String) -> Result<LogResult, String> {
    tauri::async_runtime::spawn_blocking(move || sv_log_impl(master_login, master_password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_rename_org(master_login: String, master_password: String, old: String, new: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || sv_rename_org_impl(master_login, master_password, old, new))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_license_status(code: String) -> Result<LicenseStatus, String> {
    tauri::async_runtime::spawn_blocking(move || sv_license_status_impl(code))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_prepare_master(license_code: String, org: String, login: String, password: String) -> Result<MasterDraft, String> {
    tauri::async_runtime::spawn_blocking(move || sv_prepare_master_impl(license_code, org, login, password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_check_server(server: String) -> Result<ServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || sv_check_server_impl(server))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_finish_master(server: String) -> Result<MasterInfo, String> {
    tauri::async_runtime::spawn_blocking(move || sv_finish_master_impl(server))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_login(login: String, password: String) -> Result<MasterInfo, String> {
    tauri::async_runtime::spawn_blocking(move || sv_login_impl(login, password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_renew_license(server: String, login: String, password: String, license_code: String) -> Result<LicenseInfo, String> {
    tauri::async_runtime::spawn_blocking(move || sv_renew_license_impl(server, login, password, license_code))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_create_profile(master_login: String, master_password: String, org: String, login: String, password: String, role: String, perms: Vec<String>) -> Result<ProfileRow, String> {
    tauri::async_runtime::spawn_blocking(move || sv_create_profile_impl(master_login, master_password, org, login, password, role, perms))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_reset_profile_password(master_login: String, master_password: String, login: String, org: String, role: String, new_password: String, perms: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_reset_profile_password_impl(master_login, master_password, login, org, role, new_password, perms))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_set_profile_revoked(master_login: String, master_password: String, login: String, revoked: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_set_profile_revoked_impl(master_login, master_password, login, revoked))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_add_org(master_login: String, master_password: String, org: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || sv_add_org_impl(master_login, master_password, org))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_list_profiles(master_login: String, master_password: String) -> Result<Vec<ProfileRow>, String> {
    tauri::async_runtime::spawn_blocking(move || sv_list_profiles_impl(master_login, master_password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_change_password(login: String, old_password: String, new_password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_change_password_impl(login, old_password, new_password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sv_save_roles(master_login: String, master_password: String, roles: Vec<RoleDef>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_save_roles_impl(master_login, master_password, roles))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct DirRec {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub size: i64,
    pub folder: String,
    pub comments: i64,
    pub at: String,
}

fn open_in_os(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", path]).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(path).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

// держит ли файл какой-либо процесс открытым
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn is_file_open(path: &str) -> bool {
    std::process::Command::new("lsof")
        .arg("--")
        .arg(path)
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}
#[cfg(target_os = "windows")]
fn is_file_open(path: &str) -> bool {
    // если не можем открыть на запись — значит файл занят программой
    std::fs::OpenOptions::new().write(true).open(path).is_err()
}

// затереть содержимое и удалить файл (best-effort, без гарантии на SSD из-за wear-leveling)
fn shred_file(path: &std::path::Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
            use std::io::Write;
            let zeros = [0u8; 65536];
            let mut left = meta.len();
            while left > 0 {
                let n = std::cmp::min(left, zeros.len() as u64) as usize;
                if f.write_all(&zeros[..n]).is_err() { break; }
                left -= n as u64;
            }
            let _ = f.sync_all();
        }
    }
    let _ = std::fs::remove_file(path);
}

// фоновый поток: дождаться, пока внешняя программа закроет файл, затем затереть его
fn watch_and_shred(path: String) {
    std::thread::spawn(move || {
        use std::time::{Duration, Instant};
        let p = std::path::PathBuf::from(&path);
        // фаза 1: ждём, пока программа реально откроет файл (до 90 с)
        let appear = Instant::now() + Duration::from_secs(90);
        let mut seen = false;
        while Instant::now() < appear {
            if !p.exists() { return; }
            if is_file_open(&path) { seen = true; break; }
            std::thread::sleep(Duration::from_secs(2));
        }
        // фаза 2: ждём, пока программа закроет файл (не дольше 4 часов)
        if seen {
            let deadline = Instant::now() + Duration::from_secs(4 * 60 * 60);
            while Instant::now() < deadline {
                if !p.exists() { return; }
                if !is_file_open(&path) {
                    std::thread::sleep(Duration::from_secs(2)); // не затирать между пересохранениями
                    if !is_file_open(&path) { break; }
                }
                std::thread::sleep(Duration::from_secs(5));
            }
        }
        shred_file(&p);
    });
}

pub fn sv_dir_submit_impl(login: String, password: String, folder: String, title: String, kind: String, content_b64: String) -> Result<String, String> {
    let server = default_server();
    let c = http()?;
    let (_enc, v) = fetch_vault(&server, login.trim(), &password)?;
    if v.master_public.is_empty() {
        return Err("У профиля нет ключа шифрования".into());
    }
    let data = STANDARD.decode(content_b64.trim()).map_err(|_| "bad content".to_string())?;
    let (tok, _org) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let mut recips = recipients_for(&c, &server, login.trim(), STANDARD.encode(&tok), "");
    if !recips.iter().any(|p| p == &v.master_public) {
        recips.push(v.master_public.clone());
    }
    let ct = crate::crypto::encrypt(&data, &recips)?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("login", login.trim().to_string())
        .text("auth_token", STANDARD.encode(tok))
        .text("folder", folder)
        .text("title", title)
        .text("kind", kind)
        .part("file", reqwest::blocking::multipart::Part::bytes(ct).file_name("blob"));
    let resp = c.post(format!("{server}/data/submit")).multipart(form).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка отправки".into()));
    }
    let j: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    Ok(j["id"].as_str().unwrap_or("").to_string())
}

pub fn sv_dir_list_impl(login: String, password: String) -> Result<Vec<DirRec>, String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/list")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok)})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    let arr: Vec<serde_json::Value> = resp.json().map_err(|e| e.to_string())?;
    Ok(arr.into_iter().map(|j| DirRec {
        id: j["id"].as_str().unwrap_or("").to_string(),
        kind: j["kind"].as_str().unwrap_or("").to_string(),
        name: j["name"].as_str().unwrap_or("").to_string(),
        size: j["size"].as_i64().unwrap_or(0),
        folder: j["folder"].as_str().unwrap_or("").to_string(),
        comments: j["comments"].as_i64().unwrap_or(0),
        at: j["at"].as_str().unwrap_or("").to_string(),
    }).collect())
}

fn dir_fetch_bytes(login: &str, password: &str, id: &str) -> Result<Vec<u8>, String> {
    let server = default_server();
    let c = http()?;
    let (_enc, v) = fetch_vault(&server, login.trim(), password)?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), password)?;
    let resp = c.post(format!("{server}/data/blob")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "id": id})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("не удалось скачать".into());
    }
    let ct = resp.bytes().map_err(|e| e.to_string())?.to_vec();
    crate::crypto::decrypt(&ct, v.master_secret.trim())
}

// текстовый отчёт: вернуть содержимое (base64 открытого текста)
pub fn sv_dir_open_impl(login: String, password: String, id: String) -> Result<String, String> {
    let pt = dir_fetch_bytes(login.trim(), &password, id.trim())?;
    Ok(STANDARD.encode(pt))
}

// файл: расшифровать во временный файл и открыть в нативной программе
pub fn sv_dir_open_file_impl(login: String, password: String, id: String, filename: String) -> Result<String, String> {
    let pt = dir_fetch_bytes(login.trim(), &password, id.trim())?;
    let safe: String = filename.chars().filter(|c| !"/\\:".contains(*c)).collect();
    let safe = if safe.trim().is_empty() { "file".to_string() } else { safe };
    let mut path = std::env::temp_dir();
    path.push(format!("securevault-{}-{}", id.trim(), safe));
    std::fs::write(&path, &pt).map_err(|e| e.to_string())?;
    let p = path.to_string_lossy().to_string();
    open_in_os(&p)?;
    watch_and_shred(p.clone());
    Ok(p)
}

pub fn sv_dir_delete_impl(login: String, password: String, id: String) -> Result<(), String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/delete")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "id": id.trim()})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn sv_dir_submit(login: String, password: String, folder: String, title: String, kind: String, content_b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_submit_impl(login, password, folder, title, kind, content_b64)).await.map_err(|e| e.to_string())?
}

pub fn sv_dir_folders_impl(login: String, password: String) -> Result<Vec<String>, String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/folders")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok)})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    resp.json::<Vec<String>>().map_err(|e| e.to_string())
}

pub fn sv_dir_mkfolder_impl(login: String, password: String, path: String) -> Result<(), String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/mkfolder")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "path": path})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn sv_dir_folders(login: String, password: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_folders_impl(login, password)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_dir_mkfolder(login: String, password: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_mkfolder_impl(login, password, path)).await.map_err(|e| e.to_string())?
}

pub fn sv_cat_list_impl(login: String, password: String, org: String) -> Result<Vec<String>, String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/folders")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "org": org})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    resp.json::<Vec<String>>().map_err(|e| e.to_string())
}

pub fn sv_cat_make_impl(login: String, password: String, org: String, path: String) -> Result<(), String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/mkfolder")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "org": org, "path": path})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn sv_cat_list(login: String, password: String, org: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || sv_cat_list_impl(login, password, org)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_cat_make(login: String, password: String, org: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_cat_make_impl(login, password, org, path)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_dir_list(login: String, password: String) -> Result<Vec<DirRec>, String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_list_impl(login, password)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_dir_open(login: String, password: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_open_impl(login, password, id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_dir_open_file(login: String, password: String, id: String, filename: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_open_file_impl(login, password, id, filename)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_dir_delete(login: String, password: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sv_dir_delete_impl(login, password, id)).await.map_err(|e| e.to_string())?
}

pub fn sv_save_file_impl(filename: String, content_b64: String) -> Result<String, String> {
    let bytes = STANDARD.decode(content_b64.trim()).map_err(|_| "bad content".to_string())?;
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|e| e.to_string())?;
    let safe: String = filename.chars().filter(|c| !"/\\:".contains(*c)).collect();
    let safe = if safe.trim().is_empty() { "file".to_string() } else { safe };
    let dir = format!("{home}/Downloads");
    let _ = std::fs::create_dir_all(&dir);
    let path = format!("{dir}/{safe}");
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn sv_save_file(filename: String, content_b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sv_save_file_impl(filename, content_b64)).await.map_err(|e| e.to_string())?
}

// ===== Проверяющий (reviewer) и комментарии =====

// публичные ключи получателей шифрования для записи владельца owner (пусто = сам login)
fn recipients_for(c: &reqwest::blocking::Client, server: &str, login: &str, auth_tok_b64: String, owner: &str) -> Vec<String> {
    let resp = c.post(format!("{server}/data/recipients"))
        .json(&serde_json::json!({"login": login, "auth_token": auth_tok_b64, "owner_login": owner}))
        .send();
    if let Ok(r) = resp {
        if r.status().is_success() {
            if let Ok(v) = r.json::<Vec<String>>() {
                return v;
            }
        }
    }
    vec![]
}

#[derive(Serialize)]
pub struct RvProfile {
    pub login: String,
    pub count: i64,
    pub last_at: String,
    pub revoked: bool,
}

#[derive(Serialize)]
pub struct RvRec {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub size: i64,
    pub folder: String,
    pub submitter: String,
    pub comments: i64,
    pub at: String,
}

#[derive(Serialize)]
pub struct RvRecent {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub owner_login: String,
    pub submitter: String,
    pub folder: String,
    pub at: String,
}

#[derive(Serialize)]
pub struct Comment {
    pub author: String,
    pub text: String,
    pub at: String,
}

fn rv_post_array(path: &str, login: &str, password: &str, extra: serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), password)?;
    let mut body = serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok)});
    if let (Some(obj), Some(ex)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in ex {
            obj.insert(k.clone(), v.clone());
        }
    }
    let resp = c.post(format!("{server}{path}")).json(&body).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    resp.json::<Vec<serde_json::Value>>().map_err(|e| e.to_string())
}

pub fn rv_profiles_impl(login: String, password: String) -> Result<Vec<RvProfile>, String> {
    let arr = rv_post_array("/data/reviewer/profiles", &login, &password, serde_json::json!({}))?;
    Ok(arr.into_iter().map(|j| RvProfile {
        login: j["login"].as_str().unwrap_or("").to_string(),
        count: j["count"].as_i64().unwrap_or(0),
        last_at: j["last_at"].as_str().unwrap_or("").to_string(),
        revoked: j["revoked"].as_bool().unwrap_or(false),
    }).collect())
}

pub fn rv_list_impl(login: String, password: String, owner: String) -> Result<Vec<RvRec>, String> {
    let arr = rv_post_array("/data/reviewer/list", &login, &password, serde_json::json!({"owner_login": owner.trim()}))?;
    Ok(arr.into_iter().map(|j| RvRec {
        id: j["id"].as_str().unwrap_or("").to_string(),
        kind: j["kind"].as_str().unwrap_or("").to_string(),
        name: j["name"].as_str().unwrap_or("").to_string(),
        size: j["size"].as_i64().unwrap_or(0),
        folder: j["folder"].as_str().unwrap_or("").to_string(),
        submitter: j["submitter"].as_str().unwrap_or("").to_string(),
        comments: j["comments"].as_i64().unwrap_or(0),
        at: j["at"].as_str().unwrap_or("").to_string(),
    }).collect())
}

pub fn rv_recent_impl(login: String, password: String) -> Result<Vec<RvRecent>, String> {
    let arr = rv_post_array("/data/reviewer/recent", &login, &password, serde_json::json!({}))?;
    Ok(arr.into_iter().map(|j| RvRecent {
        id: j["id"].as_str().unwrap_or("").to_string(),
        kind: j["kind"].as_str().unwrap_or("").to_string(),
        name: j["name"].as_str().unwrap_or("").to_string(),
        owner_login: j["owner_login"].as_str().unwrap_or("").to_string(),
        submitter: j["submitter"].as_str().unwrap_or("").to_string(),
        folder: j["folder"].as_str().unwrap_or("").to_string(),
        at: j["at"].as_str().unwrap_or("").to_string(),
    }).collect())
}

// расшифровка любой записи организации ключом проверяющего
fn rv_fetch_bytes(login: &str, password: &str, id: &str) -> Result<Vec<u8>, String> {
    let server = default_server();
    let c = http()?;
    let (_enc, v) = fetch_vault(&server, login.trim(), password)?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), password)?;
    let resp = c.post(format!("{server}/data/reviewer/blob")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "id": id})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err("не удалось скачать".into());
    }
    let ct = resp.bytes().map_err(|e| e.to_string())?.to_vec();
    crate::crypto::decrypt(&ct, v.master_secret.trim())
}

pub fn rv_open_impl(login: String, password: String, id: String) -> Result<String, String> {
    let pt = rv_fetch_bytes(login.trim(), &password, id.trim())?;
    Ok(STANDARD.encode(pt))
}

pub fn rv_open_file_impl(login: String, password: String, id: String, filename: String) -> Result<String, String> {
    let pt = rv_fetch_bytes(login.trim(), &password, id.trim())?;
    let safe: String = filename.chars().filter(|c| !"/\\:".contains(*c)).collect();
    let safe = if safe.trim().is_empty() { "file".to_string() } else { safe };
    let mut path = std::env::temp_dir();
    path.push(format!("securevault-{}-{}", id.trim(), safe));
    std::fs::write(&path, &pt).map_err(|e| e.to_string())?;
    let p = path.to_string_lossy().to_string();
    open_in_os(&p)?;
    watch_and_shred(p.clone());
    Ok(p)
}

pub fn rv_submit_impl(login: String, password: String, owner: String, folder: String, title: String, kind: String, content_b64: String) -> Result<String, String> {
    let server = default_server();
    let c = http()?;
    let data = STANDARD.decode(content_b64.trim()).map_err(|_| "bad content".to_string())?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let recips = recipients_for(&c, &server, login.trim(), STANDARD.encode(&tok), owner.trim());
    if recips.is_empty() {
        return Err("Нет получателей шифрования".into());
    }
    let ct = crate::crypto::encrypt(&data, &recips)?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("login", login.trim().to_string())
        .text("auth_token", STANDARD.encode(tok))
        .text("owner_login", owner.trim().to_string())
        .text("folder", folder)
        .text("title", title)
        .text("kind", kind)
        .part("file", reqwest::blocking::multipart::Part::bytes(ct).file_name("blob"));
    let resp = c.post(format!("{server}/data/reviewer/submit")).multipart(form).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка отправки".into()));
    }
    let j: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    Ok(j["id"].as_str().unwrap_or("").to_string())
}

pub fn rv_delete_impl(login: String, password: String, id: String) -> Result<(), String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/reviewer/delete")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "id": id.trim()})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    Ok(())
}

// комментарии (работают для директора и проверяющего — расшифровка своим ключом)
pub fn cm_list_impl(login: String, password: String, record_id: String) -> Result<Vec<Comment>, String> {
    let server = default_server();
    let c = http()?;
    let (_enc, v) = fetch_vault(&server, login.trim(), &password)?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let resp = c.post(format!("{server}/data/comments")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "record_id": record_id.trim()})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    let arr: Vec<serde_json::Value> = resp.json().map_err(|e| e.to_string())?;
    let mut out = vec![];
    for j in arr {
        let author = j["author"].as_str().unwrap_or("").to_string();
        let at = j["at"].as_str().unwrap_or("").to_string();
        let blob_b64 = j["blob"].as_str().unwrap_or("");
        let text = match STANDARD.decode(blob_b64) {
            Ok(ct) => match crate::crypto::decrypt(&ct, v.master_secret.trim()) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                Err(_) => "[не удалось расшифровать]".to_string(),
            },
            Err(_) => "[повреждён]".to_string(),
        };
        out.push(Comment { author, text, at });
    }
    Ok(out)
}

pub fn cm_add_impl(login: String, password: String, record_id: String, owner: String, text: String) -> Result<(), String> {
    let server = default_server();
    let c = http()?;
    let (tok, _o) = auth_token_and_org(&c, &server, login.trim(), &password)?;
    let recips = recipients_for(&c, &server, login.trim(), STANDARD.encode(&tok), owner.trim());
    if recips.is_empty() {
        return Err("Нет получателей шифрования".into());
    }
    let ct = crate::crypto::encrypt(text.as_bytes(), &recips)?;
    let resp = c.post(format!("{server}/data/comment_add")).json(&serde_json::json!({"login": login.trim(), "auth_token": STANDARD.encode(tok), "record_id": record_id.trim(), "blob": STANDARD.encode(ct)})).send().map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().unwrap_or_else(|_| "ошибка".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn sv_rv_profiles(login: String, password: String) -> Result<Vec<RvProfile>, String> {
    tauri::async_runtime::spawn_blocking(move || rv_profiles_impl(login, password)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_rv_list(login: String, password: String, owner: String) -> Result<Vec<RvRec>, String> {
    tauri::async_runtime::spawn_blocking(move || rv_list_impl(login, password, owner)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_rv_recent(login: String, password: String) -> Result<Vec<RvRecent>, String> {
    tauri::async_runtime::spawn_blocking(move || rv_recent_impl(login, password)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_rv_open(login: String, password: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || rv_open_impl(login, password, id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_rv_open_file(login: String, password: String, id: String, filename: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || rv_open_file_impl(login, password, id, filename)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_rv_submit(login: String, password: String, owner: String, folder: String, title: String, kind: String, content_b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || rv_submit_impl(login, password, owner, folder, title, kind, content_b64)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_rv_delete(login: String, password: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rv_delete_impl(login, password, id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_cm_list(login: String, password: String, record_id: String) -> Result<Vec<Comment>, String> {
    tauri::async_runtime::spawn_blocking(move || cm_list_impl(login, password, record_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sv_cm_add(login: String, password: String, record_id: String, owner: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cm_add_impl(login, password, record_id, owner, text)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct MyLogEnt {
    pub action: String,
    pub target: String,
    pub at: String,
}

pub fn mylog_impl(login: String, password: String) -> Result<Vec<MyLogEnt>, String> {
    let arr = rv_post_array("/data/mylog", &login, &password, serde_json::json!({}))?;
    Ok(arr.into_iter().map(|j| MyLogEnt {
        action: j["action"].as_str().unwrap_or("").to_string(),
        target: j["target"].as_str().unwrap_or("").to_string(),
        at: j["at"].as_str().unwrap_or("").to_string(),
    }).collect())
}

#[tauri::command]
pub async fn sv_mylog(login: String, password: String) -> Result<Vec<MyLogEnt>, String> {
    tauri::async_runtime::spawn_blocking(move || mylog_impl(login, password)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_roundtrip() {
        let salt: [u8; 16] = [7u8; 16];
        let (enc, tok) = derive("secret123", &salt).unwrap();
        let (enc2, tok2) = derive("secret123", &salt).unwrap();
        assert_eq!(enc, enc2);
        assert_eq!(tok, tok2);
        let (enc_bad, _) = derive("other", &salt).unwrap();
        assert_ne!(enc, enc_bad);
        let sealed = seal_vault("{\"org\":\"X\"}", &enc).unwrap();
        assert_eq!(open_vault(&sealed, &enc).unwrap(), "{\"org\":\"X\"}");
        assert!(open_vault(&sealed, &enc_bad).is_err());
        let (c, k) = gen_ca("X").unwrap();
        assert!(c.contains("BEGIN CERTIFICATE") && k.contains("PRIVATE KEY"));
    }

    #[test]
    #[ignore]
    fn live_server_auth() {
        let server = std::env::var("SV_SERVER").unwrap();
        let lic = std::env::var("SV_LIC").unwrap();
        let login = format!("m{}", std::process::id());
        let draft = sv_prepare_master_impl(lic.clone(), "Орг Тест".into(), login.clone(), "secret123".into()).unwrap();
        println!("prepared org={} (локально)", draft.org);
        let chk = sv_check_server_impl(server.clone()).unwrap();
        println!("check #1: {} v{} license_used={}", chk.service, chk.version, chk.license_used);
        assert!(!chk.license_used, "свежая лицензия не должна быть использована");
        let info = sv_finish_master_impl(server.clone()).unwrap();
        println!("finished org={} role={} (лицензия активирована глобально)", info.org, info.role);
        let info2 = sv_login_impl(login.clone(), "secret123".into()).unwrap();
        println!("login org={} role={}", info2.org, info2.role);
        assert_eq!(info.org, info2.org);

        // повтор тем же кодом на том же сервере, другой логин
        let draft2 = sv_prepare_master_impl(lic.clone(), "Орг Тест".into(), format!("{login}b"), "secret123".into()).unwrap();
        let chk2 = sv_check_server_impl(server.clone()).unwrap();
        println!("check #2 (тот же код): license_used={}", chk2.license_used);
        assert!(chk2.license_used, "после активации код должен быть занят глобально");
        let reused = sv_finish_master_impl(server.clone());
        println!("повторная активация => {:?}", reused.err());
        assert!(draft2.org == info.org);
    }

    #[test]
    #[ignore]
    fn live_profiles() {
        let server = std::env::var("SV_SERVER").unwrap();
        let lic = std::env::var("SV_LIC").unwrap();
        let ml = format!("m{}", std::process::id());
        sv_prepare_master_impl(lic, "Орг Тест".into(), ml.clone(), "masterpass".into()).unwrap();
        sv_check_server_impl(server.clone()).unwrap();
        sv_finish_master_impl(server.clone()).unwrap();
        let dlogin = format!("d{}", std::process::id());
        // создаём во второй организации
        sv_add_org_impl(ml.clone(), "masterpass".into(), "Орг Два".into()).unwrap();
        let p = sv_create_profile_impl(ml.clone(), "masterpass".into(), "Орг Два".into(), dlogin.clone(), "dirpass1".into(), "director".into(), vec!["submit".into(), "view_own".into()]).unwrap();
        println!("создан профиль {} role={} org={}", p.login, p.role, p.org);
        assert_eq!(p.org, "Орг Два");
        let list = sv_list_profiles_impl(ml.clone(), "masterpass".into()).unwrap();
        println!("профилей={} (org первого={})", list.len(), list[0].org);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].org, "Орг Два");
        let di = sv_login_impl(dlogin.clone(), "dirpass1".into()).unwrap();
        println!("вход директора org={} role={}", di.org, di.role);
        assert_eq!(di.org, "Орг Два");
        // мастер сбрасывает пароль профиля
        sv_reset_profile_password_impl(ml.clone(), "masterpass".into(), dlogin.clone(), "Орг Два".into(), "director".into(), "newpass9".into(), vec!["submit".into(), "view_own".into()]).unwrap();
        let di2 = sv_login_impl(dlogin.clone(), "newpass9".into()).unwrap();
        println!("вход после сброса пароля мастером: org={}", di2.org);
        assert_eq!(di2.role, "director");
        // директор сдаёт зашифрованный отчёт и открывает его
        {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            sv_dir_mkfolder_impl(dlogin.clone(), "newpass9".into(), "Отчёты/2026".into()).unwrap();
            let fl = sv_dir_folders_impl(dlogin.clone(), "newpass9".into()).unwrap();
            println!("папки: {:?}", fl);
            assert!(fl.iter().any(|f| f == "Отчёты/2026"));
            let rid = sv_dir_submit_impl(dlogin.clone(), "newpass9".into(), "Отчёты/2026".into(), "Отчёт недели".into(), "report".into(), B64.encode("Выручка 812000")).unwrap();
            let recs = sv_dir_list_impl(dlogin.clone(), "newpass9".into()).unwrap();
            assert!(recs.iter().any(|r| r.folder == "Отчёты/2026"));
            let opened = sv_dir_open_impl(dlogin.clone(), "newpass9".into(), rid.clone()).unwrap();
            let text = String::from_utf8(B64.decode(opened).unwrap()).unwrap();
            println!("отчёт: записей={}, расшифровано='{}'", recs.len(), text);
            assert!(recs.iter().any(|r| r.id == rid) && text.contains("812000"));
        }
        // мастер отзывает профиль -> вход закрыт
        sv_set_profile_revoked_impl(ml.clone(), "masterpass".into(), dlogin.clone(), true).unwrap();
        let revoked_login = sv_login_impl(dlogin.clone(), "newpass9".into());
        println!("после отзыва вход => {}", if revoked_login.is_err() { "закрыт ✓" } else { "ОТКРЫТ ✗" });
        assert!(revoked_login.is_err());
        // переименование организации
        let orgs = sv_rename_org_impl(ml.clone(), "masterpass".into(), "Орг Два".into(), "Орг Два+".into()).unwrap();
        println!("организации после переименования: {:?}", orgs);
        assert!(orgs.iter().any(|o| o == "Орг Два+"));
        // журнал: должны быть записи, цепочка цела
        let log = sv_log_impl(ml.clone(), "masterpass".into()).unwrap();
        println!("журнал: {} записей, цепочка_ок={}", log.entries.len(), log.chain_ok);
        assert!(log.entries.len() >= 4 && log.chain_ok);
    }
}

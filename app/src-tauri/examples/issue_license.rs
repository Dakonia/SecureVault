use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("использование: issue_license <компания> [perpetual|sub] [дней]");
        std::process::exit(1);
    }
    let org = args[1].clone();
    let kind = args.get(2).cloned().unwrap_or_else(|| "perpetual".into());
    let days: i64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let exp = if kind == "sub" { now + days * 86400 } else { 0 };
    let id = hex::encode(rand::random::<[u8; 8]>());
    let payload = format!("{{\"org\":\"{org}\",\"kind\":\"{kind}\",\"exp\":{exp},\"id\":\"{id}\"}}");

    let home = std::env::var("HOME").unwrap();
    let h = std::fs::read_to_string(format!("{home}/.securevault-vendor/vendor.key"))
        .expect("нет vendor.key — сначала запусти vendor_keygen");
    let arr: [u8; 32] = hex::decode(h.trim()).unwrap().try_into().unwrap();
    let sk = SigningKey::from_bytes(&arr);
    let sig = sk.sign(payload.as_bytes());
    let code = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload.as_bytes()),
        URL_SAFE_NO_PAD.encode(sig.to_bytes())
    );
    println!("{code}");
}

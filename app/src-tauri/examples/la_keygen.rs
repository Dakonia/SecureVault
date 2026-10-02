use ed25519_dalek::SigningKey;

fn main() {
    let home = std::env::var("HOME").unwrap();
    let dir = format!("{home}/.securevault-la");
    std::fs::create_dir_all(&dir).unwrap();
    let path = format!("{dir}/la.key");
    let sk = if let Ok(h) = std::fs::read_to_string(&path) {
        let arr: [u8; 32] = hex::decode(h.trim()).unwrap().try_into().unwrap();
        SigningKey::from_bytes(&arr)
    } else {
        let bytes: [u8; 32] = rand::random();
        let sk = SigningKey::from_bytes(&bytes);
        std::fs::write(&path, hex::encode(sk.to_bytes())).unwrap();
        println!("(создан секретный ключ сервера лицензий: {path})");
        sk
    };
    println!("LA_PUBLIC_HEX={}", hex::encode(sk.verifying_key().to_bytes()));
}

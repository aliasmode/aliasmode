use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs};

fn decoded_text(value: &str) -> Result<String, Box<dyn Error>> {
    Ok(String::from_utf8(STANDARD.decode(value.trim())?)?)
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let installer = args.next().ok_or("installer path is required")?;
    let signature = args.next().ok_or("signature path is required")?;
    let public_key = args.next().ok_or("public key is required")?;
    if args.next().is_some() {
        return Err("unexpected arguments".into());
    }

    let public_key = PublicKey::decode(&decoded_text(&public_key)?)?;
    let signature = Signature::decode(&decoded_text(&fs::read_to_string(signature)?)?)?;
    public_key.verify(&fs::read(installer)?, &signature, true)?;
    Ok(())
}

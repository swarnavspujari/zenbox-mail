//! Dev utility: seed or check ZenBox keychain entries without launching the
//! app. Values come from the ZENBOX_SECRET_VALUE env var — never from argv,
//! never printed — so secrets stay out of shell history and logs.
//!
//!   ZENBOX_SECRET_VALUE=... cargo run --bin dev-secrets -- set ai:nim
//!   cargo run --bin dev-secrets -- check ai:nim
//!   cargo run --bin dev-secrets -- delete ai:nim

const SERVICE: &str = "ZenBoxMail";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, name) = match (args.get(1), args.get(2)) {
        (Some(c), Some(n)) => (c.as_str(), n.as_str()),
        _ => {
            eprintln!("usage: dev-secrets <set|check|delete> <entry-name>");
            std::process::exit(2);
        }
    };
    let entry = keyring::Entry::new(SERVICE, name).expect("keychain unavailable");
    match cmd {
        "set" => {
            let value = std::env::var("ZENBOX_SECRET_VALUE")
                .expect("ZENBOX_SECRET_VALUE env var not set");
            entry.set_password(value.trim()).expect("could not write to keychain");
            println!("stored {name} ({} chars)", value.trim().len());
        }
        "check" => match entry.get_password() {
            Ok(v) => println!("{name}: present ({} chars)", v.len()),
            Err(_) => {
                println!("{name}: missing");
                std::process::exit(1);
            }
        },
        "delete" => {
            let _ = entry.delete_credential();
            println!("deleted {name}");
        }
        _ => {
            eprintln!("unknown command {cmd}");
            std::process::exit(2);
        }
    }
}

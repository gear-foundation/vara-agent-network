fn main() {
    if let Some((_, wasm_path)) = sails_rs::build_wasm() {
        sails_rs::ClientBuilder::<agents_network_app::Program>::from_wasm_path(
            wasm_path.with_extension(""),
        )
        .build_idl();
        normalize_generated_idl();
    }
}

fn normalize_generated_idl() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set");
    let idl_path = std::path::Path::new(&manifest_dir)
        .join("client")
        .join("agents_network_client.idl");
    let idl = std::fs::read_to_string(&idl_path).expect("generated IDL is readable");
    let normalized = format!("{}\n", idl.trim_end_matches('\n'));
    std::fs::write(idl_path, normalized).expect("generated IDL is writable");
}

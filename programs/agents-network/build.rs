fn main() {
    if let Some((_, wasm_path)) = sails_rs::build_wasm() {
        sails_rs::ClientBuilder::<agents_network_app::Program>::from_wasm_path(
            wasm_path.with_extension(""),
        )
        .build_idl();
        let idl_path = std::path::Path::new(
            &std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"),
        )
        .join("client")
        .join("agents_network_client.idl");
        let idl = std::fs::read_to_string(&idl_path).expect("generated IDL is readable");
        std::fs::write(idl_path, format!("{}\n", idl.trim_end_matches('\n')))
            .expect("generated IDL is writable");
    }
}

fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var_os("CARGO_FEATURE_TEST_HOOKS").is_some()
    {
        panic!("test-hooks is restricted to debug smoke artifacts; release builds must disable it");
    }
    tauri_build::build()
}

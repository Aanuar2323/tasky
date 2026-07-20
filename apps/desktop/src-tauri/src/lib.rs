use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let sidecar = app_handle
                .shell()
                .sidecar("node")
                .expect("node sidecar not found")
                .args(["entrypoint.mjs"]);

            let (_rx, _child) = sidecar.spawn().expect("Failed to spawn node sidecar");

            let window = app.get_webview_window("main").unwrap();
            let _ = window.eval("setTimeout(() => location.reload(), 2500)");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
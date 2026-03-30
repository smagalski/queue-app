use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
fn get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_version])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn check_for_updates(app: tauri::AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return };

    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_else(|| "No release notes.".to_string());

    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(format!("{}\n\nInstall and restart now?", notes))
        .title(format!("Queue {} Available", version))
        .buttons(MessageDialogButtons::OkCancelCustom("Install & Restart".into(), "Later".into()))
        .show(move |answer| { let _ = tx.send(answer); });
    let confirmed = rx.recv().unwrap_or(false);

    if confirmed {
        let _ = update.download_and_install(|_, _| {}, || {}).await;
        app.restart();
    }
}

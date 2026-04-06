use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tauri::command]
fn get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Binds a random local TCP port, waits for one HTTP request (the OAuth redirect),
/// writes a "you can close this tab" response, then emits the full redirect URL
/// as a Tauri event ("oauth-redirect") so the JS side can extract the auth code.
#[tauri::command]
async fn start_oauth_server(app: tauri::AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    tauri::async_runtime::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };

        let mut buf = vec![0u8; 4096];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);

        // Extract the request path from "GET /callback?code=... HTTP/1.1"
        let path = request
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("/");
        let redirect_url = format!("http://127.0.0.1:{}{}", port, path);

        // Send a friendly success page back to the browser
        let body = b"<!DOCTYPE html><html><head><meta charset='utf-8'>\
            <title>Queue \xe2\x80\x94 Signed In</title>\
            <style>body{font-family:-apple-system,sans-serif;text-align:center;\
            padding:80px 40px;background:#1a1a2e;color:#e0e0e0;}\
            h2{color:#a78bfa;margin-bottom:12px;}\
            p{color:#9ca3af;}</style></head>\
            <body><h2>\xe2\x9c\x93 Signed in successfully!</h2>\
            <p>You can close this tab and return to Queue.</p></body></html>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;

        // Notify the JS side with the full redirect URL so it can extract ?code=
        let _ = app.emit("oauth-redirect", redirect_url);
    });

    Ok(port)
}

/// Opens a URL in the user's default system browser.
#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_version,
            start_oauth_server,
            open_in_browser
        ])
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

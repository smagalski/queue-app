use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tauri::command]
fn get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

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
        let Ok((mut stream, _)) = listener.accept().await else { return };
        let mut buf = vec![0u8; 4096];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let path = request
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("/");
        let redirect_url = format!("http://127.0.0.1:{}{}", port, path);
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
        let _ = app.emit("oauth-redirect", redirect_url);
    });
    Ok(port)
}

#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

/// Creates or shows the always-on-top overlay window.
/// `x` / `y` are logical (point) coordinates; pass None to use the default top-left position.
#[tauri::command]
fn show_overlay(app: tauri::AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        // Restore saved position if provided
        if let (Some(px), Some(py)) = (x, y) {
            let scale = overlay.scale_factor().unwrap_or(1.0);
            let phys_x = (px * scale) as i32;
            let phys_y = (py * scale) as i32;
            overlay
                .set_position(tauri::PhysicalPosition::new(phys_x, phys_y))
                .ok();
        }
        overlay.show().map_err(|e| e.to_string())?;
    } else {
        let pos_x = x.unwrap_or(20.0);
        let pos_y = y.unwrap_or(28.0);
        let overlay = tauri::WebviewWindowBuilder::new(
            &app,
            "overlay",
            tauri::WebviewUrl::App("overlay.html".into()),
        )
        .title("")
        .inner_size(400.0, 400.0)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .resizable(true)
        .skip_taskbar(true)
        .position(pos_x, pos_y)
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

        // Apply macOS vibrancy (dark frosted glass behind the window)
        #[cfg(target_os = "macos")]
        {
            use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
            apply_vibrancy(
                &overlay,
                NSVisualEffectMaterial::HudWindow,
                Some(NSVisualEffectState::Active),
                Some(12.0),
            )
            .ok();
        }
    }
    Ok(())
}

/// Hides the overlay window.
#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the overlay's current logical (point) position so JS can persist it.
#[tauri::command]
fn get_overlay_position(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let phys = overlay.outer_position().map_err(|e| e.to_string())?;
        let scale = overlay.scale_factor().unwrap_or(1.0);
        Ok((phys.x as f64 / scale, phys.y as f64 / scale))
    } else {
        Ok((20.0, 28.0))
    }
}

/// Moves the overlay window by a physical-pixel delta (called on every mousemove).
#[tauri::command]
fn move_overlay_by(app: tauri::AppHandle, dx: i32, dy: i32) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let pos = overlay.outer_position().map_err(|e| e.to_string())?;
        overlay
            .set_position(tauri::PhysicalPosition::new(pos.x + dx, pos.y + dy))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Un-minimizes and focuses the main window (called from the overlay).
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_minimized().unwrap_or(false) {
            main.unminimize().map_err(|e| e.to_string())?;
        }
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_version,
            manual_check_for_updates,
            start_oauth_server,
            open_in_browser,
            show_overlay,
            hide_overlay,
            get_overlay_position,
            move_overlay_by,
            focus_main_window,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle).await;
            });

            if let Some(main_win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main_win.on_window_event(move |event| match event {
                    tauri::WindowEvent::Focused(true) => {
                        if let Some(ov) = handle.get_webview_window("overlay") {
                            ov.hide().ok();
                        }
                    }
                    tauri::WindowEvent::Focused(false) => {
                        let h = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                            if let Some(w) = h.get_webview_window("main") {
                                if w.is_minimized().unwrap_or(false) {
                                    h.emit("main-window-minimized", ()).ok();
                                }
                            }
                        });
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn manual_check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Ok("up_to_date".into());
    };
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_else(|| "No release notes.".to_string());
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(format!("{}\n\nInstall and restart now?", notes))
        .title(format!("Queue {} Available", version))
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install & Restart".into(),
            "Later".into(),
        ))
        .show(move |answer| { let _ = tx.send(answer); });
    let confirmed = rx.recv().unwrap_or(false);
    if confirmed {
        let _ = update.download_and_install(|_, _| {}, || {}).await;
        app.restart();
    }
    Ok("declined".into())
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
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install & Restart".into(),
            "Later".into(),
        ))
        .show(move |answer| {
            let _ = tx.send(answer);
        });
    let confirmed = rx.recv().unwrap_or(false);
    if confirmed {
        let _ = update.download_and_install(|_, _| {}, || {}).await;
        app.restart();
    }
}

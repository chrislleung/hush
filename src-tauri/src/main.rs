#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use std::sync::{Arc, Mutex};

// Store our three shortcuts in memory
struct Shortcuts {
    window: String,
    mic: String,
    desktop: String,
}
struct AppShortcuts(Arc<Mutex<Shortcuts>>);

#[tauri::command]
fn update_shortcuts(app: AppHandle, window: String, mic: String, desktop: String, state: State<'_, AppShortcuts>) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all(); // Wipe the slate clean

    // Update our memory bank with the new keys from React
    {
        let mut s = state.0.lock().unwrap();
        s.window = window.clone();
        s.mic = mic.clone();
        s.desktop = desktop.clone();
    }

    // Register all three safely
    if let Ok(w) = window.parse::<Shortcut>() { let _ = manager.register(w); }
    if let Ok(m) = mic.parse::<Shortcut>() { let _ = manager.register(m); }
    if let Ok(d) = desktop.parse::<Shortcut>() { let _ = manager.register(d); }

    Ok(())
}

fn main() {
    // Set default keys on startup just in case
    let initial_shortcuts = Shortcuts {
        window: "Ctrl+Shift+Space".to_string(),
        mic: "Ctrl+Shift+M".to_string(),
        desktop: "Ctrl+Shift+D".to_string(),
    };
    let app_shortcuts = AppShortcuts(Arc::new(Mutex::new(initial_shortcuts)));

    tauri::Builder::default()
        .manage(app_shortcuts) // Inject state into the app
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let state = app.state::<AppShortcuts>();
                    
                    // Fetch current hotkeys from memory
                    let (window_sc, mic_sc, desktop_sc) = {
                        let s = state.0.lock().unwrap();
                        (s.window.clone(), s.mic.clone(), s.desktop.clone())
                    };

                    // FIXED: Parse strings into exact Shortcuts and compare their deterministic IDs
                    let is_window = window_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);
                    let is_mic = mic_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);
                    let is_desktop = desktop_sc.parse::<Shortcut>().map(|s| s.id() == shortcut.id()).unwrap_or(false);

                    // Route the action based on which key was pressed
                    if is_window {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            let is_minimized = window.is_minimized().unwrap_or(false);
                            if is_visible && !is_minimized {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    } else if is_mic {
                        let _ = app.emit("toggle_mic", ()); // Send signal to React
                    } else if is_desktop {
                        let _ = app.emit("toggle_desktop", ()); // Send signal to React
                    }
                }
            })
            .build()
        )
        .invoke_handler(tauri::generate_handler![update_shortcuts])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
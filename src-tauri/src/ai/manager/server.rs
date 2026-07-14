//! Runtime-Binary-Auflösung und Server-Lebenszyklus (ping, ensure_server_running,
//! stop_server). Teil von `OllamaManager` (siehe `super`).

use super::*;

impl OllamaManager {
    // -- Runtime-Binary / Server ----------------------------------------------

    pub(super) fn ollama_binary_path(&self) -> String {
        let win_exe = self.runtime_dir.join("ollama.exe");
        let unix_bin = self.runtime_dir.join("ollama");
        if cfg!(windows) && win_exe.exists() {
            return win_exe.to_string_lossy().to_string();
        }
        if !cfg!(windows) && unix_bin.exists() {
            return unix_bin.to_string_lossy().to_string();
        }
        String::new()
    }

    async fn detect_system_ollama(&self) -> String {
        let finder = if cfg!(windows) { "where" } else { "which" };
        let mut command = tokio::process::Command::new(finder);
        command.arg("ollama");
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let output = tokio::time::timeout(Duration::from_secs(4), command.output()).await;
        match output {
            Ok(Ok(output)) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout
                    .lines()
                    .next()
                    .map(|line| line.trim().to_string())
                    .unwrap_or_default()
            }
            _ => String::new(),
        }
    }

    pub async fn runtime_binary_path(&self) -> String {
        if !self.is_system_runtime() {
            return self.ollama_binary_path();
        }
        let bin = self.detect_system_ollama().await;
        self.inner.lock().system_runtime_path = bin.clone();
        bin
    }

    pub(super) fn runtime_env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("OLLAMA_HOST".to_string(), format!("127.0.0.1:{}", self.runtime_port())),
            ("OLLAMA_ORIGINS".to_string(), "*".to_string()),
        ];
        if !self.is_system_runtime() {
            env.push((
                "OLLAMA_MODELS".to_string(),
                self.models_dir().to_string_lossy().to_string(),
            ));
        }
        env
    }

    pub(super) async fn runtime_looks_ready(&self) -> bool {
        if self.is_system_runtime() && self.ping_server().await {
            return true;
        }
        let bin = self.runtime_binary_path().await;
        if bin.is_empty() {
            return false;
        }
        // Für BlueTalk-Runtime reicht die Existenz-Prüfung (siehe binary_path);
        // für System-Ollama genügt der gefundene Pfad.
        true
    }

    pub async fn ping_server(&self) -> bool {
        let url = format!("{}/api/tags", self.api_base());
        match self
            .http
            .get(&url)
            .timeout(Duration::from_millis(1500))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn ensure_server_running(&self) -> bool {
        {
            let mut guard = self.server.lock().await;
            if let Some(handle) = guard.as_mut() {
                let same_mode = handle.mode == self.runtime_mode();
                match handle.child.try_wait() {
                    Ok(None) if same_mode => return true,
                    Ok(None) => {
                        let _ = handle.child.start_kill();
                        *guard = None;
                    }
                    _ => {
                        *guard = None;
                    }
                }
            }
        }

        if self.ping_server().await {
            self.broadcast(|s| s.server_running = true);
            return true;
        }

        let bin = self.runtime_binary_path().await;
        if bin.is_empty() {
            return false;
        }
        if !self.is_system_runtime() && self.prepare_models_dir().await.is_err() {
            return false;
        }

        let mut command = tokio::process::Command::new(&bin);
        command.arg("serve");
        for (key, value) in self.runtime_env() {
            command.env(key, value);
        }
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        match command.spawn() {
            Ok(child) => {
                let mut guard = self.server.lock().await;
                *guard = Some(ServerHandle {
                    child,
                    mode: self.runtime_mode(),
                });
            }
            Err(error) => {
                log::warn!("[ollama] Serverstart fehlgeschlagen: {error}");
                return false;
            }
        }

        for _ in 0..40 {
            if self.ping_server().await {
                self.broadcast(|s| s.server_running = true);
                return true;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        false
    }

    pub async fn stop_server(&self) {
        let mut guard = self.server.lock().await;
        if let Some(mut handle) = guard.take() {
            let _ = handle.child.start_kill();
        }
        drop(guard);
        self.broadcast(|s| s.server_running = false);
    }
}

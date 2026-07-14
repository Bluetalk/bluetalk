//! Runtime- und Modell-Download, Entpacken, Modell-/Modus-Auswahl sowie
//! Verzeichnis-Zugriff. Teil von `OllamaManager` (siehe `super`).

use super::*;

impl OllamaManager {
    // -- Runtime-Download ---------------------------------------------------------

    pub async fn download_runtime(&self) -> Value {
        self.apply_runtime_mode();
        if self.is_system_runtime() {
            self.broadcast(|s| {
                s.runtime_status = "error".into();
                s.runtime_error = "Im eigenen Ollama-Modus verwaltet BlueTalk die Runtime nicht.".into();
            });
            let state = self.refresh_state().await;
            return json!({"ok": false, "state": state});
        }
        if self.state().runtime_status == "downloading" {
            return json!({"ok": true, "state": self.state()});
        }
        if self.runtime_looks_ready().await {
            let state = self.refresh_state().await;
            return json!({"ok": true, "state": state});
        }

        let asset = platform_runtime_asset();
        let url = format!("https://github.com/ollama/ollama/releases/latest/download/{asset}");
        let archive_path = self.base_dir.join(asset);

        self.broadcast(|s| {
            s.runtime_status = "downloading".into();
            s.runtime_error = String::new();
            s.runtime_percent = 0;
            s.runtime_downloaded_bytes = 0;
            s.runtime_total_bytes = catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES;
        });

        let cancel = self.register_abort(RUNTIME_DOWNLOAD_ABORT_KEY);
        let result: Result<(), String> = async {
            tokio::fs::create_dir_all(&self.base_dir)
                .await
                .map_err(|e| e.to_string())?;
            self.download_file(&url, &archive_path, &cancel).await?;
            self.extract_archive(&archive_path, &self.runtime_dir.clone()).await?;
            let _ = tokio::fs::remove_file(&archive_path).await;

            if !self.runtime_looks_ready().await {
                return Err("Ollama konnte nach dem Entpacken nicht gefunden werden.".into());
            }
            if !self.ensure_server_running().await {
                return Err("Ollama konnte nicht gestartet werden.".into());
            }
            Ok(())
        }
        .await;
        self.remove_abort(RUNTIME_DOWNLOAD_ABORT_KEY);

        match result {
            Ok(()) => {
                let runtime_path = self.ollama_binary_path();
                self.broadcast(move |s| {
                    s.runtime_status = "ready".into();
                    s.runtime_path = runtime_path;
                    s.runtime_percent = 100;
                    s.runtime_error = String::new();
                });
            }
            Err(error) => {
                self.broadcast(move |s| {
                    s.runtime_status = "error".into();
                    s.runtime_error = if error.is_empty() {
                        "Download fehlgeschlagen".into()
                    } else {
                        error
                    };
                });
            }
        }

        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    async fn download_file(
        &self,
        url: &str,
        dest: &std::path::Path,
        cancel: &CancelToken,
    ) -> Result<(), String> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Download fehlgeschlagen (HTTP {}).", response.status().as_u16()));
        }
        let total_bytes = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
        let mut response = response;

        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
                _ = cancel.cancelled() => return Err("Download abgebrochen".into()),
            };
            let Some(chunk) = chunk else { break };
            downloaded += chunk.len() as u64;
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|e| e.to_string())?;
            let percent = if total_bytes > 0 {
                ((downloaded as f64 / total_bytes as f64) * 100.0).round().min(100.0) as u32
            } else {
                ((downloaded as f64 / (catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES as f64 / 100.0)).round() as u32)
                    .min(99)
            };
            let total_for_state = if total_bytes > 0 {
                total_bytes
            } else {
                catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES
            };
            self.broadcast(move |s| {
                s.runtime_status = "downloading".into();
                s.runtime_percent = percent;
                s.runtime_downloaded_bytes = downloaded;
                s.runtime_total_bytes = total_for_state;
            });
        }
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(|e| e.to_string())?;

        let final_total = if total_bytes > 0 { total_bytes } else { downloaded };
        self.broadcast(move |s| {
            s.runtime_percent = 100;
            s.runtime_downloaded_bytes = final_total;
            s.runtime_total_bytes = final_total;
        });
        Ok(())
    }

    async fn extract_archive(&self, archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
        tokio::fs::create_dir_all(dest_dir)
            .await
            .map_err(|e| e.to_string())?;
        let archive = archive_path.to_string_lossy().to_string();
        let dest = dest_dir.to_string_lossy().to_string();

        if cfg!(windows) && archive.ends_with(".zip") {
            let script = format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                archive.replace('\'', "''"),
                dest.replace('\'', "''")
            );
            let mut command = tokio::process::Command::new("powershell.exe");
            command.arg("-NoProfile").arg("-Command").arg(script);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let output = command.output().await.map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("Entpacken fehlgeschlagen (Code {:?})", output.status.code())
                } else {
                    stderr
                });
            }
            return Ok(());
        }

        if archive.ends_with(".tgz") || archive.ends_with(".tar.gz") {
            let output = tokio::process::Command::new("tar")
                .args(["-xzf", &archive, "-C", &dest])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            return Ok(());
        }

        if archive.ends_with(".zip") {
            let output = tokio::process::Command::new("unzip")
                .args(["-o", &archive, "-d", &dest])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            return Ok(());
        }

        Err(format!(
            "Unbekanntes Archivformat: {}",
            archive_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        ))
    }

    // -- Modi / Auswahl -----------------------------------------------------------

    pub async fn select_runtime_mode(&self, mode: &str) -> Value {
        let next_mode = catalog::resolve_runtime_mode(mode).to_string();
        if next_mode == self.runtime_mode() {
            let state = self.refresh_state().await;
            return json!({"ok": true, "state": state});
        }

        self.cancel_abort(RUNTIME_DOWNLOAD_ABORT_KEY);
        self.cancel_abort(MODEL_PULL_ABORT_KEY);
        self.cancel_all();
        self.stop_server().await;

        self.kv_set("aiChat.ollamaRuntimeMode", json!(next_mode));
        self.apply_runtime_mode();
        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    pub async fn select_model_tier(&self, tier_id: &str) -> Value {
        if !catalog::is_valid_model_tier(tier_id) {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        }
        let requires_auth = catalog::get_model_tier(tier_id).map(|t| t.requires_auth).unwrap_or(false);
        if requires_auth && !self.state().cloud_auth {
            return json!({"ok": false, "error": "cloud_auth_required", "state": self.state()});
        }
        self.kv_set("aiChat.selectedModelTier", json!(tier_id));
        self.refresh_state().await;
        json!({"ok": true, "state": self.state()})
    }

    pub async fn select_cloud_model(&self, cloud_model_id: &str) -> Value {
        if !catalog::is_valid_cloud_model(cloud_model_id) {
            return json!({"ok": false, "error": "invalid_cloud_model", "state": self.state()});
        }
        self.kv_set("aiChat.selectedCloudModelId", json!(cloud_model_id));
        self.refresh_state().await;
        json!({"ok": true, "state": self.state()})
    }

    // -- Modell-Download / -Löschung -------------------------------------------------

    pub async fn download_model(&self, tier_id: &str) -> Value {
        if !catalog::is_valid_model_tier(tier_id) {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        }
        let Some(tier) = catalog::get_model_tier(tier_id) else {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        };
        if tier.requires_auth && !self.state().cloud_auth {
            return json!({"ok": false, "error": "cloud_auth_required", "state": self.state()});
        }
        if self.state().runtime_status != "ready" {
            return json!({"ok": false, "error": "runtime_not_ready", "state": self.state()});
        }
        if tier_id == "cloud" {
            self.kv_set("aiChat.selectedModelTier", json!("cloud"));
            self.refresh_state().await;
            return json!({"ok": true, "state": self.state()});
        }
        {
            let status = self.state().model_status.get(tier_id).cloned().unwrap_or_default();
            if status == "ready" || status == "downloading" {
                return json!({"ok": true, "state": self.state()});
            }
        }

        self.kv_set("aiChat.selectedModelTier", json!(tier_id));
        self.ensure_server_running().await;

        let tier_key = tier_id.to_string();
        {
            let tier_key = tier_key.clone();
            self.broadcast(move |s| {
                s.model_status.insert(tier_key.clone(), "downloading".into());
                s.model_percent.insert(tier_key.clone(), 0);
                s.model_downloaded_bytes.insert(tier_key.clone(), 0);
                s.model_total_bytes.insert(tier_key.clone(), 0);
                s.model_progress_status
                    .insert(tier_key.clone(), "download_starting".into());
                s.model_error.insert(tier_key, String::new());
            });
        }

        let cancel = self.register_abort(MODEL_PULL_ABORT_KEY);
        let pull_result = self
            .pull_model(tier.model, &cancel, |progress| {
                let tier_key = tier_key.clone();
                self.broadcast(move |s| {
                    s.model_status.insert(tier_key.clone(), "downloading".into());
                    if let Some(percent) = progress.percent {
                        s.model_percent.insert(tier_key.clone(), percent);
                    }
                    if let Some(downloaded) = progress.downloaded_bytes {
                        s.model_downloaded_bytes.insert(tier_key.clone(), downloaded);
                    }
                    if let Some(total) = progress.total_bytes {
                        s.model_total_bytes.insert(tier_key.clone(), total);
                    }
                    if let Some(status) = progress.status.clone() {
                        s.model_progress_status.insert(tier_key.clone(), status);
                    }
                });
            })
            .await;
        self.remove_abort(MODEL_PULL_ABORT_KEY);

        match pull_result {
            Ok(()) => {
                let final_total = self
                    .state()
                    .model_total_bytes
                    .get(tier_id)
                    .copied()
                    .unwrap_or(0);
                let tier_key = tier_id.to_string();
                self.broadcast(move |s| {
                    s.model_status.insert(tier_key.clone(), "ready".into());
                    s.model_percent.insert(tier_key.clone(), 100);
                    s.model_downloaded_bytes.insert(tier_key.clone(), final_total);
                    s.model_progress_status.insert(tier_key.clone(), "success".into());
                    s.model_error.insert(tier_key, String::new());
                });
                let state = self.refresh_state().await;
                json!({"ok": true, "state": state})
            }
            Err(error) => {
                let tier_key = tier_id.to_string();
                let message = error.clone();
                self.broadcast(move |s| {
                    s.model_status.insert(tier_key.clone(), "error".into());
                    s.model_error.insert(
                        tier_key,
                        if message.is_empty() {
                            "Modell-Download fehlgeschlagen".into()
                        } else {
                            message
                        },
                    );
                });
                json!({"ok": false, "error": error, "state": self.state()})
            }
        }
    }

    async fn pull_model<F: Fn(PullProgress)>(
        &self,
        model_name: &str,
        cancel: &CancelToken,
        on_progress: F,
    ) -> Result<(), String> {
        let url = format!("{}/api/pull", self.api_base());
        let response = self
            .http
            .post(&url)
            .json(&json!({"name": model_name, "stream": true}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let trimmed = body.trim();
            return Err(if trimmed.is_empty() {
                format!("Pull fehlgeschlagen (HTTP {status})")
            } else {
                trimmed.to_string()
            });
        }

        let mut response = response;
        let mut buffer = String::new();
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
                _ = cancel.cancelled() => return Err("Modell-Download abgebrochen".into()),
            };
            let Some(chunk) = chunk else { break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(position) = buffer.find('\n') {
                let line = buffer[..position].trim().to_string();
                buffer.drain(..=position);
                if line.is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let status = event
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let completed = event.get("completed").and_then(Value::as_u64);
                let total = event.get("total").and_then(Value::as_u64);
                if let (Some(completed), Some(total)) = (completed, total)
                    && total > 0
                {
                    let downloaded = completed.min(total);
                    on_progress(PullProgress {
                        percent: Some(((downloaded as f64 / total as f64) * 100.0).round().min(100.0) as u32),
                        downloaded_bytes: Some(downloaded),
                        total_bytes: Some(total),
                        status: Some(status.clone()),
                    });
                } else if !status.is_empty() {
                    on_progress(PullProgress {
                        status: Some(status.clone()),
                        ..Default::default()
                    });
                }
                if status == "success" {
                    on_progress(PullProgress {
                        percent: Some(100),
                        status: Some("success".into()),
                        ..Default::default()
                    });
                }
                if let Some(error) = event.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }

    pub async fn delete_model(&self, tier_id: &str) -> Value {
        if !catalog::is_valid_model_tier(tier_id) {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        }
        let Some(tier) = catalog::get_model_tier(tier_id) else {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        };
        if !tier.local {
            return json!({"ok": false, "error": "not_local_model", "state": self.state()});
        }
        if self.state().runtime_status != "ready" {
            return json!({"ok": false, "error": "runtime_not_ready", "state": self.state()});
        }

        self.ensure_server_running().await;
        let url = format!("{}/api/delete", self.api_base());
        let response = self
            .http
            .delete(&url)
            .timeout(Duration::from_secs(8))
            .json(&json!({"name": tier.model}))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                let body = response.text().await.unwrap_or_default();
                if !body.contains("not found") && !body.contains("model not found") {
                    return json!({
                        "ok": false,
                        "error": if body.trim().is_empty() { "delete_failed".to_string() } else { body.trim().to_string() },
                        "state": self.state(),
                    });
                }
            }
            Err(error) => {
                let message = error.to_string();
                if !message.contains("not found") {
                    return json!({"ok": false, "error": message, "state": self.state()});
                }
            }
        }

        let tier_key = tier_id.to_string();
        self.broadcast(move |s| {
            s.model_status.insert(tier_key.clone(), "missing".into());
            s.model_percent.insert(tier_key.clone(), 0);
            s.model_downloaded_bytes.insert(tier_key.clone(), 0);
            s.model_total_bytes.insert(tier_key.clone(), 0);
            s.model_progress_status.insert(tier_key, String::new());
        });
        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    // -- Verzeichnisse / Pfade -----------------------------------------------------

    pub async fn open_models_dir(&self) -> Value {
        let models_dir = self.models_dir();
        if !self.is_system_runtime() {
            let _ = tokio::fs::create_dir_all(&models_dir).await;
        }
        let path_string = models_dir.to_string_lossy().to_string();
        match tauri_plugin_opener::open_path(path_string.clone(), None::<&str>) {
            Ok(()) => json!({"ok": true, "error": "", "path": path_string}),
            Err(error) => json!({"ok": false, "error": error.to_string(), "path": path_string}),
        }
    }

    pub async fn get_storage_paths(&self) -> Value {
        let (runtime_mode, models_dir, models_dir_source, state_runtime_path) = {
            let inner = self.inner.lock();
            (
                inner.runtime_mode.clone(),
                inner.models_dir.to_string_lossy().to_string(),
                inner.models_dir_source.clone(),
                inner.state.runtime_path.clone(),
            )
        };
        let runtime_path = if !state_runtime_path.is_empty() {
            state_runtime_path
        } else if self.is_system_runtime() {
            self.runtime_binary_path().await
        } else {
            self.ollama_binary_path()
        };
        json!({
            "runtimeMode": runtime_mode,
            "baseDir": self.base_dir.to_string_lossy(),
            "runtimeDir": self.runtime_dir.to_string_lossy(),
            "modelsDir": models_dir,
            "modelsDirSource": models_dir_source,
            "modelsEnvVariable": paths::BLUETALK_OLLAMA_MODELS_ENV,
            "serverPort": self.runtime_port(),
            "runtimePath": runtime_path,
        })
    }
}

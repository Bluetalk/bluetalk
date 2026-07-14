//! Modell-Status-Ermittlung und der zentrale `refresh_state`-Durchlauf.
//! Teil von `OllamaManager` (siehe `super`).

use super::*;

impl OllamaManager {
    async fn list_local_models(&self) -> HashSet<String> {
        let url = format!("{}/api/tags", self.api_base());
        let response = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        let mut names = HashSet::new();
        if let Ok(response) = response
            && response.status().is_success()
            && let Ok(body) = response.json::<Value>().await
            && let Some(models) = body.get("models").and_then(Value::as_array)
        {
            for model in models {
                if let Some(name) = model.get("name").and_then(Value::as_str)
                    && !name.is_empty()
                {
                    names.insert(name.to_string());
                }
            }
        }
        names
    }

    // -- refresh_state ---------------------------------------------------------

    fn refresh_model_statuses(&self, local_models: &HashSet<String>, cloud_auth: bool) -> HashMap<String, String> {
        let current = self.state().model_status;
        let mut model_status = current.clone();
        for tier in catalog::AI_MODEL_TIERS {
            if tier.id == "cloud" {
                model_status.insert(
                    tier.id.to_string(),
                    if cloud_auth { "ready" } else { "missing" }.to_string(),
                );
                continue;
            }
            if current.get(tier.id).map(String::as_str) == Some("downloading") {
                continue;
            }
            let has_model = local_models.contains(tier.model);
            model_status.insert(
                tier.id.to_string(),
                if has_model { "ready" } else { "missing" }.to_string(),
            );
        }
        model_status
    }

    fn compute_setup_complete(
        &self,
        runtime_status: &str,
        selected_model_tier: &str,
        model_status: &HashMap<String, String>,
        cloud_auth: bool,
    ) -> bool {
        if runtime_status != "ready" {
            return false;
        }
        if selected_model_tier.is_empty() || !catalog::is_valid_model_tier(selected_model_tier) {
            return false;
        }
        let Some(tier) = catalog::get_model_tier(selected_model_tier) else {
            return false;
        };
        if tier.requires_auth {
            return cloud_auth && model_status.get("cloud").map(String::as_str) == Some("ready");
        }
        model_status.get(selected_model_tier).map(String::as_str) == Some("ready")
    }

    pub async fn refresh_state(&self) -> OllamaState {
        self.apply_runtime_mode();
        let stored_tier = self.kv_get_string("aiChat.selectedModelTier", "");
        let runtime_ready = self.runtime_looks_ready().await;
        let mut runtime_status = if runtime_ready { "ready" } else { "missing" }.to_string();
        let runtime_path = if runtime_ready {
            self.runtime_binary_path().await
        } else {
            String::new()
        };
        let mut runtime_error = String::new();
        let mut server_running = false;

        if self.state().runtime_status == "downloading" {
            runtime_status = "downloading".into();
        }

        if runtime_ready && runtime_status != "downloading" {
            server_running = self.ensure_server_running().await;
            if !server_running {
                runtime_status = "error".into();
                runtime_error = if self.is_system_runtime() {
                    "Eigener Ollama-Server ist nicht erreichbar. Starte Ollama oder wechsle zu BlueTalk-Ollama."
                } else {
                    "BlueTalk-Ollama konnte nicht gestartet werden."
                }
                .to_string();
            }
        }

        let cloud_auth = self.kv_get_bool("aiChat.cloudAuth", false);
        let stored_cloud_id = self.kv_get_string("aiChat.selectedCloudModelId", "");
        let selected_cloud_model_id = catalog::resolve_cloud_model_id(&stored_cloud_id).to_string();
        if selected_cloud_model_id != stored_cloud_id {
            self.kv_set("aiChat.selectedCloudModelId", json!(selected_cloud_model_id.clone()));
        }

        let local_models = if runtime_status == "ready" {
            self.list_local_models().await
        } else {
            HashSet::new()
        };
        let model_status = self.refresh_model_statuses(&local_models, cloud_auth);

        let selected_model_tier = stored_tier;
        let setup_complete =
            self.compute_setup_complete(&runtime_status, &selected_model_tier, &model_status, cloud_auth);
        if setup_complete != self.kv_get_bool("aiChat.setupComplete", false) {
            self.kv_set("aiChat.setupComplete", json!(setup_complete));
        }

        let runtime_mode = self.runtime_mode();
        let active_model =
            catalog::resolve_active_model_name(&selected_model_tier, &selected_cloud_model_id);
        self.broadcast(move |s| {
            s.runtime_mode = runtime_mode;
            s.runtime_status = runtime_status.clone();
            s.runtime_path = runtime_path;
            s.runtime_error = if runtime_status == "error" {
                if runtime_error.is_empty() {
                    s.runtime_error.clone()
                } else {
                    runtime_error
                }
            } else {
                String::new()
            };
            s.server_running = server_running;
            s.selected_model_tier = selected_model_tier;
            s.model_status = model_status;
            s.cloud_auth = cloud_auth;
            s.selected_cloud_model_id = selected_cloud_model_id;
            s.setup_complete = setup_complete;
            s.active_model = active_model;
        });

        self.state()
    }
}

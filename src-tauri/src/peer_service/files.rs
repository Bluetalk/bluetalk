//! Datei-Hosting und Datei-Transfer (host_file, hosted_files, request_file).

use super::*;
use super::helpers::*;

impl PeerService {
    pub async fn host_file(&self, meta: Value) -> Result<Value> {
        let name = sanitize_download_name(meta.get("name").and_then(Value::as_str).unwrap_or(""));
        let mime_type =
            sanitize_content_type(meta.get("type").and_then(Value::as_str).unwrap_or(""));
        let data_b64 = meta
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::InvalidInput("file data must be base64".to_owned()))?;
        if !is_strict_base64(data_b64) {
            return Err(AppError::InvalidInput("invalid base64 payload".to_owned()));
        }
        let data = BASE64
            .decode(data_b64)
            .map_err(|_| AppError::InvalidInput("invalid base64 payload".to_owned()))?;
        if data.is_empty() || data.len() > MAX_HOSTED_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "hosted files must contain 1..={MAX_HOSTED_FILE_BYTES} bytes"
            )));
        }

        let file_id = random_file_id()?;
        let entry = HostedFile {
            id: file_id.clone(),
            name: name.clone(),
            size: data.len(),
            mime_type: mime_type.clone(),
            data,
            created_at: now_ms(),
        };
        {
            let mut hosted = self.hosted.lock();
            hosted.push(entry);
            // Oldest-first eviction, byte and count bounded (v1 semantics).
            while hosted.len() > MAX_HOSTED_FILES
                || hosted.iter().map(|file| file.size).sum::<usize>()
                    > MAX_TOTAL_HOSTED_FILE_BYTES
            {
                hosted.remove(0);
            }
        }

        let size = {
            let hosted = self.hosted.lock();
            hosted
                .iter()
                .find(|file| file.id == file_id)
                .map(|file| file.size)
                .unwrap_or(0)
        };
        if let Ok(network) = self.network().await {
            let _ = network.broadcast(json!({
                "kind": "file-hosted",
                "fileId": file_id,
                "fileName": name,
                "fileSize": size,
                "fileType": mime_type,
            }));
        }
        Ok(json!({ "fileId": file_id, "url": format!("bt2://files/{file_id}") }))
    }

    pub fn hosted_files(&self) -> Vec<Value> {
        self.hosted.lock().iter().map(hosted_file_summary).collect()
    }

    pub async fn request_file(&self, peer_id: &str, file_id: &str) -> Result<Value> {
        if !is_valid_file_id(file_id) {
            return Err(AppError::InvalidInput("invalid file id".to_owned()));
        }
        let request_id = random_file_id()?;
        let (sender, receiver) = oneshot::channel();
        self.pending_file_requests
            .lock()
            .insert(request_id.clone(), sender);

        let network = self.network().await?;
        let sent = network.send(
            peer_id,
            json!({ "kind": FILE_REQUEST_KIND, "fileId": file_id, "requestId": request_id }),
        );
        if let Err(error) = sent {
            self.pending_file_requests.lock().remove(&request_id);
            return Err(AppError::Network(error.to_string()));
        }

        let response = tokio::time::timeout(FILE_REQUEST_TIMEOUT, receiver)
            .await
            .map_err(|_| AppError::Network("file request timed out".to_owned()))?
            .map_err(|_| AppError::Network("file request aborted".to_owned()))?;

        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("file unavailable");
            return Err(AppError::Network(message.to_owned()));
        }
        let result = json!({
            "fileId": file_id,
            "data": response.get("data").cloned().unwrap_or(Value::Null),
            "name": response.get("name").cloned().unwrap_or(Value::Null),
            "type": response.get("type").cloned().unwrap_or(Value::Null),
            "size": response.get("size").cloned().unwrap_or(Value::Null),
            "from": peer_id,
        });
        let _ = self.app.emit("peer:file-received", result.clone());
        Ok(result)
    }

    // ------------------------------------------------------------------
    // Event handling
    // ------------------------------------------------------------------

}

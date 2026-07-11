use serde::Serialize;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid_input: {0}")]
    InvalidInput(String),
    #[error("permission_denied: {0}")]
    PermissionDenied(String),
    #[error("not_found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not_ready: {0}")]
    NotReady(String),
    #[error("storage_error: {0}")]
    Storage(String),
    #[error("crypto_error: {0}")]
    Crypto(String),
    #[error("network_error: {0}")]
    Network(String),
    #[error("plugin_error: {0}")]
    Plugin(String),
    #[error("update_error: {0}")]
    Update(String),
    #[error("io_error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json_error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("database_error: {0}")]
    Database(#[from] rusqlite::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        Self::Io(std::io::Error::other(value.to_string()))
    }
}

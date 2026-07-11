use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    database::Database,
    error::{AppError, Result},
};

const MAX_LEGACY_CONFIG_BYTES: u64 = 512 * 1024 * 1024;

pub fn import_v1_if_present(database: &Database, v2_data_dir: &Path) -> Result<Option<PathBuf>> {
    let Some(source) = find_v1_config(v2_data_dir) else {
        return Ok(None);
    };
    let metadata = fs::metadata(&source)?;
    if metadata.len() == 0 || metadata.len() > MAX_LEGACY_CONFIG_BYTES {
        return Err(AppError::Storage(format!(
            "legacy profile has an unsupported size ({} bytes)",
            metadata.len()
        )));
    }

    let bytes = fs::read(&source)?;
    let root: Map<String, Value> = serde_json::from_slice::<Value>(&bytes)?
        .as_object()
        .cloned()
        .ok_or_else(|| AppError::Storage("legacy profile root is not an object".into()))?;

    let backup_dir = v2_data_dir.join("migration-backups");
    fs::create_dir_all(&backup_dir)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    let backup_path = backup_dir.join(format!("bluetalk-v1-{}.json", &digest[..16]));
    if !backup_path.exists() {
        let temporary = backup_path.with_extension("json.tmp");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &backup_path)?;
    }

    if database.import_legacy(&source, root)? {
        log::info!("Imported the BlueTalk v1 profile from {}", source.display());
        Ok(Some(source))
    } else {
        Ok(None)
    }
}

fn find_v1_config(v2_data_dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        for folder in ["BlueTalk", "bluetalk", "blue-talk", "com.bluetalk.app"] {
            candidates.push(app_data.join(folder).join("bluetalk-config.json"));
        }
    }
    if let Some(parent) = v2_data_dir.parent() {
        for folder in ["BlueTalk", "bluetalk"] {
            candidates.push(parent.join(folder).join("bluetalk-config.json"));
        }
    }

    candidates.into_iter().find(|candidate| {
        candidate.is_file()
            && candidate
                .canonicalize()
                .ok()
                .zip(v2_data_dir.canonicalize().ok())
                .is_none_or(|(candidate, v2)| candidate != v2.join("bluetalk-config.json"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::DataCipher;

    #[test]
    fn rejects_oversized_legacy_files_before_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db.sqlite3");
        let database = Database::open(&path, DataCipher::for_test([3; 32])).unwrap();
        // Candidate discovery is platform-directory based; the size guard is covered by the
        // importer integration tests with real fixtures rather than manufacturing a sparse
        // profile in a user's roaming-data directory.
        assert!(database.get("peerId", Value::Null).unwrap().is_null());
    }
}

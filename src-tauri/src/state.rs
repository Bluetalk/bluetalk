use std::{path::PathBuf, sync::Arc};

use tauri::{AppHandle, Manager};

use crate::{
    crypto::DataCipher, database::Database, error::Result, migration, updater::UpdaterService,
};

pub struct AppState {
    pub database: Arc<Database>,
    pub updater: Arc<UpdaterService>,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub log_dir: PathBuf,
    pub plugin_dir: PathBuf,
    pub attachment_dir: PathBuf,
}

impl AppState {
    pub fn initialize(app: &AppHandle) -> Result<Self> {
        let data_dir = app.path().app_data_dir()?;
        let log_dir = app.path().app_log_dir()?;
        let plugin_dir = data_dir.join("plugins");
        let attachment_dir = data_dir.join("attachments");
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(&log_dir)?;
        std::fs::create_dir_all(&plugin_dir)?;
        std::fs::create_dir_all(&attachment_dir)?;

        let database_path = data_dir.join("bluetalk-v2.sqlite3");
        let cipher = DataCipher::load_or_create(&data_dir, &database_path)?;
        let database = Arc::new(Database::open(&database_path, cipher)?);
        let _ = migration::import_v1_if_present(&database, &data_dir)?;
        let updater = UpdaterService::new(app.clone(), database.clone());

        log::info!(
            "BlueTalk storage ready (encrypted via {})",
            database.cipher_backend()
        );

        Ok(Self {
            database,
            updater,
            data_dir,
            database_path,
            log_dir,
            plugin_dir,
            attachment_dir,
        })
    }
}

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const ENVELOPE_VERSION: u8 = 1;
const KEYRING_SERVICE: &str = "com.bluetalk.app";
const KEYRING_USER: &str = "database-key-v2";
const FALLBACK_KEY_FILE: &str = "master-key-v2";

#[derive(Clone)]
pub struct DataCipher {
    key: Arc<Zeroizing<[u8; KEY_BYTES]>>,
    backend: Arc<str>,
}

impl DataCipher {
    pub fn load_or_create(data_dir: &Path, database_path: &Path) -> Result<Self> {
        fs::create_dir_all(data_dir)?;
        let fallback_path = data_dir.join(FALLBACK_KEY_FILE);

        if fallback_path.is_file() {
            let key = read_key_file(&fallback_path)?;
            return Ok(Self::from_key(key, "restricted-file"));
        }

        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| {
            AppError::Crypto(format!("could not open the OS credential store: {error}"))
        });

        if let Ok(entry) = &entry {
            match entry.get_secret() {
                Ok(secret) => {
                    let key = decode_exact_key(&secret)?;
                    return Ok(Self::from_key(key, "os-keyring"));
                }
                Err(keyring::Error::NoEntry) => {}
                Err(error) => {
                    if database_has_content(database_path) {
                        return Err(AppError::Crypto(format!(
                            "the existing database key is unavailable from the OS credential store: {error}"
                        )));
                    }
                }
            }
        } else if database_has_content(database_path) {
            return Err(entry.err().unwrap_or_else(|| {
                AppError::Crypto("the existing database key is unavailable".into())
            }));
        }

        let mut key = [0_u8; KEY_BYTES];
        rand::rng().fill_bytes(&mut key);

        if let Ok(entry) = entry {
            if entry.set_secret(&key).is_ok() {
                return Ok(Self::from_key(key, "os-keyring"));
            }
        }

        write_key_file(&fallback_path, &key)?;
        Ok(Self::from_key(key, "restricted-file"))
    }

    #[cfg(test)]
    pub fn for_test(key: [u8; KEY_BYTES]) -> Self {
        Self::from_key(key, "test")
    }

    fn from_key(key: [u8; KEY_BYTES], backend: &'static str) -> Self {
        Self {
            key: Arc::new(Zeroizing::new(key)),
            backend: Arc::from(backend),
        }
    }

    pub fn backend(&self) -> &str {
        &self.backend
    }

    pub fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref().as_ref())
            .map_err(|_| AppError::Crypto("invalid database key".into()))?;
        let mut nonce_bytes = [0_u8; NONCE_BYTES];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| AppError::Crypto("could not encrypt local data".into()))?;

        let mut envelope = Vec::with_capacity(1 + NONCE_BYTES + ciphertext.len());
        envelope.push(ENVELOPE_VERSION);
        envelope.extend_from_slice(&nonce_bytes);
        envelope.extend_from_slice(&ciphertext);
        Ok(envelope)
    }

    pub fn decrypt(&self, envelope: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if envelope.len() <= 1 + NONCE_BYTES || envelope[0] != ENVELOPE_VERSION {
            return Err(AppError::Crypto(
                "unsupported or corrupt encrypted record".into(),
            ));
        }
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref().as_ref())
            .map_err(|_| AppError::Crypto("invalid database key".into()))?;
        cipher
            .decrypt(
                Nonce::from_slice(&envelope[1..1 + NONCE_BYTES]),
                Payload {
                    msg: &envelope[1 + NONCE_BYTES..],
                    aad,
                },
            )
            .map_err(|_| AppError::Crypto("local data authentication failed".into()))
    }
}

fn database_has_content(path: &Path) -> bool {
    path.metadata()
        .map(|meta| meta.len() > 4096)
        .unwrap_or(false)
}

fn decode_exact_key(bytes: &[u8]) -> Result<[u8; KEY_BYTES]> {
    if bytes.len() == KEY_BYTES {
        return bytes
            .try_into()
            .map_err(|_| AppError::Crypto("invalid key length".into()));
    }

    let decoded = STANDARD
        .decode(bytes)
        .map_err(|_| AppError::Crypto("the stored database key is malformed".into()))?;
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Crypto("invalid database key length".into()))
}

fn read_key_file(path: &Path) -> Result<[u8; KEY_BYTES]> {
    let encoded = fs::read(path)?;
    decode_exact_key(encoded.trim_ascii())
}

fn write_key_file(path: &PathBuf, key: &[u8; KEY_BYTES]) -> Result<()> {
    let encoded = STANDARD.encode(key);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(encoded.as_bytes())?;
        file.sync_all()?;
    }

    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(encoded.as_bytes())?;
        file.sync_all()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_envelopes_round_trip_and_bind_aad() {
        let cipher = DataCipher::for_test([7; KEY_BYTES]);
        let encrypted = cipher.encrypt(b"secret", b"kv:settings").unwrap();
        assert_ne!(&encrypted[1 + NONCE_BYTES..], b"secret");
        assert_eq!(
            cipher.decrypt(&encrypted, b"kv:settings").unwrap(),
            b"secret"
        );
        assert!(cipher.decrypt(&encrypted, b"kv:other").is_err());
    }
}

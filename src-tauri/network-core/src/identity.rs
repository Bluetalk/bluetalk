use std::{
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{NetworkError, Result};

const IDENTITY_FILE_VERSION: u8 = 1;

#[derive(Clone)]
pub struct NetworkIdentity {
    signing_key: Arc<SigningKey>,
}

impl fmt::Debug for NetworkIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NetworkIdentity")
            .field("peer_id", &self.peer_id())
            .finish_non_exhaustive()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredIdentity {
    version: u8,
    secret_key: String,
}

impl NetworkIdentity {
    pub fn generate() -> Result<Self> {
        let mut seed = Zeroizing::new([0_u8; 32]);
        getrandom::fill(seed.as_mut()).map_err(|error| {
            NetworkError::Identity(format!("operating-system RNG unavailable: {error}"))
        })?;
        Ok(Self::from_seed(*seed))
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            signing_key: Arc::new(SigningKey::from_bytes(&seed)),
        }
    }

    /// Loads a seed from a restricted file or creates it atomically.
    ///
    /// Hosts with an OS keyring should store the 32-byte seed there and call
    /// [`Self::from_seed`]. This file helper exists for headless deployments.
    pub fn load_or_create(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        match Self::load(path) {
            Ok(identity) => return Ok(identity),
            Err(NetworkError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let identity = Self::generate()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let random_suffix = random_hex(8)?;
        let temporary_path = path.with_extension(format!("tmp-{random_suffix}"));
        let stored = StoredIdentity {
            version: IDENTITY_FILE_VERSION,
            secret_key: BASE64.encode(identity.signing_key.to_bytes()),
        };
        let serialized = Zeroizing::new(serde_json::to_vec(&stored)?);

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path)?;
        file.write_all(serialized.as_slice())?;
        file.sync_all()?;
        drop(file);

        match fs::rename(&temporary_path, path) {
            Ok(()) => Ok(identity),
            Err(_) if path.exists() => {
                let _ = fs::remove_file(&temporary_path);
                Self::load(path)
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary_path);
                Err(error.into())
            }
        }
    }

    pub fn peer_id(&self) -> String {
        peer_id_for_public_key(&self.public_key_bytes())
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    pub(crate) fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing_key.sign(message).to_bytes()
    }

    pub(crate) fn verify(
        public_key: &[u8; 32],
        message: &[u8],
        signature: &[u8; 64],
    ) -> Result<()> {
        let verifying_key = VerifyingKey::from_bytes(public_key)
            .map_err(|error| NetworkError::Crypto(format!("invalid Ed25519 key: {error}")))?;
        verifying_key
            .verify_strict(message, &Signature::from_bytes(signature))
            .map_err(|_| NetworkError::Crypto("Ed25519 signature verification failed".to_owned()))
    }

    fn load(path: &Path) -> Result<Self> {
        let metadata = fs::metadata(path)?;
        if metadata.len() > 4_096 {
            return Err(NetworkError::Identity(
                "identity file exceeds 4096 bytes".to_owned(),
            ));
        }
        let bytes = Zeroizing::new(fs::read(path)?);
        let stored: StoredIdentity = serde_json::from_slice(bytes.as_slice())?;
        if stored.version != IDENTITY_FILE_VERSION {
            return Err(NetworkError::Identity(format!(
                "unsupported identity file version {}",
                stored.version
            )));
        }
        let decoded = Zeroizing::new(
            BASE64
                .decode(stored.secret_key)
                .map_err(|error| NetworkError::Identity(format!("invalid identity key: {error}")))?,
        );
        let seed: [u8; 32] = decoded.as_slice().try_into().map_err(|_| {
            NetworkError::Identity("identity seed must contain exactly 32 bytes".to_owned())
        })?;
        Ok(Self::from_seed(seed))
    }
}

pub(crate) fn peer_id_for_public_key(public_key: &[u8; 32]) -> String {
    format!("bt2_{}", hex::encode(Sha256::digest(public_key)))
}

pub(crate) fn random_hex(bytes: usize) -> Result<String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|error| {
        NetworkError::Crypto(format!("operating-system RNG unavailable: {error}"))
    })?;
    Ok(hex::encode(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_round_trip_and_permissions_helper() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity.json");
        let first = NetworkIdentity::load_or_create(&path).unwrap();
        let second = NetworkIdentity::load_or_create(&path).unwrap();
        assert_eq!(first.peer_id(), second.peer_id());
        assert!(first.peer_id().starts_with("bt2_"));
    }

    #[test]
    fn signatures_reject_tampering() {
        let identity = NetworkIdentity::generate().unwrap();
        let signature = identity.sign(b"original");
        assert!(NetworkIdentity::verify(
            &identity.public_key_bytes(),
            b"original",
            &signature
        )
        .is_ok());
        assert!(NetworkIdentity::verify(
            &identity.public_key_bytes(),
            b"modified",
            &signature
        )
        .is_err());
    }
}

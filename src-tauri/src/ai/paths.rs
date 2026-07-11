//! Portierung von BlueTalk v1 `ollama-paths.js`: Auflösung der
//! Ollama-Modellverzeichnisse (BlueTalk-verwaltet vs. System-Ollama).

use std::path::{Component, Path, PathBuf};

pub const BLUETALK_OLLAMA_MODELS_ENV: &str = "BLUETALK_OLLAMA_MODELS";
pub const LEGACY_BLUETALK_OLLAMA_MODELS_ENV: &str = "BLUETALK_OLLAMA_MODELS_DIR";

/// Ergebnis einer Verzeichnis-Auflösung: Pfad + Quelle (für Anzeige/Debug).
#[derive(Debug, Clone)]
pub struct ResolvedModelsDir {
    pub dir: PathBuf,
    pub source: String,
}

/// Entfernt umgebende Anführungszeichen und Whitespace aus einem Env-Wert.
fn clean_custom_models_dir(value: Option<String>) -> String {
    let text = value.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return String::new();
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return text[1..text.len() - 1].trim().to_string();
        }
    }
    text
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Prüft, ob ein Pfad Nicht-ASCII-Zeichen enthält (Ollama-Problem auf Windows).
pub fn has_non_ascii_path_chars(value: &str) -> bool {
    !value.is_ascii()
}

/// Standard-Modellordner im App-Datenverzeichnis.
pub fn default_models_dir(app_user_data_dir: &Path) -> PathBuf {
    app_user_data_dir.join("ollama").join("models")
}

/// Windows-sicherer Modellordner unter %ProgramData% (nur ASCII-Pfad).
pub fn windows_safe_models_dir() -> PathBuf {
    let program_data = clean_custom_models_dir(env_var("ProgramData"));
    let base = if program_data.is_empty() {
        PathBuf::from("C:\\ProgramData")
    } else {
        PathBuf::from(program_data)
    };
    base.join("BlueTalk").join("ollama").join("models")
}

/// Fallback unter %PUBLIC% (Windows), falls %ProgramData% nicht beschreibbar.
pub fn windows_public_models_dir() -> PathBuf {
    let public = clean_custom_models_dir(env_var("PUBLIC"));
    let base = if public.is_empty() {
        PathBuf::from("C:\\Users\\Public")
    } else {
        PathBuf::from(public)
    };
    base.join("BlueTalk").join("ollama").join("models")
}

/// Modellordner des System-Ollama (Modus "system").
pub fn resolve_system_ollama_models_dir() -> ResolvedModelsDir {
    let custom = clean_custom_models_dir(env_var("OLLAMA_MODELS"));
    if !custom.is_empty() {
        return ResolvedModelsDir {
            dir: absolute_lexical(Path::new(&custom)),
            source: "OLLAMA_MODELS".into(),
        };
    }

    if cfg!(windows) {
        let user_profile = clean_custom_models_dir(env_var("USERPROFILE"));
        let home = if !user_profile.is_empty() {
            user_profile
        } else {
            let drive = clean_custom_models_dir(env_var("HOMEDRIVE"));
            let path = clean_custom_models_dir(env_var("HOMEPATH"));
            if !drive.is_empty() && !path.is_empty() {
                format!("{drive}{path}")
            } else {
                String::new()
            }
        };
        let base = if home.is_empty() {
            PathBuf::from("C:\\Users\\Public")
        } else {
            PathBuf::from(home)
        };
        return ResolvedModelsDir {
            dir: base.join(".ollama").join("models"),
            source: "system-default".into(),
        };
    }

    let home = clean_custom_models_dir(env_var("HOME"));
    let base = if home.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(home)
    };
    ResolvedModelsDir {
        dir: base.join(".ollama").join("models"),
        source: "system-default".into(),
    }
}

/// Modellordner für den BlueTalk-verwalteten Modus.
///
/// Priorität: Env `BLUETALK_OLLAMA_MODELS` (bzw. Legacy-Variante) >
/// Windows-sicherer Pfad bei Nicht-ASCII-userData > `<data_dir>/ollama/models`.
pub fn resolve_ollama_models_dir(app_user_data_dir: &Path) -> ResolvedModelsDir {
    let custom = {
        let primary = clean_custom_models_dir(env_var(BLUETALK_OLLAMA_MODELS_ENV));
        if primary.is_empty() {
            clean_custom_models_dir(env_var(LEGACY_BLUETALK_OLLAMA_MODELS_ENV))
        } else {
            primary
        }
    };
    if !custom.is_empty() {
        return ResolvedModelsDir {
            dir: absolute_lexical(Path::new(&custom)),
            source: BLUETALK_OLLAMA_MODELS_ENV.into(),
        };
    }

    let user_models_dir = default_models_dir(app_user_data_dir);
    if cfg!(windows) && has_non_ascii_path_chars(&user_models_dir.to_string_lossy()) {
        return ResolvedModelsDir {
            dir: windows_safe_models_dir(),
            source: "windows-safe".into(),
        };
    }

    ResolvedModelsDir {
        dir: user_models_dir,
        source: "userData".into(),
    }
}

/// Lexikalische Absolut-Normalisierung (löst `.`/`..` ohne Dateisystemzugriff
/// auf, soweit möglich).
pub fn absolute_lexical(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_lexically(&absolute)
}

/// Entfernt `.`- und löst `..`-Komponenten lexikalisch auf.
pub fn normalize_lexically(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push("..");
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// True, wenn `child` gleich `parent` ist oder darin liegt.
pub fn is_same_or_inside_path(child: &Path, parent: &Path) -> bool {
    let child = absolute_lexical(child);
    let parent = absolute_lexical(parent);
    child.starts_with(&parent)
}

/// True, wenn der Pfad auf `…/BlueTalk/ollama/models` endet (case-insensitive)
/// — nur solche Ordner darf BlueTalk beim Reset löschen.
pub fn is_bluetalk_managed_models_dir(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 3 {
        return false;
    }
    let tail: Vec<String> = parts[parts.len() - 3..]
        .iter()
        .map(|p| p.to_lowercase())
        .collect();
    tail[0] == "bluetalk" && tail[1] == "ollama" && tail[2] == "models"
}

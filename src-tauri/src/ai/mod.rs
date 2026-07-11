//! KI-Subsystem (Ollama) — Portierung des BlueTalk-v1-Ollama-Managers
//! (Electron/JS) nach Rust/Tauri 2.
//!
//! Module:
//! - `catalog`  — Modell-Stufen, Cloud-Modelle, System-Prompts, Tool-Schemas
//! - `paths`    — Auflösung der Ollama-Modell-/Runtime-Verzeichnisse
//! - `manager`  — Runtime-/Server-/Download-/Zustands-Verwaltung
//! - `chat`     — Chat-Streaming mit Agent-Loop (Function Calling)
//! - `tools`    — Agent-Tools (Dateisystem, Shell, Web, Memory, BlueTalk)

pub mod catalog;
pub mod chat;
pub mod manager;
pub mod paths;
pub mod tools;

pub use manager::OllamaManager;

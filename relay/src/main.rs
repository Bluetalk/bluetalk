//! BlueTalk Cloud Relay — Einstieg, Env-Config, Tracing, Graceful Shutdown.

use bluetalk_relay::{Config, healthcheck, run};
use tracing_subscriber::EnvFilter;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(healthcheck());
    }

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();

    let config = Config::from_env();
    tracing::info!(
        port = config.port,
        data_dir = %config.data_dir.display(),
        "start"
    );

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("tokio: {err}");
            std::process::exit(1);
        }
    };
    if let Err(err) = rt.block_on(run(config)) {
        tracing::error!(%err, "server");
        std::process::exit(1);
    }
}

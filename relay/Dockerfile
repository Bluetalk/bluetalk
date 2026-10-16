# Build-Kontext: Repo-Root (Dokploy: buildPath "/", Dockerfile "relay/Dockerfile")
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY index.html vite.config.js vite.web-pwa.js ./
COPY public ./public
COPY src ./src
COPY assets ./assets
RUN npm ci && npx vite build --mode web

FROM rust:1-bookworm AS builder
WORKDIR /src

COPY relay/Cargo.toml relay/Cargo.lock ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && echo "" > src/lib.rs \
    && cargo build --release \
    && rm -rf src

COPY relay/src ./src
RUN touch src/lib.rs src/main.rs \
    && cargo build --release \
    && strip target/release/bluetalk-relay

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 65532 --home-dir /data --create-home --shell /usr/sbin/nologin relay \
    && mkdir -p /srv/web \
    && chown relay:relay /srv/web

COPY --from=builder /src/target/release/bluetalk-relay /usr/local/bin/bluetalk-relay
COPY --from=web /src/dist-web /srv/web

ENV PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/srv/web \
    ACCOUNTS_ENABLED=1 \
    SYNC_QUOTA_BYTES=268435456 \
    RUST_LOG=info

USER relay
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bluetalk-relay healthcheck || exit 1

CMD ["bluetalk-relay"]

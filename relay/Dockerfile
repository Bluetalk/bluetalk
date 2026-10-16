# Build-Kontext: Ordner relay/
FROM rust:1-bookworm AS builder
WORKDIR /src

COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && echo "" > src/lib.rs \
    && cargo build --release \
    && rm -rf src

COPY src ./src
RUN touch src/lib.rs src/main.rs \
    && cargo build --release \
    && strip target/release/bluetalk-relay

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 65532 --home-dir /data --create-home --shell /usr/sbin/nologin relay

COPY --from=builder /src/target/release/bluetalk-relay /usr/local/bin/bluetalk-relay

ENV PORT=8080 \
    DATA_DIR=/data \
    RUST_LOG=info

USER relay
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bluetalk-relay healthcheck || exit 1

CMD ["bluetalk-relay"]

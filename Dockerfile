# Paywall service. SQLite is a file inside the container at /data/paywall.sqlite;
# mount a volume on /data to keep it.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app

# Install dependencies first, so code changes don't invalidate this layer.
COPY package.json bun.lock ./
COPY src/contract/package.json src/contract/
COPY src/payments/package.json src/payments/
COPY src/paywall-client/package.json src/paywall-client/
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data && chown bun:bun /data
USER bun

ENV HOST=0.0.0.0 \
    PORT=4242 \
    PAYWALL_CONFIG_PATH=/app/paywall.config.json \
    PAYWALL_DB_PATH=/data/paywall.sqlite
VOLUME /data
EXPOSE 4242

CMD ["bun", "src/payments/index.ts"]

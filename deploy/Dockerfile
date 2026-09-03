# DeepSeek Harness — single-container image for Dokploy.
#
# The image carries the harness only. The `agy` and `opencode` binaries are NOT
# baked in: they are ~200 MB each and not redistributable, so they are supplied
# through a host bind mount at /opt/harness/bin (see docker-compose.yml).
#
# Debian base is deliberate — both binaries are dynamically linked against
# glibc and will not run on an Alpine/musl image.

FROM node:22-bookworm-slim

# git: the agent's own tooling. ripgrep: the harness search path.
# tini: correct signal handling for the three processes the entrypoint runs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      less \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      socat \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Pre-create every mount point while we are still root, so named volumes
# inherit node's ownership instead of coming up owned by root.
RUN mkdir -p /app \
      /workspace \
      /opt/harness/bin \
      /home/node/.dsh \
      /home/node/.gemini \
      /home/node/.config/opencode \
      /home/node/.local/share/opencode \
    && chown -R node:node /app /workspace /home/node

USER node
WORKDIR /app

# One copy + one install: the workspace has 50+ packages, and splitting the
# manifests out for layer caching is more fragile than it is worth here.
COPY --chown=node:node . .

RUN pnpm install --frozen-lockfile \
    && pnpm run build \
    && pnpm store prune

ENV HOME=/home/node \
    PATH=/opt/harness/bin:/home/node/.local/bin:$PATH \
    NODE_ENV=production \
    DSH_PORT=3080 \
    DSH_TRUST_PROXY=1

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:3080/auth/login || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]

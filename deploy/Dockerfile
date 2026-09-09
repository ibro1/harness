# DeepSeek Harness — single-container image for Dokploy.
#
# The image carries the harness only. The `agy` and `opencode` binaries are NOT
# baked in: they are ~200 MB each and not redistributable, so they are supplied
# through a host bind mount at /opt/harness/bin (see docker-compose.yml).
#
# Debian base is deliberate — both binaries are dynamically linked against
# glibc and will not run on an Alpine/musl image.

# ---- WhatsApp sidecar: compile the whatsmeow service ahead of the app image ----
# A static, CGO-free binary (pure-Go SQLite), so it drops into the slim runtime
# with no shared-library or toolchain baggage. go.mod/go.sum are copied first so
# the module download layer caches across source-only changes.
FROM golang:1.27-bookworm AS wa-builder
WORKDIR /src
COPY deploy/whatsapp-svc/go.mod deploy/whatsapp-svc/go.sum ./
RUN go mod download
COPY deploy/whatsapp-svc/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /wa-svc .

FROM node:22-bookworm-slim

# git: the agent's own tooling. ripgrep: the harness search path.
# tini: correct signal handling for the three processes the entrypoint runs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      ffmpeg \
      git \
      less \
      openssh-client \
      procps \
      python3 \
      python3-pip \
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

# video-use skill (fork-local): the conversation-driven video editor
# (github.com/browser-use/video-use). Baked into the image because the
# container FS is otherwise ephemeral and uid 1000 cannot install packages at
# runtime; the entrypoint links it into ~/.dsh/skills so the skill catalog
# discovers it. Only the deps the helpers actually import — librosa and
# matplotlib are declared upstream but unused, so they are skipped to stay lean.
RUN git clone --depth 1 https://github.com/browser-use/video-use /opt/video-use \
    && pip3 install --no-cache-dir --break-system-packages requests numpy pillow \
    && chown -R node:node /opt/video-use

# Fork-local overlays. (1) A provider-agnostic transcriber (ElevenLabs Scribe
# plus Deepgram / AssemblyAI / Groq / OpenAI Whisper) replacing the upstream
# ElevenLabs-only one. (2) speak.py — a TTS/voiceover helper (Gemini + ElevenLabs)
# absent upstream. (3) SKILL.md: upstream's text plus the speak.py + GEMINI_API_KEY
# notes, so the skill catalog surfaces the new helper.
COPY --chown=node:node deploy/skills/video-use/transcribe.py /opt/video-use/helpers/transcribe.py
COPY --chown=node:node deploy/skills/video-use/speak.py /opt/video-use/helpers/speak.py
# render.py: a final render auto-backgrounds under the harness and fires the
# bg-notify hook on completion, so a long render never blocks the agent's turn.
COPY --chown=node:node deploy/skills/video-use/render.py /opt/video-use/helpers/render.py
COPY --chown=node:node deploy/skills/video-use/SKILL.md /opt/video-use/SKILL.md

# WhatsApp sidecar binary from the builder stage. /usr/local/bin, not
# /opt/harness/bin — the latter is a host bind mount at runtime and would shadow
# anything baked here.
COPY --from=wa-builder --chmod=755 /wa-svc /usr/local/bin/wa-svc

# The client build stamps the source commit into its metadata and reads it from
# git when this is unset. `.git` is not in the build context (see
# .dockerignore), so the value is supplied instead of shipping the history.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

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

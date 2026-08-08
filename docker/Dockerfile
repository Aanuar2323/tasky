# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim
ARG PYTHON_VERSION=3.11-slim-bookworm

# ---------- 1. Installer: api prod deps (sin dev) ----------
FROM node:${NODE_VERSION} AS api-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/.env.example ./apps/api/
COPY apps/web/package.json apps/web/.env.example ./apps/web/
RUN npm ci --omit=dev --workspace=apps/api --include-workspace-root && npm cache clean --force

# ---------- 2. Installer: web full deps (incluye dev para build) ----------
FROM node:${NODE_VERSION} AS web-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/.env.example ./apps/api/
COPY apps/web/package.json apps/web/.env.example ./apps/web/
RUN npm ci --workspace=apps/web --include-workspace-root && npm cache clean --force

# ---------- 3. Builder: next standalone ----------
FROM node:${NODE_VERSION} AS web-builder
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=web-deps /app/node_modules ./node_modules
COPY --from=web-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json package-lock.json ./
COPY apps/web ./apps/web
RUN npm run build -w apps/web

# ---------- 4. Builder: Python doc-engine deps (target dir, no venv) ----------
FROM python:${PYTHON_VERSION} AS py-deps
RUN pip install --no-cache-dir --quiet --upgrade pip \
    && mkdir -p /opt/docsite
COPY apps/api/docengine/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --quiet --target=/opt/docsite -r /tmp/requirements.txt

# ---------- 5. Runtime ----------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    WEB_PORT=3000 \
    DOC_ENGINE_URL=http://127.0.0.1:8788 \
    STORAGE_ROOT=/app/storage \
    HOME=/tmp \
    NEXT_TELEMETRY_DISABLED=1 \
    PYTHONPATH=/app/apps/api/docengine:/opt/docsite \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini \
        wget \
        python3 \
        libglib2.0-0 \
        libxml2 \
        libxslt1.1 \
        libjpeg62-turbo \
        libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system app \
    && adduser --system --ingroup app app \
    && mkdir -p /app/storage && chown -R app:app /app/storage

# API: deps hoisted a /app/node_modules (monorepo workspaces)
COPY --from=api-deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app apps/api/src ./apps/api/src
COPY --chown=app:app apps/api/package.json ./apps/api/package.json
COPY --chown=app:app package.json package-lock.json ./

# Web: standalone build (incluye sus propias node_modules treezadas por Next)
COPY --from=web-builder --chown=app:app /app/apps/web/.next/standalone ./apps/web/standalone
COPY --from=web-builder --chown=app:app /app/apps/web/.next/static ./apps/web/standalone/apps/web/.next/static
COPY --from=web-builder --chown=app:app /app/apps/web/public ./apps/web/standalone/apps/web/public

# Python doc-engine: paquetes instalados en /opt/docsite + código fuente
COPY --from=py-deps --chown=app:app /opt/docsite /opt/docsite
COPY --chown=app:app apps/api/docengine ./apps/api/docengine

# Entrypoint (procesos API + web + doc-engine)
COPY --chown=app:app docker/entrypoint.mjs /usr/local/bin/entrypoint.mjs

USER app
EXPOSE 8787 3000 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null \
  && wget -qO- http://127.0.0.1:8788/health >/dev/null \
  && wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/usr/local/bin/entrypoint.mjs"]

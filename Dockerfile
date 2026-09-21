# Node version must match package.json "engines".
FROM node:22.18.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.18.0-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Security patches for the pinned base image's OS packages (Trivy fixed-only HIGH/CRITICAL at
# build time). Bumping the Node base tag (and engines.node with it) makes this obsolete.
# npm/npx are only needed to install deps (deps stage); the runtime runs plain node, so drop
# them (their bundled tar/glob/minimatch/... are otherwise scanned as part of the image).
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade \
      gpgv libcap2 libgnutls30 libpam-modules libpam-modules-bin libpam-runtime libpam0g libpcre2-8-0 perl-base \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 3000
# Plain node (not npm start) so SIGTERM reaches app.js's graceful-shutdown handler.
CMD ["node", "app.js"]

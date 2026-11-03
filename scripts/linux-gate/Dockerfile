FROM node:24.22.2-bookworm-slim@sha256:e80dee4ed3709cf1f8004e34ecfb90df71b7eac8ba0d7d6222ba238a823d1eea AS node24
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:f609973e8fd93f38a5ddfd706a65805294247dae8d81b2541c0afe2787746197 AS lsof-build
RUN apt-get update \
 && apt-get install --yes --no-install-recommends build-essential curl pkg-config libtirpc-dev libselinux1-dev \
 && rm -rf /var/lib/apt/lists/*
COPY install-lsof.sh /tmp/install-lsof.sh
RUN sh /tmp/install-lsof.sh /opt/swc-lsof
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:f609973e8fd93f38a5ddfd706a65805294247dae8d81b2541c0afe2787746197

COPY --from=node24 /usr/local/ /usr/local/
COPY --from=lsof-build /opt/swc-lsof/ /usr/local/
RUN npm install --global npm@11.12.1 pnpm@11.9.0 --ignore-scripts --no-audit --no-fund \
 && test "$(node --version)" = v24.22.2 \
 && test "$(npm --version)" = 11.12.1 \
 && apt-get update \
 && apt-get install --yes --no-install-recommends \
    ffmpeg=7:6.1.1-3ubuntu5 \
    git=1:2.43.0-1ubuntu7.4 \
    libtirpc3t64=1.3.4+ds-1.1build1 \
    libselinux1=3.5-2ubuntu2.1 \
    procps=2:4.0.4-4ubuntu3.3 \
    python3 \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg-query --show > /opt/swc-linux-packages.tsv \
 && lsof -v
RUN npm install --prefix /opt/swc-playwright --no-audit --no-fund --ignore-scripts playwright@1.64.1 \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/swc-browsers /opt/swc-playwright/node_modules/.bin/playwright install chromium \
 && chmod -R a+rX /opt/swc-browsers \
 && rm -rf /opt/swc-playwright
COPY container.mjs sandbox-probe.mjs /opt/swc-linux-gate/
ENV CI=true NEXT_TELEMETRY_DISABLED=1 TZ=UTC LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/opt/swc-browsers
USER pwuser
WORKDIR /home/pwuser
ENTRYPOINT ["node", "/opt/swc-linux-gate/container.mjs"]

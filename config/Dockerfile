# ---------------------------------------------------------------------------
# Stage 1 — the web root, built (roadmap 2.1; tools/build-web.mjs).
#
# What nginx serves is not the source tree: the page's hundred-odd scripts are
# joined and minified into six files named by their content, the module bundle
# is one file, and sw.js precaches those. Nothing is built on a server: this
# image is built once, on the machine that deploys (scripts/deploy.sh
# --prebuilt), and every server pulls the same digest. The builder needs the
# npm registry; the servers never do.
#
# By digest, like the relay's Node: the same commit builds on the same base.
# Built on the builder's own architecture: what comes out is JavaScript, and it is
# byte for byte the same built natively on arm64 and under emulation for amd64
# (checked), so there is nothing to emulate and nothing to differ.
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS web
WORKDIR /build
COPY package.json package-lock.json ./
# --ignore-scripts: nothing a dependency wants to run at install is wanted here;
# the native parts (Vite's, esbuild's) arrive as optional packages, not scripts.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tools/build-web.mjs tools/build-web.mjs
COPY index.html manifest.webmanifest monitor-client.html sw.js ./
COPY css css
COPY js js
COPY vendor vendor
COPY fonts fonts
COPY assets assets
RUN node tools/build-web.mjs \
 && test -f dist/web/index.html && test -d dist/web/build

# ---------------------------------------------------------------------------
# Stage 2 — nginx.
# nginx 1.31.8, the newest mainline release, pinned for the same reason as the
# relay's Node: nginx:alpine meant whichever copy the machine happened to hold.
FROM nginx:1.31.8-alpine@sha256:fed7e14be83cbd2661a75cdc5b872d936cf155d46c327084d30b8df19ae88d72
# Room for many proxied sockets: nginx's stock 1024 connections per worker,
# two per WebSocket, was a second ceiling near 500 people per server.
RUN rm /etc/nginx/conf.d/default.conf \
 && sed -i 's/worker_connections[[:space:]]*[0-9]*;/worker_connections 16384;/' /etc/nginx/nginx.conf \
 && sed -i '/^worker_processes/a worker_rlimit_nofile 65536;' /etc/nginx/nginx.conf \
 && grep -q 'worker_connections 16384;' /etc/nginx/nginx.conf \
 && grep -q 'worker_rlimit_nofile 65536;' /etc/nginx/nginx.conf
# A template, not a finished config. The official entrypoint runs envsubst over
# /etc/nginx/templates and writes the result into conf.d before nginx starts,
# so APP_DOMAIN, APP_ORIGIN and APP_ORIGIN_WS come from the environment of THIS
# container -- which is how one image serves two servers under their own names.
# envsubst only replaces names that are actually set in the environment, so
# nginx's own $host, $scheme and $http_upgrade pass through untouched.
COPY config/nginx.conf /etc/nginx/templates/default.conf.template
# The relay's mirror addresses go into the CSP before the template renders.
COPY --chmod=755 config/nginx-mirror-csp.sh /docker-entrypoint.d/15-mirror-csp.sh
ENV NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/rendered-templates
# The built web root. The dashboard page (monitor-client.html) was never part of
# this image, and the build copies it along: it is left out as it always was.
COPY --from=web /build/dist/web/ /usr/share/nginx/html/
RUN rm -f /usr/share/nginx/html/monitor-client.html
EXPOSE 1122
CMD ["nginx", "-g", "daemon off;"]

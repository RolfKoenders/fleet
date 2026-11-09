# The landing page (site/) as a container, served under /fleet/ (rolflab.nl/fleet).
# Build from the repo root: docker build -f deploy/Dockerfile .
FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/fleet/
COPY assets/social-preview.png /usr/share/nginx/html/fleet/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/fleet/ >/dev/null || exit 1

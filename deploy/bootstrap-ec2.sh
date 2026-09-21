#!/usr/bin/env bash
# One-time host preparation for Amazon Linux 2023 (plan 6.3). Review it, then run as root:
#   sudo bash deploy/bootstrap-ec2.sh
# Idempotent: safe to re-run. Installs docker, nginx, git, the pinned Compose + Buildx plugins
# (checksum-verified: AL2023 doesn't package them), certbot in a venv, and a 2 GB swapfile.
# It does NOT touch nginx site config, TLS, secrets or the app: see deploy/nginx-vyas.conf and the checklist.
# SKIP_SYSTEMD=1 / SKIP_SWAP=1 exist so the package steps can be tested in a container.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

COMPOSE_VERSION=v5.5.1
BUILDX_VERSION=v0.37.1
case "$(uname -m)" in
  x86_64)
    COMPOSE_ASSET=docker-compose-linux-x86_64
    COMPOSE_SHA256=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576
    BUILDX_ASSET=buildx-${BUILDX_VERSION}.linux-amd64
    BUILDX_SHA256=9447199cdb435f25880548343c128a4b6650e8891ee598905d8d29d39a8e359b ;;
  aarch64)
    COMPOSE_ASSET=docker-compose-linux-aarch64
    COMPOSE_SHA256=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7
    BUILDX_ASSET=buildx-${BUILDX_VERSION}.linux-arm64
    BUILDX_SHA256=e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2 ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
PLUGIN_DIR=/usr/local/lib/docker/cli-plugins

echo "==> Packages"
dnf install -y docker nginx git python3 python3-pip augeas-libs

echo "==> Docker CLI plugins (pinned + checksum-verified)"
install_plugin() { # name url sha256
  local dest="$PLUGIN_DIR/$1" tmp
  if [ -x "$dest" ] && echo "$3  $dest" | sha256sum -c --status; then echo "  $1 already installed"; return; fi
  tmp=$(mktemp)
  curl -fsSL -o "$tmp" "$2"
  echo "$3  $tmp" | sha256sum -c - || { rm -f "$tmp"; echo "Checksum mismatch for $1" >&2; exit 1; }
  install -D -m 0755 "$tmp" "$dest"; rm -f "$tmp"
}
install_plugin docker-compose "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/${COMPOSE_ASSET}" "$COMPOSE_SHA256"
install_plugin docker-buildx  "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/${BUILDX_ASSET}" "$BUILDX_SHA256"

echo "==> certbot (venv in /opt/certbot)"
[ -x /opt/certbot/bin/python ] || python3 -m venv /opt/certbot
/opt/certbot/bin/pip install --quiet --upgrade pip
/opt/certbot/bin/pip install --quiet --upgrade certbot certbot-nginx
ln -sf /opt/certbot/bin/certbot /usr/bin/certbot

if [ -z "${SKIP_SWAP:-}" ]; then
  echo "==> 2 GB swapfile (build / OOM safety)"
  if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
    [ -f /swapfile ] || { dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
    swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ -z "${SKIP_SYSTEMD:-}" ]; then
  echo "==> Services"
  systemctl enable --now docker
  systemctl enable --now nginx
  id ec2-user >/dev/null 2>&1 && usermod -aG docker ec2-user # takes effect on next login

  echo "==> certbot auto-renew (systemd timer)"
  cat > /etc/systemd/system/certbot-renew.service <<'UNIT'
[Unit]
Description=Renew Let's Encrypt certificates

[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
UNIT
  cat > /etc/systemd/system/certbot-renew.timer <<'UNIT'
[Unit]
Description=Twice-daily certbot renewal

[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now certbot-renew.timer
fi

echo "==> Versions"
docker --version
docker compose version
docker buildx version
nginx -v
certbot --version
echo "Done. Next: secrets in /opt/vyas (chmod 600), clone the repo, deploy/deploy.sh."

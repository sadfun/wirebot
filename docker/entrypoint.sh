#!/bin/sh
# Prepares the /data volume and drops to the agent user. Everything under
# /data survives image updates; the rest of the filesystem is the image.
set -eu

mkdir -p /data/home /data/workspace /data/usr-local /data/linuxbrew

if [ "$(id -u)" = "0" ]; then
  if [ ! -e /data/.wirebot-initialized ]; then
    cp -a /opt/wirebot/seed/usr-local/. /data/usr-local/
    cp -a /etc/skel/. /data/home/
    date -u +"%Y-%m-%dT%H:%M:%SZ" > /data/.wirebot-initialized
    chown -R wirebot:wirebot /data
  fi
  chown wirebot:wirebot /data /data/home /data/workspace /data/usr-local /data/linuxbrew
  # gh reads GH_TOKEN directly; configure Git's HTTPS helper in the persistent
  # agent home so clone/fetch operations work headlessly as the wirebot user.
  if [ -n "${GH_TOKEN:-}" ]; then
    setpriv --reuid wirebot --regid wirebot --init-groups gh auth setup-git >/dev/null 2>&1 || true
  fi
  exec setpriv --reuid wirebot --regid wirebot --init-groups /opt/wirebot/bin/wirebot "$@"
fi

if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

exec /opt/wirebot/bin/wirebot "$@"

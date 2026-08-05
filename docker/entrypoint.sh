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
  exec setpriv --reuid wirebot --regid wirebot --init-groups /opt/wirebot/bin/wirebot "$@"
fi

exec /opt/wirebot/bin/wirebot "$@"

#!/bin/sh
set -e

# Create user and group
if ! getent group vocipher >/dev/null 2>&1; then
    groupadd --system vocipher
fi
if ! getent passwd vocipher >/dev/null 2>&1; then
    useradd --system --gid vocipher --home-dir /var/lib/vocipher --shell /usr/sbin/nologin vocipher
fi

# Create data directory
mkdir -p /var/lib/vocipher
chown vocipher:vocipher /var/lib/vocipher
chmod 750 /var/lib/vocipher

# Install default config if not present
if [ ! -f /etc/vocipher/config.yaml ]; then
    cp /etc/vocipher/config.yaml.default /etc/vocipher/config.yaml
    chown root:vocipher /etc/vocipher/config.yaml
    chmod 640 /etc/vocipher/config.yaml
fi

# Enable and start service
systemctl daemon-reload
systemctl enable vocipher.service
echo "Vocipher installed. Edit /etc/vocipher/config.yaml then run:"
echo "  systemctl start vocipher"

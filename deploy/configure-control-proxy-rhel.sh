#!/usr/bin/env bash
# Add a root-managed proxy credential; do not change console mode or DB roles.
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run as root on archival.'
CONF=/etc/nginx/conf.d/convox-dr-console.conf
[[ -f "$CONF" && -d /etc/convox-console ]] || fail 'Existing archival console deployment required.'
grep -Fq 'auth_basic_user_file /etc/nginx/convox-console/operators.htpasswd;' "$CONF" || fail 'Expected operator authentication is missing.'
grep -Fq 'proxy_pass http://127.0.0.1:4180;' "$CONF" || fail 'Unexpected proxy destination.'
[[ -s /etc/nginx/convox-console/operators.htpasswd ]] || fail 'Operator password file missing.'
[[ ! -e /etc/convox-console/proxy-secret && ! -e /etc/nginx/convox-console/proxy-token.conf ]] || fail 'Proxy credential exists; inspect instead of rotating.'
umask 077
PROXY_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$PROXY_TOKEN" > /etc/convox-console/proxy-secret
chown root:convoxconsole /etc/convox-console/proxy-secret
chmod 0640 /etc/convox-console/proxy-secret
printf 'proxy_set_header X-Console-Proxy "%s";\n' "$PROXY_TOKEN" > /etc/nginx/convox-console/proxy-token.conf
chmod 0600 /etc/nginx/convox-console/proxy-token.conf
unset PROXY_TOKEN
BACKUP="$(mktemp /root/convox-console-nginx-before-control.XXXXXX)"
cp -p "$CONF" "$BACKUP"
sed -i '/proxy_pass http:\/\/127\.0\.0\.1:4180;/a\        include /etc/nginx/convox-console/proxy-token.conf;\n        proxy_set_header X-Console-Operator $remote_user;' "$CONF"
restorecon /etc/convox-console/proxy-secret /etc/nginx/convox-console/proxy-token.conf "$CONF"
nginx -t || fail "Nginx validation failed. Restore the private backup $BACKUP before reloading."
systemctl reload nginx
printf 'Authenticated proxy credential configured without exposing it. Console mode is unchanged. Configuration backup: %s\n' "$BACKUP"

#!/usr/bin/env bash
# Initial installation only. Review deploy/RHEL_NGINX.md before running as root.
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root on the management server (archival).'
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONSOLE_HOST="${CONSOLE_HOST:-10.3.0.151}"
HTTPS_PORT="${CONSOLE_HTTPS_PORT:-443}"
[[ "$CONSOLE_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail 'CONSOLE_HOST must be an IPv4 address or DNS name, without a scheme, path or port.'
[[ "$HTTPS_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'Invalid CONSOLE_HTTPS_PORT.'
(( 10#$HTTPS_PORT >= 1 && 10#$HTTPS_PORT <= 65535 )) || fail 'Invalid HTTPS port.'
HTTPS_PORT="$((10#$HTTPS_PORT))"
[[ "$HTTPS_PORT" != 4180 ]] || fail 'Port 4180 is reserved for the loopback backend.'
PUBLIC_ORIGIN="https://${CONSOLE_HOST}$([[ $HTTPS_PORT == 443 ]] || printf ':%s' "$HTTPS_PORT")"
[[ ! -e /opt/convox-dr-console && ! -L /opt/convox-dr-console ]] || fail '/opt/convox-dr-console already exists; do not overwrite an existing controller.'
[[ ! -e /etc/nginx/conf.d/convox-dr-console.conf ]] || fail 'Console Nginx configuration already exists.'
[[ ! -e /etc/systemd/system/convox-dr-console.service ]] || fail 'Console service already exists.'
[[ ! -e /etc/convox-console/console.env ]] || fail 'Console environment already exists.'
for COMMAND in nginx curl ss ip systemctl install getent; do
    command -v "$COMMAND" >/dev/null || fail "Required command not found: $COMMAND"
done
[[ -x /usr/bin/node ]] || fail 'Install Node.js 22 or newer at /usr/bin/node first.'
/usr/bin/node -e 'if(Number(process.versions.node.split(".")[0])<22) process.exit(1)' || fail 'Node.js 22 or newer is required.'
/usr/bin/node --input-type=module -e 'import {isIP} from "node:net"; const h=process.argv[1]; if(h.length>253 || (/^[0-9.]+$/.test(h) ? isIP(h)!==4 : h.split(".").some(l=>! /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l)))) process.exit(1)' "$CONSOLE_HOST" || fail 'Invalid IPv4 address or DNS name in CONSOLE_HOST.'
if /usr/bin/node --input-type=module -e 'import {isIP} from "node:net"; process.exit(isIP(process.argv[1])===4 ? 0 : 1)' "$CONSOLE_HOST"; then
    ip -4 -o address show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$CONSOLE_HOST" || fail "This host does not have management IP ${CONSOLE_HOST}."
fi
nginx -t || fail 'Fix the existing Nginx configuration first; no changes were made.'
[[ -z "$(ss -H -lnt "sport = :${HTTPS_PORT}")" ]] || fail "TCP port ${HTTPS_PORT} is occupied. Inspect listeners or use CONSOLE_HTTPS_PORT=8443."
[[ -z "$(ss -H -lnt 'sport = :4180')" ]] || fail 'Loopback backend port 4180 is occupied.'
[[ -d /etc/nginx/conf.d ]] || fail 'Expected /etc/nginx/conf.d on RHEL.'
getent group nginx >/dev/null || fail 'Expected nginx worker group. Check the nginx package installation.'
for FILE in server.crt server.key operators.htpasswd; do
    [[ -s "/etc/nginx/convox-console/${FILE}" ]] || fail "Provision /etc/nginx/convox-console/${FILE} first."
done
grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/conf.d/\*\.conf;' /etc/nginx/nginx.conf || fail 'Confirm /etc/nginx/conf.d/*.conf is included in the http context before installation.'
if getent passwd convoxconsole >/dev/null; then
    [[ "$(id -u convoxconsole)" != 0 ]] || fail 'convoxconsole must not be root.'
    [[ "$(id -gn convoxconsole)" == convoxconsole ]] || fail 'Existing account needs matching convoxconsole group.'
else
    useradd --system --user-group --home-dir /var/lib/convox-dr-console --shell /sbin/nologin convoxconsole
fi

install -d -o root -g root -m 0755 /opt/convox-dr-console
install -m 0644 "$SOURCE_DIR/server.mjs" "$SOURCE_DIR/package.json" /opt/convox-dr-console/
for DIRECTORY in lib public; do
    install -d -m 0755 "/opt/convox-dr-console/${DIRECTORY}"
    find "$SOURCE_DIR/$DIRECTORY" -maxdepth 1 -type f -exec install -m 0644 -t "/opt/convox-dr-console/${DIRECTORY}" {} +
done
install -d -o root -g convoxconsole -m 0750 /etc/convox-console
install -o root -g convoxconsole -m 0640 "$SOURCE_DIR/deploy/console.env" /etc/convox-console/console.env
sed -i "s|^CONVOX_PUBLIC_ORIGIN=.*|CONVOX_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}|" /etc/convox-console/console.env
install -m 0644 "$SOURCE_DIR/deploy/convox-dr-console.service" /etc/systemd/system/convox-dr-console.service
install -o root -g nginx -m 0640 "$SOURCE_DIR/deploy/convox-dr-console.conf" /etc/nginx/conf.d/convox-dr-console.conf
sed -i -e "s|listen 443 ssl;|listen ${HTTPS_PORT} ssl;|" -e "s|server_name 10.3.0.151;|server_name ${CONSOLE_HOST};|" /etc/nginx/conf.d/convox-dr-console.conf
chown root:nginx /etc/nginx/convox-console/operators.htpasswd
chmod 0640 /etc/nginx/convox-console/operators.htpasswd
chmod 0600 /etc/nginx/convox-console/server.key
if command -v restorecon >/dev/null; then
    restorecon -RF /opt/convox-dr-console /etc/convox-console /etc/nginx/convox-console /etc/nginx/conf.d/convox-dr-console.conf /etc/systemd/system/convox-dr-console.service
fi
systemctl daemon-reload
systemctl enable --now convox-dr-console.service
curl --fail --silent --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 --output /dev/null http://127.0.0.1:4180/ || fail 'Backend health check failed. Inspect journalctl -u convox-dr-console.'
nginx -t || fail 'New Nginx configuration failed validation. Restore the console config outside the included directory before reloading.'
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
printf '\nInstalled on the management host in simulation mode. Open %s\n' "$PUBLIC_ORIGIN"
printf 'Verify certificate trust, operator login, SELinux proxy permission and the management firewall rule as described in deploy/RHEL_NGINX.md.\n'

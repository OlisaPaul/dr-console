#!/usr/bin/env bash
# Initial installation only. Review deploy/RHEL_NGINX.md before running as root.
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root on the DR server.'
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
HTTPS_PORT="${CONSOLE_HTTPS_PORT:-443}"
[[ "$HTTPS_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'Invalid CONSOLE_HTTPS_PORT.'
(( 10#$HTTPS_PORT >= 1 && 10#$HTTPS_PORT <= 65535 )) || fail 'Invalid HTTPS port.'
[[ ! -e /opt/convox-dr-console && ! -L /opt/convox-dr-console ]] || fail '/opt/convox-dr-console already exists; do not overwrite an existing controller.'
[[ ! -e /etc/nginx/conf.d/convox-dr-console.conf ]] || fail 'Console Nginx configuration already exists.'
[[ ! -e /etc/systemd/system/convox-dr-console.service ]] || fail 'Console service already exists.'
[[ ! -e /etc/convox-console/console.env ]] || fail 'Console environment already exists.'
for COMMAND in nginx curl ss ip systemctl install getent; do
    command -v "$COMMAND" >/dev/null || fail "Required command not found: $COMMAND"
done
[[ -x /usr/bin/node ]] || fail 'Install Node.js 22 or newer at /usr/bin/node first.'
/usr/bin/node -e 'if(Number(process.versions.node.split(".")[0])<22) process.exit(1)' || fail 'Node.js 22 or newer is required.'
ip -4 -o address show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq 10.3.0.150 || fail 'This host does not have DR IP 10.3.0.150.'
nginx -t || fail 'Fix the existing Nginx configuration first; no changes were made.'
[[ -z "$(ss -H -lnt "sport = :${HTTPS_PORT}")" ]] || fail "TCP port ${HTTPS_PORT} is occupied. Inspect listeners or use CONSOLE_HTTPS_PORT=8443."
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
sed -i "s|^CONVOX_PUBLIC_ORIGIN=.*|CONVOX_PUBLIC_ORIGIN=https://10.3.0.150$([[ $HTTPS_PORT == 443 ]] || printf ':%s' "$HTTPS_PORT")|" /etc/convox-console/console.env
install -m 0644 "$SOURCE_DIR/deploy/convox-dr-console.service" /etc/systemd/system/convox-dr-console.service
install -o root -g nginx -m 0640 "$SOURCE_DIR/deploy/convox-dr-console.conf" /etc/nginx/conf.d/convox-dr-console.conf
sed -i "s|listen 10.3.0.150:443 ssl;|listen 10.3.0.150:${HTTPS_PORT} ssl;|" /etc/nginx/conf.d/convox-dr-console.conf
chown root:nginx /etc/nginx/convox-console/operators.htpasswd
chmod 0640 /etc/nginx/convox-console/operators.htpasswd
chmod 0600 /etc/nginx/convox-console/server.key
if command -v restorecon >/dev/null; then
    restorecon -RF /opt/convox-dr-console /etc/convox-console /etc/nginx/convox-console /etc/nginx/conf.d/convox-dr-console.conf /etc/systemd/system/convox-dr-console.service
fi
systemctl daemon-reload
systemctl enable --now convox-dr-console.service
curl --fail --silent --output /dev/null http://127.0.0.1:4180/ || fail 'Backend health check failed. Inspect journalctl -u convox-dr-console.'
nginx -t || fail 'New Nginx configuration failed validation. Restore the console config outside the included directory before reloading.'
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
printf '\nInstalled in simulation mode. Open https://10.3.0.150%s\n' "$([[ $HTTPS_PORT == 443 ]] || printf ':%s' "$HTTPS_PORT")"
printf 'Verify certificate trust, operator login, SELinux proxy permission and the management firewall rule as described in deploy/RHEL_NGINX.md.\n'

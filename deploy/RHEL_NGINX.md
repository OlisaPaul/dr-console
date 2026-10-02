# Install the recovery console on archival

Management endpoint: **https://10.3.0.151** on port 443. Production remains **10.81.0.11** and DR remains **10.3.0.150**. These instructions assume archival runs RHEL. Do not run this installer unchanged on Ubuntu.

This is the **simulation prototype**: it does not connect to, restore or promote either managed server. The independent management host avoids losing the console when ConVox services are fenced, but archival itself remains a single point of failure. Never include its console or Nginx in production/DR fencing.

## 1. Upload from Windows

```powershell
scp C:\Users\DEEPIJA\Documents\ConVoxCCS\dr-console\artifacts\convox-dr-console-deploy.zip root@10.3.0.151:/root/
```

Use your normal archival SSH account if root SSH is disabled. Move the package to /root/ using sudo. Run remaining commands **on archival as root**, not on either managed server.

## 2. Prerequisites

```bash
cat /etc/redhat-release
node --version
command -v node
ip -4 -br address
ss -lntp | grep -E ':(443|4180|8443)[[:space:]]'
dnf install nginx httpd-tools openssl unzip curl
nginx -t
```

Requires Node.js >=22 at /usr/bin/node. Inspect `dnf module list nodejs` and install an available supported >=22 stream through your approved RHEL repositories; do not copy Windows Node binaries onto Linux. The installer requires /etc/nginx/conf.d/*.conf included in the Nginx http context and free ports 443 and 4180. Fix existing syntax errors first and keep backups outside included directories. Do not stop unrelated services just to free a port.

## 3. TLS and operator login

```bash
install -d -m 0750 -o root -g nginx /etc/nginx/convox-console
```

Preferred: provision an internal-CA certificate with IP SAN **10.3.0.151**, placing the chain at /etc/nginx/convox-console/server.crt and the private key at /etc/nginx/convox-console/server.key.

For private testing only, generate a temporary self-signed certificate. Run this only if these files do not already exist; do not overwrite an existing certificate or private key:

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 -keyout /etc/nginx/convox-console/server.key -out /etc/nginx/convox-console/server.crt -subj '/CN=10.3.0.151' -addext 'subjectAltName=IP:10.3.0.151'
openssl x509 -in /etc/nginx/convox-console/server.crt -noout -fingerprint -sha256
```

Verify the fingerprint through a trusted administration channel and trust the certificate on your management PC using your normal certificate process. Do not disable verification. Distribute only the certificate, never the private key.

For a **new** operator password file:

```bash
htpasswd -cB /etc/nginx/convox-console/operators.htpasswd operator
chmod 0600 /etc/nginx/convox-console/server.key
chown root:nginx /etc/nginx/convox-console/operators.htpasswd
chmod 0640 /etc/nginx/convox-console/operators.htpasswd
```

Use -c only for a NEW password file. To preserve existing operators, use `htpasswd -B /etc/nginx/convox-console/operators.htpasswd username`. Every static/API request requires Nginx login; the application session token additionally protects against cross-site requests.

## 4. Install

Use a new empty extraction directory; do not extract over an existing package:

```bash
install -d -m 0700 /root/convox-console-package
unzip /root/convox-dr-console-deploy.zip -d /root/convox-console-package
bash /root/convox-console-package/deploy/install-rhel.sh
systemctl enable nginx
```

The initial installer refuses existing controller/configuration files. It creates a non-login convoxconsole account, root-owned code at /opt/convox-dr-console and private state at /var/lib/convox-dr-console. Nginx proxies HTTPS requests to **127.0.0.1:4180**. No SSH keys or real-server hooks are installed.

The default is archival on port 443. For another management IP or DNS name, provision matching TLS and pass CONSOLE_HOST. IPv4 hosts must be configured on the server; DNS names must resolve to it from management clients:

```bash
CONSOLE_HOST=10.3.0.151 CONSOLE_HTTPS_PORT=443 bash /root/convox-console-package/deploy/install-rhel.sh
```

These are initial-install settings, not upgrade commands. Port 8443 is optional; the installer updates both listener and public origin. Verify its SELinux HTTP port label using `semanage port -l | grep http_port_t` before using a nonstandard port. Never reassign a port belonging to another service.

## 5. SELinux and management firewall

```bash
getenforce
getsebool httpd_can_network_connect
```

An enforcing reverse-proxy setup may require this under your server policy:

```bash
setsebool -P httpd_can_network_connect 1
```

This permission covers outbound connections from the web-server SELinux domain, not only this console. Keep SELinux enforcing and inspect AVC denials rather than disabling it.

If firewalld runs, inspect `firewall-cmd --get-active-zones`. For a zone **already restricted to management clients**, substitute its real name:

```bash
firewall-cmd --zone=YOUR_MANAGEMENT_ZONE --add-service=https
firewall-cmd --permanent --zone=YOUR_MANAGEMENT_ZONE --add-service=https
```

Otherwise use a source-restricted rule for your approved VPN/management network. Nginx listens on all IPv4 interfaces on the selected HTTPS port, so firewall restrictions are important. Do not expose the console to the internet or open port 4180. Routing/VPN access to 10.3.0.151 must exist. For 8443, allow that TCP port instead.

## 6. Verify

```bash
systemctl --no-pager --full status convox-dr-console nginx
curl --fail --silent --output /dev/null http://127.0.0.1:4180/
ss -lntp | grep -E ':(443|4180)[[:space:]]'
journalctl -u convox-dr-console -n 40 --no-pager
curl --cacert /etc/nginx/convox-console/server.crt -o /dev/null -w '%{http_code}\n' https://10.3.0.151/
```

The last request should return **401** without credentials. For an internal CA, use the CA certificate instead of the leaf certificate. Open **https://10.3.0.151**, enter the operator login and confirm **Simulation workspace**. Verify a simulated action works without changing either ConVox server. For port 8443, include :8443 in URLs and checks.

The browser Origin, forwarded Host and /etc/convox-console/console.env public origin must agree exactly. Default: CONVOX_PUBLIC_ORIGIN=https://10.3.0.151. If the endpoint changes later, update Nginx and this value, provision matching TLS, validate Nginx and restart the console. Do not rewrite browser Origin to bypass validation.

## Troubleshooting and removal

- Existing files: inspect before continuing; the installer refuses to overwrite controller history.
- Nginx failure: run nginx -t and inspect port owners. Move obsolete backups outside included directories.
- HTTP 502: inspect console service/journal, loopback listener and SELinux AVCs. Do not expose Node directly.
- HTTP 403: URL, public origin and forwarded Host must match, including any nondefault port.
- Login rejected: inspect password-file permissions and Nginx logs; keep authentication enabled.
- Interrupted installation: inspect created files before any reload. No automatic rollback or upgrade is provided.

To remove the route, move only /etc/nginx/conf.d/convox-dr-console.conf outside included directories, validate Nginx and reload. Stop/disable convox-dr-console.service separately, preserving /var/lib/convox-dr-console for history.

References: [Red Hat Nginx setup](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/deploying_web_servers_and_reverse_proxies/setting-up-and-configuring-nginx_deploying-web-servers-and-reverse-proxies), [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [Nginx Basic Authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html).

# Publish the console through Nginx on DR

The prepared endpoint is `https://10.3.0.150` (TLS port 443). Nginx authenticates operators and proxies to the Node backend at `127.0.0.1:4180`. Apache can keep port 80 for the existing ConVox application. Node's port is never opened to the network.

This installs the **simulation prototype**. It does not configure actual failover/replication hooks. Hosting it on DR is useful for the current test phase, but if DR or its Nginx service is stopped, this endpoint is unavailable. Deploy the management controller independently of both servers before relying on it for operational recovery. Never stop the management controller as part of application fencing.

## 1. Upload

From the Windows workspace, the deployment ZIP contains application code, tests and deployment files, and excludes local demo state, real configuration, credentials and screenshots:

```powershell
scp C:\Users\DEEPIJA\Documents\ConVoxCCS\dr-console\artifacts\convox-dr-console-deploy.zip root@10.3.0.150:/root/
```

Use the SSH account you normally administer DR with if root SSH is disabled. All subsequent commands run on DR as root.

## 2. Check prerequisites and existing listeners

```bash
cat /etc/redhat-release
node --version
command -v node
nginx -t
ss -lntp | grep -E ':(80|443|4180|8443)[[:space:]]'
```

Requires Node.js >=22 at `/usr/bin/node`, Nginx, OpenSSL, unzip and `htpasswd`. RHEL's exact Node.js module availability depends on the OS minor release and enabled repositories. Inspect `dnf module list nodejs` and install an available supported >=22 stream using your normal RHEL package procedure. Do not copy the Windows Node binary onto Linux.

Install missing utilities through the approved RHEL repositories:

```bash
dnf install nginx httpd-tools openssl unzip
```

The previously observed backup `/etc/nginx/sites-enabled/default.bak.2026-09-25_043517` must be moved outside all included configuration directories if it still causes duplicate-default errors. Existing Nginx syntax must pass before installing the console. The installer refuses occupied TLS ports rather than replacing existing virtual hosts. If port 443 is in use, choose 8443 as described below, or review the existing web configuration before merging a new endpoint.

## 3. Provision TLS and operator login

```bash
install -d -m 0750 -o root -g nginx /etc/nginx/convox-console
```

Preferred: obtain an internal-CA certificate with the IP subject alternative name `10.3.0.150`, and place its certificate chain at `/etc/nginx/convox-console/server.crt` and private key at `/etc/nginx/convox-console/server.key`.

For a private test environment, you may generate a temporary self-signed certificate:

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 \
  -keyout /etc/nginx/convox-console/server.key \
  -out /etc/nginx/convox-console/server.crt \
  -subj '/CN=10.3.0.150' \
  -addext 'subjectAltName=IP:10.3.0.150'
```

Ensure the certificate is trusted on your management PC through your normal certificate process before browser use. A self-signed certificate is not automatically trusted. Inspect its fingerprint locally and verify the installed certificate; do not disable certificate validation.

Create the initial operator login; `htpasswd` prompts for the password, so it never appears in command history:

```bash
htpasswd -cB /etc/nginx/convox-console/operators.htpasswd operator
chmod 600 /etc/nginx/convox-console/server.key
chown root:nginx /etc/nginx/convox-console/operators.htpasswd
chmod 640 /etc/nginx/convox-console/operators.htpasswd
```

Use `-c` only when creating a NEW password file. For later operators use `htpasswd -B /etc/nginx/convox-console/operators.htpasswd username` to preserve existing accounts. Every console request, including the session API, is protected by Nginx login. The browser session token is an additional CSRF boundary, not a substitute for operator authentication.

## 4. Install the code and service

```bash
install -d -m 0700 /root/convox-console-package
unzip /root/convox-dr-console-deploy.zip -d /root/convox-console-package
bash /root/convox-console-package/deploy/install-rhel.sh
```

The initial installer refuses existing application/config files and preserves them. It creates a dedicated non-login service user, installs code root-owned under `/opt/convox-dr-console`, keeps state in `/var/lib/convox-dr-console`, and runs only the simulation backend. It validates Nginx before reloading. It leaves firewall and SELinux network policy changes to your explicit administration step below. Do not repeatedly rerun it to update an existing controller.

If you select the alternate endpoint because TLS port 443 is occupied:

```bash
CONSOLE_HTTPS_PORT=8443 bash /root/convox-console-package/deploy/install-rhel.sh
```

The installer sets both the Nginx listener and backend origin to `https://10.3.0.150:8443`. Verify that SELinux labels this port for HTTP services with `semanage port -l | grep http_port_t`. Only add the appropriate port label if it is not already assigned. Do not reassign another service's port blindly.

## 5. Permit the proxy and management access

If SELinux is enforcing, inspect the proxy permission:

```bash
getenforce
getsebool httpd_can_network_connect
```

Red Hat's documented Nginx reverse proxy setup uses:

```bash
setsebool -P httpd_can_network_connect 1
```

This allows network connections from the web-server SELinux domain; it is broader than just this console proxy. Apply it under your server policy. Keep SELinux enforcing and inspect AVCs if access is denied.

For firewalld, identify the zone on the DR interface first:

```bash
firewall-cmd --get-active-zones
```

Use a management-restricted zone or source-specific rule for your actual VPN/management network. For a zone already restricted to management clients, add HTTPS to that zone:

```bash
firewall-cmd --zone=YOUR_MANAGEMENT_ZONE --add-service=https
firewall-cmd --permanent --zone=YOUR_MANAGEMENT_ZONE --add-service=https
```

Replace the placeholder with the actual zone. For 8443, add `--add-port=8443/tcp` instead. Do not expose 4180 or publish the operator console to the internet. Existing routing/VPN access to `10.3.0.150` must already exist.

## 6. Verify

```bash
systemctl --no-pager --full status convox-dr-console nginx
curl --fail --silent --output /dev/null http://127.0.0.1:4180/
ss -lntp | grep -E ':(80|443|4180|8443)[[:space:]]'
journalctl -u convox-dr-console -n 40 --no-pager
```

Verify unauthenticated access receives HTTP 401, using the actual certificate/CA trust chain:

```bash
curl --cacert /etc/nginx/convox-console/server.crt \
  -o /dev/null -w '%{http_code}\n' https://10.3.0.150/
```

For an internal CA, use the CA certificate instead of the leaf certificate for `--cacert`. With a trusted certificate, open `https://10.3.0.150` and enter the operator login. Verify that the page says Simulation workspace and that a simulation action succeeds without an Invalid origin error. For the alternate port, use `https://10.3.0.150:8443` in both checks.

Changing only `proxy_pass` is insufficient: the backend validates the browser Origin and Host. `/etc/convox-console/console.env` therefore contains `CONVOX_PUBLIC_ORIGIN=https://10.3.0.150`; update it and restart the console if the public URL changes. Do not rewrite browser Origin in Nginx to bypass this check.

## Troubleshooting / recovery

- Duplicate default server: inspect all included files; keep backups outside included directories.
- Address already in use: inspect the listener owners and existing virtual hosts. Preserve the ConVox HTTP service; use the alternate console TLS port if needed.
- HTTP 502: verify the Node service, loopback listener and SELinux AVC records. Do not open Node's listener to all interfaces.
- HTTP 403 Invalid origin/host: public origin, browser URL and forwarded Host must agree exactly, including non-default port.
- Login rejected: inspect password-file access and Nginx error logs. Do not remove authentication to make the check pass.
- Interrupted installer: inspect created files and `nginx -t` before any reload. The installer does not attempt an automatic rollback.

To remove the console route safely, move only `/etc/nginx/conf.d/convox-dr-console.conf` to a backup directory outside the include path, validate Nginx, then reload. Stop/disable `convox-dr-console.service` separately. Preserve `/var/lib/convox-dr-console` if you need the operation history.

Reference: [Red Hat Nginx reverse proxy configuration](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/deploying_web_servers_and_reverse_proxies/setting-up-and-configuring-nginx_deploying-web-servers-and-reverse-proxies), [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [Nginx HTTP Basic Authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html).

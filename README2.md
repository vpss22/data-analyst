# eSchool SaaS — VPS deployment README (Docker all-in-one)

Read this whole file before running anything. It is written for the Qoder instance that
operates the VPS, and it is self-contained: every file that must change on the server is
included verbatim, so nothing needs to be re-uploaded from the development machine.

Target server:

| Item | Value |
|---|---|
| Public IPv4 | `92.242.190.112` |
| Domain | `shuledigital.org` |
| Web port | `80` (HTTP), optional `443` for HTTPS |
| Realtime port | `9091` (HTTP mode), proxied on `443` in TLS mode |
| Stack | one container: Apache + PHP 8.3 + MariaDB 10.11 + queue worker + Reverb + scheduler |
| Project directory | directory containing `docker-compose.allinone.yml` (examples use `/opt/eschool`) |

Hard rules for this task:

1. Never run `docker compose ... down -v` unless Phase 4 explicitly confirms the volumes are
   disposable. `-v` deletes the database and all uploaded files.
2. Never print `DB_PASSWORD`, `REVERB_APP_SECRET`, or mail passwords in chat or logs.
3. `.env` must be a **file**, not a directory. If it is a directory, stop and report.
4. Do not modify application code except the single `TrustProxies` line in Phase 10.
5. Stop and report if any check in Phase 1 fails; do not continue with missing files.

Checklist:

- [ ] Phase 1 — inspect current state
- [ ] Phase 2 — replace `docker-compose.allinone.yml`
- [ ] Phase 3 — write production `.env`
- [ ] Phase 4 — decide fresh vs existing volumes
- [ ] Phase 5 — build and start
- [ ] Phase 6 — verify app, services, database
- [ ] Phase 7 — firewall and DNS
- [ ] Phase 8 — first login and hardening
- [ ] Phase 9 — (optional) HTTPS + WSS with Caddy
- [ ] Phase 10 — operations and backups
- [ ] Report back using the template at the end

---

## 0. Why the server needs changes

The uploaded copy was configured before the final Compose revision. Two consequences:

1. **The current `.env` came from the Debian (non-Docker) template.** It contains no
   `DOCKER_*` keys, so Compose falls back to defaults: port **8080**, `APP_URL` =
   `http://localhost:8080`, database `laravel`, password `eschool`, and Reverb
   credentials `CHANGE_ME`. The last one is injected into the container and breaks
   broadcasting, because Compose environment variables override `.env`.
2. **The uploaded compose file cannot bind to loopback or advertise a proxy port
   separately.** The updated file below adds `DOCKER_HTTP_BIND`, `DOCKER_REVERB_BIND`,
   `DOCKER_REVERB_PUBLIC_PORT`, and `DOCKER_REVERB_SCHEME`. These are required for the
   optional HTTPS/WSS phase and harmless for plain HTTP.

The application itself, `Dockerfile.allinone`, and `docker/allinone/*` configs are already
correct on the server. Do not rebuild those files; only the compose file, `.env`, and
runtime state change.

Architecture reminder (important for debugging):

- Application code is **baked into the image**. Editing PHP files inside a running
  container is temporary; rebuild after changing source.
- `.env`, `storage/`, and the MariaDB data directory are **volumes / bind mounts**, so
  they survive rebuilds and must never be deleted casually.
- All five processes run in the same container and therefore share `127.0.0.1`.

---

## 1. Phase 1 — Inspect current state

```bash
cd /opt/eschool        # adjust to the real project directory
pwd
ls -la Dockerfile.allinone docker-compose.allinone.yml docker/php.ini docker/allinone/
```

Required files (Dockerfile and configs come from the upload):

- `Dockerfile.allinone` — first line must be `FROM php:8.3-apache-bookworm`
- `docker/php.ini`
- `docker/allinone/apache.conf`
- `docker/allinone/mariadb.cnf`
- `docker/allinone/supervisord.conf`
- `docker/allinone/entrypoint.sh`
- the Laravel application sources (`artisan`, `app/`, `config/`, `database/`, `public/`)
- `composer.lock` and `vendor/` — this image copies dependencies from the build context
  and does **not** run Composer itself

If the Dockerfile or configs are missing, stop and report which one; do not recreate them
from memory. If only `vendor/` is missing (easy to lose when uploading with an exclude
list), install dependencies with a throwaway Composer container:

```bash
cd /opt/eschool
[ -f vendor/autoload.php ] || docker run --rm -v "$PWD":/app -w /app composer:2 \
  install --no-dev --optimize-autoloader --ignore-platform-reqs
test -f vendor/autoload.php && echo vendor-ok
```

If that command cannot run (no outbound network to Docker Hub or Packagist), stop and
report; the build cannot succeed without `vendor/`.

Check what is running and what volumes exist:

```bash
docker ps -a --filter name=eschool-allinone
docker volume ls | grep eschool-allinone
docker compose -f docker-compose.allinone.yml ps
```

If a container exists but is stopped, start it so its database can be inspected:

```bash
docker compose -f docker-compose.allinone.yml up -d
```

Wait until healthy before querying (max ~3 minutes):

```bash
CID="$(docker compose -f docker-compose.allinone.yml ps -q eschool)"
for i in $(seq 1 90); do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null || echo starting)"
  echo "$i $s"
  [ "$s" = "healthy" ] && break
  sleep 2
done
```

List schemas:

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool sh -c \
  'MYSQL_PWD="$DB_PASSWORD" mariadb --protocol=tcp -h 127.0.0.1 -u "$DB_USERNAME" \
   -N -e "SHOW DATABASES;"'
```

List existing tenant databases recorded by the app (ignore errors if the table does not
exist yet):

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool sh -c \
  'MYSQL_PWD="$DB_PASSWORD" mariadb --protocol=tcp -h 127.0.0.1 -u "$DB_USERNAME" \
   -N -e "SELECT database_name FROM \`$DB_DATABASE\`.schools;"' 2>/dev/null || true
```

Record the output. Phase 4 uses it to decide whether volumes may be removed.

Also record the current user count so you can prove seeding later:

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool sh -c \
  'MYSQL_PWD="$DB_PASSWORD" mariadb --protocol=tcp -h 127.0.0.1 -u "$DB_USERNAME" \
   -N -e "SELECT COUNT(*), MIN(email) FROM \`$DB_DATABASE\`.users;"'
```

Expected on a first boot: `1  superadmin@gmail.com`.

Do not change anything in this phase.

---

## 2. Phase 2 — Replace `docker-compose.allinone.yml`

Back up the uploaded file and write the canonical version. The heredoc is quoted
(`<<'YAML'`) so `${...}` stays literal for Compose to interpolate.

```bash
cd /opt/eschool
cp -a docker-compose.allinone.yml "docker-compose.allinone.yml.bak.$(date +%Y%m%d%H%M%S)"
cat > docker-compose.allinone.yml <<'YAML'
name: eschool-allinone

x-app-environment: &app-environment
  APP_URL: ${DOCKER_APP_URL:-http://localhost:8080}

  DB_CONNECTION: mysql
  DB_HOST: 127.0.0.1
  DB_PORT: "3306"
  DB_DATABASE: ${DOCKER_DB_NAME:-laravel}
  DB_USERNAME: ${DOCKER_DB_USER:-eschool}
  DB_PASSWORD: ${DOCKER_DB_PASSWORD:-eschool}

  CACHE_DRIVER: file
  SESSION_DRIVER: file
  QUEUE_CONNECTION: database
  BROADCAST_DRIVER: reverb

  REVERB_APP_ID: ${REVERB_APP_ID:-413804}
  REVERB_APP_KEY: ${REVERB_APP_KEY:-e2mhe9gu4tb2x2vkncxa}
  REVERB_APP_SECRET: ${REVERB_APP_SECRET:-tfpqsy4pwluxohhvbjig}
  REVERB_SERVER_HOST: 0.0.0.0
  REVERB_SERVER_PORT: ${DOCKER_REVERB_PORT:-9091}
  REVERB_HOST: ${DOCKER_REVERB_HOST:-localhost}
  REVERB_PORT: ${DOCKER_REVERB_PUBLIC_PORT:-9091}
  REVERB_SCHEME: ${DOCKER_REVERB_SCHEME:-http}

services:
  eschool:
    build:
      context: .
      dockerfile: Dockerfile.allinone
    image: eschool-allinone:latest
    restart: unless-stopped
    stop_grace_period: 90s
    environment:
      <<: *app-environment
      RUN_INIT: "true"
      APP_SEED: ${APP_SEED:-true}
    ports:
      - "${DOCKER_HTTP_BIND:-0.0.0.0}:${DOCKER_HTTP_PORT:-8080}:80"
      - "${DOCKER_REVERB_BIND:-0.0.0.0}:${DOCKER_REVERB_PORT:-9091}:${DOCKER_REVERB_PORT:-9091}"
    volumes:
      - ./.env:/var/www/html/.env
      - app_storage:/var/www/html/storage
      - db_data:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "php -r \"exit(@fsockopen('127.0.0.1', 80) ? 0 : 1);\""]
      interval: 15s
      timeout: 5s
      retries: 30
      start_period: 90s

volumes:
  app_storage:
  db_data:
YAML
```

Validate syntax:

```bash
docker compose -f docker-compose.allinone.yml config --quiet && echo compose-config-ok
```

Expected: `compose-config-ok`. Do not continue if Compose prints an error.

---

## 3. Phase 3 — Write the production `.env`

This rewrites `.env` completely for `shuledigital.org`. Secrets are generated on the
server and never printed.

```bash
cd /opt/eschool

# Back up the current template-derived file (may contain placeholders only).
cp -a .env ".env.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true

# Normalize line endings if the file was edited on Windows.
sed -i 's/\r$//' .env 2>/dev/null || true

# Preserve an existing key so a rewrite cannot invalidate encrypted data.
OLD_APP_KEY="$(sed -n 's/^APP_KEY=//p' .env 2>/dev/null | head -1)"

DB_PASS="$(openssl rand -hex 16)"
REVERB_ID="$(shuf -i 100000-999999 -n 1)"
REVERB_KEY="$(openssl rand -hex 16)"
REVERB_SECRET="$(openssl rand -hex 16)"

cat > .env <<EOF
APP_NAME="eSchool Saas - School Management System"
APP_ENV=production
APP_KEY=
APP_DEBUG=false
APP_URL=http://shuledigital.org
DEMO_MODE=false
LOG_CHANNEL=stack
LOG_DEPRECATIONS_CHANNEL=null
LOG_LEVEL=error
TIMEZONE=UTC
APPLANG=en

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=eschool
DB_USERNAME=eschool
DB_PASSWORD=${DB_PASS}
DB_PREFIX=eschool_saas

BROADCAST_DRIVER=reverb
CACHE_DRIVER=file
FILESYSTEM_DISK=local
QUEUE_CONNECTION=database
SESSION_DRIVER=file
SESSION_LIFETIME=120
SESSION_SECURE_COOKIE=false

REVERB_APP_ID=${REVERB_ID}
REVERB_APP_KEY=${REVERB_KEY}
REVERB_APP_SECRET=${REVERB_SECRET}
REVERB_HOST=shuledigital.org
REVERB_PORT=9091
REVERB_SCHEME=http
REVERB_SERVER_HOST=0.0.0.0
REVERB_SERVER_PORT=9091

DOCKER_HTTP_BIND=0.0.0.0
DOCKER_HTTP_PORT=80
DOCKER_APP_URL=http://shuledigital.org
DOCKER_REVERB_BIND=0.0.0.0
DOCKER_REVERB_PORT=9091
DOCKER_REVERB_PUBLIC_PORT=9091
DOCKER_REVERB_HOST=shuledigital.org
DOCKER_REVERB_SCHEME=http
DOCKER_DB_NAME=eschool
DOCKER_DB_USER=eschool
DOCKER_DB_PASSWORD=${DB_PASS}
APP_SEED=true

MAIL_MAILER=smtp
MAIL_HOST=
MAIL_PORT=587
MAIL_USERNAME=
MAIL_PASSWORD=
MAIL_ENCRYPTION=tls
MAIL_FROM_ADDRESS=
MAIL_FROM_NAME="eSchool Saas"

PAYSTACK_PUBLIC_KEY=
PAYSTACK_SECRET_KEY=
PAYSTACK_PAYMENT_URL=https://api.paystack.co
MERCHANT_EMAIL=
RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=
LIVE_TRACKING_WEB_URL=

LOGO1=
LOGO2=
FAVICON=
EOF

# Keep the old key when one existed; otherwise the container generates a new one.
if [ -n "${OLD_APP_KEY:-}" ]; then
  sed -i "s|^APP_KEY=.*|APP_KEY=${OLD_APP_KEY}|" .env
fi

chmod 600 .env
unset DB_PASS REVERB_ID REVERB_KEY REVERB_SECRET OLD_APP_KEY
```

Why each group matters:

| Key group | Consumed by | Effect if wrong |
|---|---|---|
| `DOCKER_HTTP_*`, `DOCKER_REVERB_*` | Docker Compose | wrong host port, wrong public WebSocket address |
| `REVERB_APP_*` | Reverb server + browser | realtime auth/broadcast fails |
| `APP_URL`, `DOCKER_APP_URL` | Laravel + Compose | links, assets and cookies point at localhost |
| `DB_*` and `DOCKER_DB_*` | Laravel + entrypoint | container creates a different DB/user than the app uses |
| `APP_SEED` | entrypoint | repeat seeding attempt on every boot (harmless but noisy) |

Validate the resolved values (prints no secrets):

```bash
docker compose -f docker-compose.allinone.yml config --quiet && echo compose-config-ok
docker compose -f docker-compose.allinone.yml config --format json \
  | grep -E '"(published|host_ip)"' | head
```

Expected published ports: `80` and `9091`.

---

## 4. Phase 4 — Decide fresh vs existing volumes

Compare Phase 1 output with these rules:

**Case A — disposable install (expected on this server).**
Triggered when the databases are only `information_schema`, `mysql`,
`performance_schema`, `sys`, plus `laravel` and/or `eschool`, the tenant list is empty, and
the `users` table contains at most the seeded superadmin. This VPS has no real data yet.

```bash
docker compose -f docker-compose.allinone.yml down -v
```

State in the report that you removed the volumes, and that they only contained the first
seeded install. This makes the new database name (`eschool`) and generated password take
effect cleanly.

**Case B — data exists.**
If any tenant database, school row, or non-seed user exists, the volumes are **not**
disposable:

```bash
docker compose -f docker-compose.allinone.yml down
```

Then edit `.env` and keep the existing database identity:

```dotenv
DB_DATABASE=laravel
DB_PASSWORD=<the password already in the old .env / existing volume>
DOCKER_DB_NAME=laravel
DOCKER_DB_USER=eschool
DOCKER_DB_PASSWORD=<same as DB_PASSWORD>
```

Skip the reset. Report that Case B was used and why.

---

## 5. Phase 5 — Build and start

```bash
cd /opt/eschool
docker compose -f docker-compose.allinone.yml build --pull
docker compose -f docker-compose.allinone.yml up -d
```

First boot initializes MariaDB, creates the app database/user, runs all migrations, seeds
the super admin, writes the `storage/installed` marker, then starts Supervisor. Expect
1–3 minutes.

Follow the boot log (Ctrl+C only stops the log view):

```bash
docker compose -f docker-compose.allinone.yml logs --tail=150 -f eschool
```

Expected: MariaDB ready, migrations, then five programs started: `mariadb`, `apache`,
`queue-worker`, `reverb`, `scheduler`.

Wait for health:

```bash
CID="$(docker compose -f docker-compose.allinone.yml ps -q eschool)"
for i in $(seq 1 90); do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null || echo starting)"
  echo "$i $s"
  [ "$s" = "healthy" ] && break
  sleep 2
done
```

Expected `healthy`. If it never becomes healthy, go to Troubleshooting before changing
anything.

---

## 6. Phase 6 — Verify

### 6.1 HTTP

```bash
curl -sS -o /dev/null -w 'local=%{http_code} time=%{time_total}\n' \
  http://127.0.0.1/login -H 'Host: shuledigital.org'
curl -sS -o /dev/null -w 'ip=%{http_code}\n' http://92.242.190.112/login
```

Expected both `200`.

### 6.2 Container and port mapping

```bash
docker compose -f docker-compose.allinone.yml ps
```

Expected: one container `Up ... (healthy)` with
`0.0.0.0:80->80/tcp` and `0.0.0.0:9091->9091/tcp`.

### 6.3 Five services

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool \
  supervisorctl -c /etc/supervisor/supervisord.conf status
```

Expected, all `RUNNING`: `apache`, `mariadb`, `queue-worker`, `reverb`, `scheduler`.

### 6.4 Runtime configuration

Tinker may be absent when Composer was installed with `--no-dev`, so read the config through
the framework directly (prints no secrets):

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool php -r '
require "vendor/autoload.php";
$app = require "bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
echo config("app.url"), PHP_EOL;
echo config("broadcasting.connections.reverb.options.host"), ":", 
     config("broadcasting.connections.reverb.options.port"), " ", 
     config("broadcasting.connections.reverb.options.scheme"), PHP_EOL;
'
```

Expected: `http://shuledigital.org` and `shuledigital.org:9091 http`.

### 6.5 Database and seed

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool sh -c \
  'MYSQL_PWD="$DB_PASSWORD" mariadb --protocol=tcp -h 127.0.0.1 -u "$DB_USERNAME" \
   -N -e "SELECT COUNT(*), MIN(email) FROM \`$DB_DATABASE\`.users;
          SELECT COUNT(*) FROM \`$DB_DATABASE\`.migrations;"'
```

Expected: `1  superadmin@gmail.com` and `26` or more migrations.

### 6.6 Tenant-database privilege

The app creates one database per school, so the app user needs `CREATE`/`DROP` on `*.*`:

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool sh -c \
  'MYSQL_PWD="$DB_PASSWORD" mariadb --protocol=tcp -h 127.0.0.1 -u "$DB_USERNAME" \
   -e "CREATE DATABASE IF NOT EXISTS eschool_probe; DROP DATABASE eschool_probe;" \
   && echo tenant-db-ok'
```

Expected `tenant-db-ok`.

### 6.7 Reverb socket

```bash
docker compose -f docker-compose.allinone.yml exec -T eschool \
  php -r "exit(@fsockopen('127.0.0.1', 9091) ? 0 : 1);" && echo reverb-open
```

### 6.8 APP_KEY persistence

The entrypoint generates `APP_KEY` on first boot and appends it to the bind-mounted
`.env`. Must print `1`:

```bash
grep -c '^APP_KEY=base64:' /opt/eschool/.env
```

### 6.9 Log scan

```bash
docker compose -f docker-compose.allinone.yml logs --tail=250 eschool \
  | grep -Ei 'error|exception|denied|refused' || echo no-errors
```

Some startup noise is acceptable; report anything recurring.

---

## 7. Phase 7 — Firewall and DNS

```bash
ufw status
```

If UFW is active, allow SSH first to avoid locking yourself out, then HTTP/HTTPS/Reverb:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 9091/tcp
ufw --force enable
```

If UFW is inactive but the VPS provider has a firewall / security group (Hetzner,
Contabo, DigitalOcean, AWS, …), the same four ports must be allowed there. Report which
layer is in use.

DNS must point at this server (set at the registrar, not here):

```bash
dig +short A shuledigital.org
dig +short A www.shuledigital.org
```

Expected `92.242.190.112` for the apex. If it resolves to a CDN/proxy IP (for example
Cloudflare), remember that direct port 9091 will not work; use Phase 9's TLS setup, which
carries both HTTP and WebSocket over 443.

External check, from the operator's own machine (not the VPS):

```bash
curl -I http://shuledigital.org/login
```

Expected `HTTP/1.1 200` or `302`. If the IP check passed but the domain check failed,
report both outputs and the DNS answer; it is a DNS or provider-firewall issue.

---

## 8. Phase 8 — First login and hardening

1. Open `http://shuledigital.org/login`.
2. Log in with `superadmin@gmail.com` / `superadmin`.
3. Change the password immediately from the profile menu.
4. Disable repeat seeding:

```bash
cd /opt/eschool
sed -i 's/^APP_SEED=.*/APP_SEED=false/' .env
docker compose -f docker-compose.allinone.yml up -d
```

5. When mail / Paystack / reCAPTCHA credentials are available, fill them in `.env` and
   re-run `docker compose -f docker-compose.allinone.yml up -d`. `up -d` recreates the
   container when environment values change; volumes are preserved.

Do not put secrets into the shell history deliberately; edit `.env` in place.

---

## 9. Phase 9 — Optional HTTPS + WSS (recommended before real users)

Plain HTTP works on port 80, but browsers will block or degrade microphone/camera use,
and Reverb runs on `ws://shuledigital.org:9091`. With the domain in place, terminate TLS
with Caddy and keep the container on loopback ports.

### 9.1 Trust the local proxy in Laravel

The image bakes the application code, so this change is made in the project and rebuilt.

Check the current line:

```bash
grep -n 'protected \$proxies' app/Http/Middleware/TrustProxies.php
```

Set it to:

```php
protected $proxies = '127.0.0.1';
```

### 9.2 Update `.env`

Replace the relevant values (keep the generated secrets unchanged):

```dotenv
APP_URL=https://shuledigital.org
SESSION_SECURE_COOKIE=true
REVERB_HOST=shuledigital.org
REVERB_PORT=443
REVERB_SCHEME=https
DOCKER_APP_URL=https://shuledigital.org
DOCKER_HTTP_BIND=127.0.0.1
DOCKER_HTTP_PORT=8080
DOCKER_REVERB_BIND=127.0.0.1
DOCKER_REVERB_PORT=9091
DOCKER_REVERB_PUBLIC_PORT=443
DOCKER_REVERB_HOST=shuledigital.org
DOCKER_REVERB_SCHEME=https
```

### 9.3 Install Caddy

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

### 9.4 Caddyfile

Write `/etc/caddy/Caddyfile`:

```caddyfile
shuledigital.org {
    encode gzip
    @ws path /app* /apps*
    handle @ws {
        reverse_proxy 127.0.0.1:9091
    }
    reverse_proxy 127.0.0.1:8080
}
```

### 9.5 Apply

```bash
cd /opt/eschool
docker compose -f docker-compose.allinone.yml build
docker compose -f docker-compose.allinone.yml up -d
systemctl reload caddy || systemctl restart caddy
curl -I https://shuledigital.org/login
```

Expected `HTTP/2 200`. Caddy obtains the certificate automatically; ports 80 and 443 must
be open and DNS must point here. UFW rule for 9091 can be removed once the WebSocket is
served on 443.

### 9.6 Verify realtime in TLS mode

In the browser: log in, open a page that uses live updates or chat, and confirm in
DevTools → Network → WS that the connection to `wss://shuledigital.org/app/...` shows
`101 Switching Protocols` (not a 404/502 and not `wss://...:9091`).

---

## 10. Phase 10 — Operations

Start / stop / restart (data preserved):

```bash
docker compose -f docker-compose.allinone.yml start
docker compose -f docker-compose.allinone.yml stop
docker compose -f docker-compose.allinone.yml restart
```

Logs:

```bash
docker compose -f docker-compose.allinone.yml logs --tail=200 eschool
docker compose -f docker-compose.allinone.yml exec -T eschool tail -n 200 storage/logs/laravel.log
```

Backups (DB + uploads). Verify volume names with `docker volume ls | grep eschool-allinone`:

```bash
mkdir -p /opt/backups
docker run --rm -v eschool-allinone_db_data:/src:ro -v /opt/backups:/out alpine \
  sh -c 'tar czf /out/db-$(date +%F-%H%M).tgz -C /src .'
docker run --rm -v eschool-allinone_app_storage:/src:ro -v /opt/backups:/out alpine \
  sh -c 'tar czf /out/storage-$(date +%F-%H%M).tgz -C /src .'
```

Restore (destructive — confirm with the operator first), stack stopped:

```bash
docker compose -f docker-compose.allinone.yml stop
docker run --rm -v eschool-allinone_db_data:/dst -v /opt/backups:/in alpine \
  sh -c 'cd /dst && rm -rf ./* && tar xzf /in/db-YYYY-MM-DD-HHMM.tgz'
docker compose -f docker-compose.allinone.yml start
```

Update the app (new source uploaded over the same directory; `.env` untouched):

```bash
cd /opt/eschool
docker compose -f docker-compose.allinone.yml build --pull
docker compose -f docker-compose.allinone.yml up -d
```

Disk hygiene (never touches volumes):

```bash
docker system prune -f --filter until=168h
```

Never use `down -v` during normal operations.

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Bind for 0.0.0.0:80 failed: port is already allocated` | Another web server owns port 80: `ss -ltnp \| grep ':80'`; stop Apache/Nginx or choose a different `DOCKER_HTTP_PORT`. |
| `ERROR: /var/www/html/.env is a directory` | Docker created a directory because `.env` was missing at `up` time: `rmdir .env`, rewrite it from Phase 3, `up -d`. |
| Container restarts or exits immediately | `docker compose ... logs --tail=200 eschool`; look for MariaDB initialization or migration failures. |
| Login page returns 500 | Malformed `.env` (CRLF, unquoted spaces, stray quotes) or storage permissions. Run `sed -i 's/\r$//' .env`, check `storage/logs/laravel.log`, restart; entrypoint repairs ownership on boot. |
| `No application encryption key has been specified` | `grep '^APP_KEY' .env`; if empty, restart once (entrypoint appends a key) and re-check `grep -c '^APP_KEY=base64:' .env`. |
| Page loads but realtime/chat does not work | Browser must reach `REVERB_HOST`:`REVERB_PORT`. In HTTP mode open 9091 in UFW **and** the provider firewall; in TLS mode confirm the Caddy WS route and that DevTools shows `wss://shuledigital.org/app/...`. |
| `.env` edits appear ignored | Compose environment overrides `.env`; `docker compose ... up -d --force-recreate`. |
| `Service "eschool" is not running` during `exec` | First boot still in progress, or container exited; check logs. Container name: `eschool-allinone-eschool-1`. |
| Database access denied after changing credentials | The entrypoint re-creates/alters the user for `localhost` and `127.0.0.1` on boot. Ensure `DB_*` and `DOCKER_DB_*` match, then `up -d --force-recreate`. |
| Reverb 404/502 through Caddy | Confirm Caddyfile has `/app*` and `/apps*`, container publishes `127.0.0.1:9091`, and `DOCKER_REVERB_PUBLIC_PORT=443` with `DOCKER_REVERB_SCHEME=https`. |
| Seeding appears to run twice | It cannot; seeding is guarded by a `users` count check. Verify the DB actually used (`echo $DB_DATABASE` inside the container) matches the one you inspected. |
| Build fails on `vendor/autoload.php` | `vendor/` was not uploaded. Upload the project with dependencies (Composer is not run inside this image). |

---

## 12. Report back

Return these results (never include secret values):

1. Project directory and contents check from Phase 1.
2. `docker compose -f docker-compose.allinone.yml ps` output.
3. Health status and boot-log summary.
4. `curl` status codes for `http://127.0.0.1/login` and `http://92.242.190.112/login`.
5. `supervisorctl status` — five lines, all RUNNING.
6. User count, migration count, `tenant-db-ok`, `reverb-open`.
7. `grep -c '^APP_KEY=base64:' .env` — expected `1`.
8. Which Phase 4 case was used (A fresh volumes or B preserved data).
9. `ufw status` and the provider-firewall state for 80/443/9091.
10. `dig +short A shuledigital.org` and whether the operator's external browser opens
    `http://shuledigital.org/login`.
11. Whether Phase 9 (HTTPS/WSS) was applied, and the DevTools WebSocket result if so.

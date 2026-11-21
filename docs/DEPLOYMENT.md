# Deployment and Operations (reference, not a production certification)

## Security boundary and network

The application listens on `127.0.0.1` by default and carries long-lived bearer credentials. **Never** expose its plaintext HTTP listener on the public internet. Place it behind a correctly configured TLS reverse proxy and restrict ingress IP ranges or use a private network. An example Nginx vhost with TLS and client-IP request limiting is in [`deploy/nginx-audit.example.conf`](../deploy/nginx-audit.example.conf). You must replace the domain and certificate paths, obtain certificates, validate your proxy trust topology, and run `nginx -t` before deployment; this template was not exercised here. For global deployments use an additional API gateway/WAF for rate limiting and denial-of-service controls; the Nginx example does not guarantee resilience against distributed attacks.

## Container execution and persistent storage

Build the verified-version image:

```bash
docker build --pull -t audit-trail-api .
docker volume create audit-trail-data
```

Generate `.env` with two *different* random secrets (see README). The file contains local defaults `AUDIT_HOST=127.0.0.1` and `AUDIT_DB_PATH=./data/audit.sqlite`. Docker `--env-file .env` overrides Dockerfile defaults, therefore the two `-e` overrides below are **required**:

```bash
docker run --rm --name audit-trail-api \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file .env -e AUDIT_DB_PATH=/data/audit.sqlite -e AUDIT_HOST=0.0.0.0 \
  -v audit-trail-data:/data -p 127.0.0.1:3000:3000 audit-trail-api
```

The service must not run from multiple containers pointing to the same database; this application assumes one trusted writer process and fails closed on external database changes. It is not a multi-writer distributed system. Access volume data and secrets using the host's least-privilege controls. Prefer encrypted off-host backups.

## Monitoring and alerts

- `GET /health/live` says the HTTP process is alive, not that event collection is reliable.
- `GET /health/ready` returns `503` if integrity is suspect, storage cannot be reached, or the configured append count is exhausted. Read operations may remain available after capacity exhaustion.
- Monitor free disk **bytes**, disk errors, process RSS, memory/CPU, 5xx count, 429 count at ingress, and 507 capacity failures.
- Set alerts well before `AUDIT_MAX_EVENTS` is reached; the counter is not a disk byte quota.
- Capacity exhaustion requires a deliberate verified archive and new database deployment. Never modify or silently delete existing audit rows.
- Store externally trusted checkpoints on a **separate** host/retention domain with write restrictions; otherwise they do not defend against privileged rewriting.

## Backups and recovery

Do not manually copy a live SQLite file in WAL mode. Use the bundled online backup tool:

```bash
npm run checkpoint -- --db ./data/audit.sqlite --out ./backups/weekly.checkpoint.json
npm run backup -- --db ./data/audit.sqlite --out ./backups/audit-backup.sqlite
npm run verify -- --db ./backups/audit-backup.sqlite --checkpoint ./backups/weekly.checkpoint.json
npm run e2e:disk
```

A checkpoint is an unsigned statement. Do not treat one stored next to the database as trusted against the same administrator. Keep a previously verified checkpoint in independently secured storage. To restore: **stop the API**; preserve the suspect database for forensic review; verify the backup against a separately trusted checkpoint; place it at the configured DB path with appropriate ownership; restart; verify `/health/ready`, a legitimate READ request and the chain; rotate compromised credentials. The `e2e:disk` test runs a temporary full backup/restore drill without modifying user data.

## Secret rotation

Store credentials in a secret manager or root-readable environment configuration, not in Git or container images. If a key leaks, deny the compromised client's network access immediately, issue new independent keys and restart the service. **There is no seamless overlap/online key rotation** in this small implementation; coordinate writer downtime. Recheck checkpoint and access logs after suspected compromise. Do not print keys in monitoring.

## Limits of assurance

No penetration test, actual disk-full injection, real TLS ingress exercise, live GitHub Actions execution, host crash-consistency test, HA/distributed load test, or legal WORM compliance audit has been performed in the present environment. Docker CI instructions exist and will verify a real image after first GitHub push, but cannot be called successful before that run finishes.

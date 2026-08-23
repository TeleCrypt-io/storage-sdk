#!/usr/bin/env python3
"""Patches a `mas-cli config generate` output in place for the throwaway
dev/test stack: points it at the throwaway Postgres + Synapse containers,
sets its same-origin public_base/issuer, and relaxes the dynamic client
registration policy to allow http/localhost redirect URIs (this is a
disposable dev instance we own, never production).

Usage: patch_mas_config.py <config.yaml> <shared_secret>
"""
import re
import sys

path, secret = sys.argv[1], sys.argv[2]

with open(path) as f:
    content = f.read()

# database: point at the throwaway postgres container.
content = content.replace(
    "uri: postgresql://",
    "uri: postgresql://mas:mas@throwaway-mas-db:5432/mas",
)

# matrix: server_name must match Synapse's SYNAPSE_SERVER_NAME (up.sh uses
# "localhost"); secret must match Synapse's matrix_authentication_service.secret;
# endpoint is the container-to-container address (internal network).
content = re.sub(r"^  homeserver: .*$", "  homeserver: localhost", content, flags=re.M)
content = re.sub(r"^  secret: .*$", f'  secret: "{secret}"', content, flags=re.M)
content = re.sub(
    r"^  endpoint: http://localhost:8008/$",
    "  endpoint: http://throwaway-synapse:8008/",
    content,
    flags=re.M,
)

# http: public_base/issuer match the single homeserver origin. Caddy exposes
# this MAS root under /auth and strips that prefix before forwarding.
content = re.sub(r"^  public_base: .*$", "  public_base: http://localhost:8008/auth/", content, flags=re.M)
content = re.sub(r"^  issuer: .*$", "  issuer: http://localhost:8008/auth/", content, flags=re.M)

# database: the default max_connections: 10 was observed to be too tight
# under the full functional suite's concurrency (8 vitest files in parallel,
# each registering/logging in several users) — saw one transient 500 from
# MAS under that load in testing. Bump it generously; this is a disposable
# dev/test Postgres, not a tuned production pool.
content = re.sub(r"^  max_connections: .*$", "  max_connections: 50", content, flags=re.M)

# policy: we own this dev MAS, so dynamic client registration may accept
# http/localhost redirect URIs and mismatched hosts freely — never do this on
# a production MAS.
#
# rate_limiting: functional tests issue many authentication requests from one
# local IP. Relax the development MAS rate limits only for this disposable
# workload; production retains its own policy.
content += """
account:
  password_registration_enabled: true
  registration_token_required: false
  password_registration_email_required: false
policy:
  data:
    client_registration:
      allow_host_mismatch: true
      allow_insecure_uris: true
rate_limiting:
  login:
    per_ip:
      burst: 100000
      per_second: 1000
    per_account:
      burst: 100000
      per_second: 1000
  registration:
    burst: 100000
    per_second: 1000
"""

with open(path, "w") as f:
    f.write(content)

print(f"patched {path}")

#!/usr/bin/env python3
"""Generate InternalStatsAPI tokens locally, optionally register via gen_secret endpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
import urllib.error
import urllib.request


def parse_scopes(raw: str) -> list[str]:
    values = [item.strip() for item in raw.split(",") if item.strip()]
    if not values:
        return ["report:write", "stats:read"]
    return values


def make_token() -> str:
    return f"istat_{secrets.token_hex(32)}"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def register_token(
    endpoint: str,
    gen_secret: str,
    name: str,
    token_hash: str,
    scopes: list[str],
    description: str | None,
    expires_at: str | None,
    created_by: str | None,
) -> dict:
    payload: dict[str, object] = {
        "name": name,
        "tokenHash": token_hash,
        "scopes": scopes,
    }
    if description:
        payload["description"] = description
    if expires_at:
        payload["expiresAt"] = expires_at
    if created_by:
        payload["createdBy"] = created_by

    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-internal-stats-gen-secret": gen_secret,
        },
    )

    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read().decode("utf-8")
        if not raw:
            return {"ok": True}
        return json.loads(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate InternalStatsAPI token")
    parser.add_argument("--name", required=True, help="Human-readable token name")
    parser.add_argument(
        "--scopes",
        default="report:write,stats:read",
        help="Comma-separated scopes (default: report:write,stats:read)",
    )
    parser.add_argument("--description", default="", help="Optional token description")
    parser.add_argument("--expires-at", default="", help="Optional ISO datetime expiry")
    parser.add_argument("--created-by", default="python-script", help="Optional creator label")
    parser.add_argument(
        "--register-url",
        default="",
        help="Optional full URL to /v1/internal-stats/auth/tokens/register",
    )
    parser.add_argument(
        "--gen-secret",
        default="",
        help="INTERNAL_STATS_GEN_SECRET value (required when --register-url is used)",
    )

    args = parser.parse_args()

    scopes = parse_scopes(args.scopes)
    token = make_token()
    token_hash = hash_token(token)

    print("token:", token)
    print("token_hash:", token_hash)
    print("scopes:", ", ".join(scopes))

    if not args.register_url:
        print("\nNot registered. Use --register-url + --gen-secret to insert automatically.")
        return 0

    if not args.gen_secret:
        print("error: --gen-secret is required when --register-url is provided", file=sys.stderr)
        return 2

    try:
        result = register_token(
            endpoint=args.register_url,
            gen_secret=args.gen_secret,
            name=args.name,
            token_hash=token_hash,
            scopes=scopes,
            description=args.description or None,
            expires_at=args.expires_at or None,
            created_by=args.created_by or None,
        )
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"register failed: HTTP {error.code}: {body}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"register failed: {error}", file=sys.stderr)
        return 1

    print("\nRegistered via endpoint:")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

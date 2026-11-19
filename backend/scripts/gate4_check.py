"""Gate 4 — live warm-cache security check.
Usage:  python scripts/gate4_check.py <LOGIN_CODE>
Get LOGIN_CODE by sending /login to your Telegram bot (it replies with an 8-digit code).
Backend must be running on 127.0.0.1:8000.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
API = BASE + "/api"


def _req(method, url, body=None, token=None, headers=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/gate4_check.py <LOGIN_CODE from bot /login>")
        sys.exit(2)
    code = sys.argv[1].strip().upper()

    # 1) Exchange the login code for an access token (the real web login route).
    status, raw = _req("POST", API + "/auth/verify-code", {"code": code})
    if status != 200:
        print(f"[FAIL] verify-code returned {status}: {raw[:200]!r}")
        print("       Send /login to the bot again and use the fresh code.")
        sys.exit(1)
    token = json.loads(raw)["access_token"]
    print("[ok] login code exchanged for access token")

    # 2) Pick a real file from the library.
    status, raw = _req("GET", API + "/files?per_page=1", token=token)
    files = json.loads(raw).get("files", []) if status == 200 else []
    if not files:
        print(f"[FAIL] could not list files ({status}). Forward a video to the bot first.")
        sys.exit(1)
    file_id = files[0]["id"]
    print(f"[ok] using file id {file_id} ({files[0].get('file_name')})")

    # 3) Start a playback session -> signed stream URL.
    status, raw = _req(
        "POST", API + "/playback/start",
        {"file_id": file_id, "device_id": "gate4-test-device-001", "device_label": "gate4"},
        token=token,
    )
    if status != 200:
        print(f"[FAIL] playback/start returned {status}: {raw[:200]!r}")
        sys.exit(1)
    full = BASE + json.loads(raw)["stream_url"]   # stream_url already includes /api
    print("[ok] got signed stream URL")

    # 4) Authorized range request (primes the cache) -> expect 206.
    status, _ = _req("GET", full, headers={"Range": "bytes=0-1023"})
    if status not in (200, 206):
        print(f"[FAIL] authorized stream returned {status}, expected 206")
        sys.exit(1)
    print(f"[ok] authorized range request -> {status}")

    # 5) THE SECURITY CHECK: same range, NO token -> must be 401.
    status, _ = _req("GET", f"{API}/stream/{file_id}", headers={"Range": "bytes=0-1023"})
    if status == 401:
        print("[PASS] unauthenticated warm-cache request -> 401 (no bytes leaked)")
        print("\nGATE 4 PASSED ✅")
    else:
        print(f"[FAIL] unauthenticated request returned {status}, EXPECTED 401 — BUG STILL PRESENT")
        sys.exit(1)


if __name__ == "__main__":
    main()
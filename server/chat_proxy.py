#!/usr/bin/env python3
"""chat_proxy.py — single-origin static server + secure chat proxy.

STANDARD LIBRARY ONLY (org policy forbids third-party packages). Uses
http.server, urllib, json, threading, etc. — no pip installs required.

What it does
------------
1. Serves the static site from the `web/` directory (one level up from this
   file) exactly like `python -m http.server`, so the page and the chat API
   share one origin (no CORS headaches).
2. Handles `POST /api/chat`: takes a user question, prepends a tightly scoped
   system prompt, forwards it to an OpenAI-compatible chat-completions endpoint
   using the API key held ONLY in this process's environment, and returns the
   model's reply as JSON. The key is never sent to the browser.

Run it
------
    python server/chat_proxy.py
    # then open http://localhost:8000/

The API key is read from the environment, e.g. (bash):
    export OPENAI_API_KEY=sk-...
    python server/chat_proxy.py

If no key is set, /api/chat returns a graceful 503 (the site still works,
chat just reports "offline") — the server never crashes.

Environment variables
----------------------
    OPENAI_API_KEY   (required for chat) the secret key; never exposed client-side
    OPENAI_MODEL     model id            (default "gpt-4o-mini")
    OPENAI_BASE      API base URL        (default "https://api.openai.com/v1")
    PORT             port to listen on   (default 8000)

Swapping providers (e.g. Anthropic): the request/response shape here follows
the OpenAI "chat/completions" convention. Because the base URL, model, and key
are all env-driven, you can point OPENAI_BASE at any OpenAI-compatible gateway
without code changes. For a native Anthropic swap, only `call_llm()` and the
two small request/response builders need adjusting — everything else (routing,
rate limiting, static serving) is provider-agnostic.
"""

import json
import os
import sys
import time
import threading
import urllib.request
import urllib.error
from collections import defaultdict, deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------- #
#  Load a .env file (stdlib only — no python-dotenv dependency).
#  Looks in the current dir and the project root; does NOT override variables
#  already present in the real environment.
# --------------------------------------------------------------------------- #
def _load_dotenv():
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(os.getcwd(), ".env"),
        os.path.join(here, "..", ".env"),         # web/.env
        os.path.join(here, "..", "..", ".env"),   # repo root .env
    ]
    seen = set()
    for path in candidates:
        path = os.path.abspath(path)
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for raw in fh:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    if line.lower().startswith("export "):
                        line = line[7:]
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:   # real env wins
                        os.environ[key] = val
        except OSError:
            pass


_load_dotenv()

# --------------------------------------------------------------------------- #
#  Configuration (from environment)
# --------------------------------------------------------------------------- #
PORT = int(os.environ.get("PORT", "8000"))
API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()
API_BASE = os.environ.get("OPENAI_BASE", "https://api.openai.com/v1").strip().rstrip("/")

# Directory to serve static files from = the `web/` dir (parent of this file).
WEB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# --------------------------------------------------------------------------- #
#  Rate-limit constants  (all in-memory; tune here)
# --------------------------------------------------------------------------- #
# Per-client-IP limits: a token-bucket-style sliding window.
PER_IP_PER_MINUTE = 5        # max requests per IP in any rolling 60 s window
PER_IP_PER_DAY = 40          # max requests per IP per rolling 24 h window
# Global backstop across ALL clients, so one busy day can't drain the key.
GLOBAL_PER_DAY = 300         # max requests total per rolling 24 h window
# Input guard: reject obviously oversized prompts before we spend a token.
MAX_MESSAGE_CHARS = 1500     # longest accepted user message
MAX_HISTORY_TURNS = 6        # cap how much prior history we forward (cost guard)

# Outbound request timeout to the LLM API (seconds).
LLM_TIMEOUT = 30
# Cap on tokens the model may generate per reply (cost guard).
MAX_TOKENS = 400

# Time windows in seconds (named for clarity).
MINUTE = 60
DAY = 24 * 60 * 60

# --------------------------------------------------------------------------- #
#  System prompt — scopes the assistant to this story only.
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = (
    "You are a knowledgeable, friendly tutor embedded in an interactive story "
    "called \"Complex Frequency.\" Your job is to help the reader genuinely "
    "understand the ideas AND how they connect to real electrical engineering and "
    "power systems. Answer questions about: the Frenet frame (tangent T, normal N, "
    "binormal B, curvature kappa, torsion tau); radial frequency rho = v'/v (rate "
    "of change of magnitude); azimuthal frequency omega = |v x v'|/v^2 (the "
    "conventional frequency, rotation in a plane); torsional frequency xi = v*tau "
    "(twisting out of plane); complex frequency eta = rho + j*omega; the "
    "decomposition v' = rho*v + omega x v; and how all of this relates to real "
    "power-system behaviour (RoCoF, balanced vs unbalanced operation, transients, "
    "faults, phasors, the Park/Clarke transforms, signal analytic-signal theory). "
    "Treat questions about the underlying physics and power systems as ON-TOPIC and "
    "answer them helpfully — connect back to the story's geometry when it aids "
    "intuition.\n\n"
    "Key facts you can rely on (Milano's framework):\n"
    "- The voltage vector's tip traces a curve; v is the tangent to the flux curve "
    "(v = -phi'). rho, omega, xi are rotation/stretch rates of the Frenet frame.\n"
    "- Balanced three-phase operation (even many transients) is a PLANAR curve in "
    "(va,vb,vc) space, so torsion tau = 0 and xi = 0. The twist appears only when "
    "the trajectory leaves its plane, i.e. under unbalance and/or fast transients "
    "(when phase magnitudes/angles accelerate differently: V_i'' != 0 or "
    "theta_i'' != 0). Example: a fault on the New England 39-bus system makes the "
    "voltage trajectory change plane, producing a torsional RoCoF component the "
    "conventional scalar definition misses.\n"
    "- In a plane (xi = 0) the geometry collapses to a single complex number "
    "eta = rho + j*omega -- this IS the complex frequency, the planar special case. "
    "rho is the real part (grow/decay), omega the imaginary part (rotation).\n"
    "- The conventional 'frequency = d(theta)/dt' is the special case with constant "
    "magnitude (rho = 0); complex frequency generalizes it.\n\n"
    "Style: concise and intuitive (a few sentences), plain language first, a little "
    "math when it helps, honest about nuance. The chat is PLAIN TEXT (no math "
    "rendering): write symbols as Unicode (rho/ρ, omega/ω, xi/ξ, ×, ·) and NEVER "
    "use LaTeX, backslash commands, or \\( \\) / $...$ delimiters. If you are "
    "unsure, say so rather than inventing specifics. Only decline requests that are "
    "clearly unrelated to this subject (e.g. coding help, personal advice, current "
    "events) -- do so in one short sentence and point back to the topic."
)

# --------------------------------------------------------------------------- #
#  In-memory rate limiter (thread-safe).
# --------------------------------------------------------------------------- #
class RateLimiter:
    """Tracks request timestamps per IP and globally using rolling windows.

    We keep a deque of recent request times for each IP (and one global deque).
    On each check we drop timestamps older than the relevant window, then count
    what's left. This is simple, exact, and needs no background cleanup beyond
    trimming on access.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._per_ip = defaultdict(deque)   # ip -> deque[timestamp]
        self._global = deque()              # deque[timestamp]

    @staticmethod
    def _trim(dq, now, window):
        """Drop timestamps older than `window` seconds from the left."""
        cutoff = now - window
        while dq and dq[0] < cutoff:
            dq.popleft()

    def check_and_record(self, ip):
        """Return (allowed: bool, retry_after_seconds: int).

        If allowed, the request is recorded. If not, retry_after is a hint for
        how many seconds until the user could try again (best-effort).
        """
        now = time.time()
        with self._lock:
            ip_dq = self._per_ip[ip]
            # Trim all windows we care about (use the largest = day for ip_dq).
            self._trim(ip_dq, now, DAY)
            self._trim(self._global, now, DAY)

            # Count requests in the last minute / day for this IP.
            minute_count = sum(1 for t in ip_dq if t >= now - MINUTE)
            day_count = len(ip_dq)            # already trimmed to the day window
            global_count = len(self._global)  # trimmed to the day window

            # Per-IP minute limit.
            if minute_count >= PER_IP_PER_MINUTE:
                oldest_in_minute = min(t for t in ip_dq if t >= now - MINUTE)
                retry = int(oldest_in_minute + MINUTE - now) + 1
                return False, max(retry, 1)

            # Per-IP daily limit.
            if day_count >= PER_IP_PER_DAY:
                retry = int(ip_dq[0] + DAY - now) + 1
                return False, max(retry, 1)

            # Global daily backstop.
            if global_count >= GLOBAL_PER_DAY:
                retry = int(self._global[0] + DAY - now) + 1
                return False, max(retry, 1)

            # Allowed — record the request in both ledgers.
            ip_dq.append(now)
            self._global.append(now)
            return True, 0


LIMITER = RateLimiter()


# --------------------------------------------------------------------------- #
#  LLM call (OpenAI-compatible chat/completions).
# --------------------------------------------------------------------------- #
def build_messages(user_message, history):
    """Assemble the messages array: system prompt + clipped history + new msg."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    # history is an optional list of {role, content}; forward only the tail and
    # only roles we expect, so a malicious client can't smuggle a new system msg.
    if isinstance(history, list):
        clean = [
            {"role": h.get("role"), "content": str(h.get("content", ""))[:MAX_MESSAGE_CHARS]}
            for h in history
            if isinstance(h, dict) and h.get("role") in ("user", "assistant")
        ]
        messages.extend(clean[-MAX_HISTORY_TURNS:])
    messages.append({"role": "user", "content": user_message})
    return messages


def call_llm(user_message, history):
    """Call the chat-completions endpoint. Returns reply text.

    Raises RuntimeError with a user-safe message on failure.
    """
    url = API_BASE + "/chat/completions"
    payload = {
        "model": MODEL,
        "messages": build_messages(user_message, history),
        "max_tokens": MAX_TOKENS,
        "temperature": 0.4,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + API_KEY)

    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Don't leak provider error bodies/keys; log status only.
        print("[chat] upstream HTTP error: %s" % e.code, file=sys.stderr)
        raise RuntimeError("the assistant is unavailable right now")
    except urllib.error.URLError as e:
        print("[chat] upstream connection error", file=sys.stderr)
        raise RuntimeError("could not reach the assistant")
    except Exception:  # noqa: BLE001 - never crash the server on a bad reply
        print("[chat] unexpected upstream error", file=sys.stderr)
        raise RuntimeError("the assistant returned an unexpected response")

    # Pull the assistant text out of the OpenAI-style response shape.
    try:
        reply = body["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, AttributeError, TypeError):
        raise RuntimeError("the assistant returned an empty response")
    if not reply:
        raise RuntimeError("the assistant returned an empty response")
    return reply


# --------------------------------------------------------------------------- #
#  HTTP handler: static files + /api/chat
# --------------------------------------------------------------------------- #
class ChatHandler(SimpleHTTPRequestHandler):
    # Serve static files from WEB_ROOT regardless of the process CWD.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    # --- minimal logging: method + path + status only; no bodies, no key. ---
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.client_address[0], fmt % args))

    def _send_json(self, status, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _client_ip(self):
        # Single-origin local server: the socket peer is the client.
        return self.client_address[0]

    def do_POST(self):
        if self.path.split("?")[0] != "/api/chat":
            self._send_json(404, {"error": "not found"})
            return
        self._handle_chat()

    def _handle_chat(self):
        # 1) If there's no key, chat is offline — graceful 503, never a crash.
        if not API_KEY:
            self._send_json(503, {"error": "chat offline: set OPENAI_API_KEY"})
            return

        # 2) Rate limiting (before reading/forwarding anything expensive).
        allowed, retry = LIMITER.check_and_record(self._client_ip())
        if not allowed:
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", str(retry))
            self.send_header("Cache-Control", "no-store")
            payload = json.dumps(
                {"error": "rate limit: try again in %d s" % retry}
            ).encode("utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # 3) Read and parse the JSON body.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        # Hard cap the raw body too, so a huge payload can't exhaust memory.
        if length <= 0 or length > 64 * 1024:
            self._send_json(400, {"error": "invalid request body"})
            return
        try:
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid JSON"})
            return

        message = data.get("message") if isinstance(data, dict) else None
        history = data.get("history") if isinstance(data, dict) else None

        # 4) Validate the message.
        if not isinstance(message, str) or not message.strip():
            self._send_json(400, {"error": "message is required"})
            return
        message = message.strip()
        if len(message) > MAX_MESSAGE_CHARS:
            self._send_json(
                413,
                {"error": "message too long (max %d chars)" % MAX_MESSAGE_CHARS},
            )
            return

        # 5) Call the model and return its reply (or a friendly error).
        try:
            reply = call_llm(message, history)
        except RuntimeError as e:
            self._send_json(502, {"error": str(e)})
            return
        self._send_json(200, {"reply": reply})


# --------------------------------------------------------------------------- #
#  Entrypoint
# --------------------------------------------------------------------------- #
def main():
    server = ThreadingHTTPServer(("", PORT), ChatHandler)
    key_state = "configured" if API_KEY else "NOT set (chat offline)"
    print("complex-frequency chat proxy")
    print("  serving %s" % WEB_ROOT)
    print("  http://localhost:%d/" % PORT)
    print("  model: %s   base: %s" % (MODEL, API_BASE))
    print("  OPENAI_API_KEY: %s" % key_state)
    print("  limits: %d/min, %d/day per IP; %d/day global; max %d chars" % (
        PER_IP_PER_MINUTE, PER_IP_PER_DAY, GLOBAL_PER_DAY, MAX_MESSAGE_CHARS))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()

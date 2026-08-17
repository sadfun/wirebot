#!/usr/bin/env python3
"""Small semantic CDP client for Wirebot's agent-owned Chromium."""

import argparse
import asyncio
import base64
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = int(os.environ.get("WIREBOT_CHROMIUM_PORT", "9222"))
PROFILE = Path(os.environ.get("WIREBOT_CHROMIUM_PROFILE", "/data/chromium"))
STATE_PATH = Path(os.environ.get("WIREBOT_CHROMIUM_STATE", "/tmp/wirebot-chromium-sessions.json"))
LOCK_PATH = Path(f"{STATE_PATH}.lock")
LOG_PATH = Path(os.environ.get("WIREBOT_CHROMIUM_LOG", "/tmp/wirebot-chromium.log"))
BINARY = os.environ.get("WIREBOT_CHROMIUM_BINARY", "chromium")
MAX_MESSAGE = 8 * 1024 * 1024


def http_json(path, method="GET"):
    request = Request(f"http://{HOST}:{PORT}{path}", method=method)
    with urlopen(request, timeout=2) as response:
        return json.load(response)


def browser_info():
    try:
        return http_json("/json/version")
    except OSError:
        return None


def ensure_browser():
    info = browser_info()
    if info is not None:
        return info
    PROFILE.mkdir(parents=True, exist_ok=True)
    command = [
        BINARY,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        f"--remote-debugging-address={HOST}",
        f"--remote-debugging-port={PORT}",
        f"--user-data-dir={PROFILE}",
        "about:blank",
    ]
    with LOG_PATH.open("a") as log:
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    for _ in range(100):
        info = browser_info()
        if info is not None:
            return info
        time.sleep(0.1)
    raise RuntimeError(f"Chromium did not start; inspect {LOG_PATH}")


def targets():
    ensure_browser()
    return [target for target in http_json("/json/list") if target.get("type") == "page"]


def target(target_id):
    found = next((item for item in targets() if item.get("id") == target_id), None)
    if found is None:
        raise RuntimeError(f"tab is unavailable: {target_id}")
    return found


def supported_url(url):
    if not (url.startswith("http://") or url.startswith("https://") or url == "about:blank"):
        raise ValueError("only http(s) URLs and about:blank are supported")


def new_target(url):
    supported_url(url)
    ensure_browser()
    return http_json(f"/json/new?{quote(url, safe='')}", method="PUT")


def close_target(target_id):
    try:
        with urlopen(
            f"http://{HOST}:{PORT}/json/close/{quote(target_id, safe='')}", timeout=2
        ) as response:
            return response.status == 200
    except OSError:
        return False


@contextmanager
def locked_state():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.touch(mode=0o600, exist_ok=True)
    with LOCK_PATH.open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {"sessions": {}}
        except (OSError, json.JSONDecodeError):
            state = {"sessions": {}}
        yield state
        temporary = Path(f"{STATE_PATH}.tmp")
        temporary.write_text(json.dumps(state, separators=(",", ":")))
        temporary.replace(STATE_PATH)


class CDP:
    def __init__(self, websocket_url):
        self.websocket_url = websocket_url
        self.websocket = None
        self.next_id = 1

    async def __aenter__(self):
        import websockets

        self.websocket = await websockets.connect(self.websocket_url, max_size=MAX_MESSAGE)
        return self

    async def __aexit__(self, *_):
        await self.websocket.close()

    async def call(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        await self.websocket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            response = json.loads(await self.websocket.recv())
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise RuntimeError(response["error"].get("message", str(response["error"])))
            return response.get("result", {})

    async def evaluate(self, expression):
        response = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True, "userGesture": True},
        )
        if response.get("exceptionDetails"):
            details = response["exceptionDetails"]
            raise RuntimeError(details.get("exception", {}).get("description", "page evaluation failed"))
        return response.get("result", {}).get("value")

    async def wait_ready(self, timeout=20, ignore_url=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = await self.evaluate(
                "({ready: document.readyState, title: document.title, url: location.href})"
            )
            if value["ready"] in ("interactive", "complete") and value["url"] != ignore_url:
                return value
            await asyncio.sleep(0.1)
        raise RuntimeError("page load timed out")


SNAPSHOT_EXPRESSION = r"""(() => {
  const visible = (element) => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const role = (element) => element.getAttribute("role") || ({
    A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox"
  }[element.tagName]) || (element.tagName === "INPUT"
    ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button" }[element.type] || "textbox")
    : "control");
  const name = (element) => element.getAttribute("aria-label") || element.labels?.[0]?.innerText ||
    element.alt || element.placeholder || element.innerText || element.value || element.title || "";
  const elements = [...document.querySelectorAll(
    "a[href],button,input,textarea,select,[role],[contenteditable=true],[tabindex]"
  )].filter(visible).slice(0, 250).map((element) => {
    window.__wirebotRef = (window.__wirebotRef || 0) + 1;
    element.dataset.wirebotRef ||= "wb-" + window.__wirebotRef;
    return { ref: element.dataset.wirebotRef, role: role(element), name: name(element).trim().slice(0, 180) };
  });
  return { title: document.title, url: location.href,
    text: (document.body?.innerText || "").trim().slice(0, 16000), elements };
})()"""


def session(state, name):
    return state["sessions"].setdefault(name, {"tabs": {}, "last": None})


def resolve_tab(state, args):
    selected = args.tab or session(state, args.session).get("last")
    if not selected:
        raise RuntimeError("session has no selected tab")
    return selected


async def on_page(target_id, operation):
    item = target(target_id)
    async with CDP(item["webSocketDebuggerUrl"]) as cdp:
        await cdp.call("Page.enable")
        await cdp.call("Runtime.enable")
        return await operation(cdp)


async def execute(args, state):
    current = session(state, args.session)
    if args.command == "status":
        info = ensure_browser()
        return {"browser": info.get("Browser"), "profile": str(PROFILE), "managedTabs": list(current["tabs"])}
    if args.command == "tabs":
        return [
            {
                "id": item["id"], "title": item.get("title"), "url": item.get("url"),
                "managed": item["id"] in current["tabs"],
                "created": current["tabs"].get(item["id"], {}).get("created", False),
            }
            for item in targets()
        ]
    if args.command == "open":
        item = new_target("about:blank")
        current["tabs"][item["id"]] = {"created": True, "keep": False}
        current["last"] = item["id"]

        async def navigate(cdp):
            await cdp.call("Page.navigate", {"url": args.url})
            return await cdp.wait_ready(ignore_url="about:blank" if args.url != "about:blank" else None)

        supported_url(args.url)
        details = await on_page(item["id"], navigate)
        return {"tab": item["id"], **details}
    if args.command == "claim":
        item = target(args.tab)
        current["tabs"][item["id"]] = {"created": False, "keep": True}
        current["last"] = item["id"]
        return {"tab": item["id"], "title": item.get("title"), "url": item.get("url"), "created": False}
    if args.command == "finish":
        closed, released = [], []
        for tab_id, metadata in list(current["tabs"].items()):
            if metadata["created"] and not metadata["keep"]:
                close_target(tab_id)
                closed.append(tab_id)
            else:
                released.append(tab_id)
        state["sessions"].pop(args.session, None)
        return {"closed": closed, "released": released}

    tab_id = resolve_tab(state, args)
    if args.command == "close":
        close_target(tab_id)
        current["tabs"].pop(tab_id, None)
        current["last"] = next(reversed(current["tabs"]), None)
        return {"tab": tab_id, "closed": True}
    if args.command == "mark":
        current["tabs"].setdefault(tab_id, {"created": False})["keep"] = True
        return {"tab": tab_id, "kept": True}

    async def action(cdp):
        if args.command == "goto":
            supported_url(args.url)
            await cdp.call("Page.navigate", {"url": args.url})
            return {"tab": tab_id, **(await cdp.wait_ready())}
        if args.command == "snapshot":
            return {"tab": tab_id, **(await cdp.evaluate(SNAPSHOT_EXPRESSION))}
        if args.command == "text":
            value = await cdp.evaluate(
                '({title: document.title, url: location.href, text: (document.body?.innerText || "").trim().slice(0, 30000)})'
            )
            return {"tab": tab_id, **value}
        if args.command == "click":
            ref = json.dumps(args.ref)
            await cdp.evaluate(
                f'''(() => {{ const element = document.querySelector('[data-wirebot-ref="' + CSS.escape({ref}) + '"]');
                if (!element) throw new Error("ref not found"); element.scrollIntoView({{block:"center"}});
                element.click(); return true; }})()'''
            )
            await asyncio.sleep(0.25)
            return {"tab": tab_id, "clicked": args.ref, **(await cdp.wait_ready())}
        if args.command == "fill":
            ref, text = json.dumps(args.ref), json.dumps(args.text)
            await cdp.evaluate(
                f'''(() => {{ const element = document.querySelector('[data-wirebot-ref="' + CSS.escape({ref}) + '"]');
                if (!element) throw new Error("ref not found"); element.focus();
                if (element.isContentEditable) element.textContent = {text}; else {{
                  const proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                  if (setter) setter.call(element, {text}); else element.value = {text}; }}
                element.dispatchEvent(new InputEvent("input", {{bubbles:true, data:{text}}}));
                element.dispatchEvent(new Event("change", {{bubbles:true}})); return true; }})()'''
            )
            return {"tab": tab_id, "filled": args.ref}
        if args.command == "press":
            key_codes = {"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8}
            params = {"key": args.key, "windowsVirtualKeyCode": key_codes.get(args.key, 0)}
            await cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", **params})
            await cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", **params})
            await asyncio.sleep(0.15)
            return {"tab": tab_id, "pressed": args.key}
        if args.command == "screenshot":
            response = await cdp.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
            path = Path(args.path).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(response["data"]))
            return {"tab": tab_id, "path": str(path)}
        raise RuntimeError(f"unknown command: {args.command}")

    return await on_page(tab_id, action)


def parser():
    result = argparse.ArgumentParser(description="Control Wirebot's local Chromium")
    result.add_argument("--session", default=os.environ.get("WIREBOT_BROWSER_SESSION", "default"))
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    commands.add_parser("tabs")
    opened = commands.add_parser("open")
    opened.add_argument("url")
    claimed = commands.add_parser("claim")
    claimed.add_argument("tab")
    goto = commands.add_parser("goto")
    goto.add_argument("url")
    goto.add_argument("--tab")
    for name in ("snapshot", "text", "mark", "close"):
        item = commands.add_parser(name)
        item.add_argument("--tab")
    clicked = commands.add_parser("click")
    clicked.add_argument("ref")
    clicked.add_argument("--tab")
    filled = commands.add_parser("fill")
    filled.add_argument("ref")
    filled.add_argument("text")
    filled.add_argument("--tab")
    pressed = commands.add_parser("press")
    pressed.add_argument("key")
    pressed.add_argument("--tab")
    screenshot = commands.add_parser("screenshot")
    screenshot.add_argument("path")
    screenshot.add_argument("--tab")
    commands.add_parser("finish")
    return result


def main():
    args = parser().parse_args()
    with locked_state() as state:
        output = asyncio.run(execute(args, state))
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error

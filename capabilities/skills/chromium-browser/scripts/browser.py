#!/usr/bin/env python3
"""Small, persistent Playwright browser service for Wirebot."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import socketserver
import subprocess
import sys
import time


PROFILE = Path(os.environ.get("WIREBOT_BROWSER_PROFILE", "/data/chromium"))
SOCKET_PATH = Path(os.environ.get("WIREBOT_BROWSER_SOCKET", "/tmp/wirebot-browser.sock"))
START_LOCK = Path(f"{SOCKET_PATH}.start.lock")
LOG_PATH = Path(os.environ.get("WIREBOT_BROWSER_LOG", "/tmp/wirebot-browser.log"))
ENGINE = os.environ.get("WIREBOT_BROWSER_ENGINE", "auto")
MAX_REQUEST = 1024 * 1024
SELECTOR = (
    "a[href],button,input,textarea,select,summary,[role],[contenteditable=true],"
    "[tabindex],[onclick],[draggable=true]"
)


def truthy(name, default=False):
    value = os.environ.get(name)
    return default if value is None else value.lower() in {"1", "true", "yes"}


def supported_url(url):
    if not (url.startswith("http://") or url.startswith("https://") or url == "about:blank"):
        raise ValueError("only http(s) URLs and about:blank are supported")


def stable_fingerprint():
    path = PROFILE / ".wirebot-fingerprint"
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_hex(16)
    path.write_text(value)
    path.chmod(0o600)
    return value


def start_virtual_display():
    if truthy("WIREBOT_BROWSER_HEADLESS") or os.environ.get("DISPLAY"):
        return
    display = os.environ.get("WIREBOT_BROWSER_DISPLAY", ":99")
    number = display.removeprefix(":").split(".", 1)[0]
    x_directory = Path("/tmp/.X11-unix")
    if not x_directory.exists():
        x_directory.mkdir(mode=0o1777)
        x_directory.chmod(0o1777)
    x_socket = x_directory / f"X{number}"
    if not x_socket.exists():
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as log:
            subprocess.Popen(
                ["Xvfb", display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-ac"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        for _ in range(100):
            if x_socket.exists():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError(f"Xvfb did not start; inspect {LOG_PATH}")
    os.environ["DISPLAY"] = display


class BrowserService:
    def __init__(self):
        PROFILE.mkdir(parents=True, exist_ok=True)
        start_virtual_display()
        self.playwright = None
        self.engine, self.context = self.launch()
        self.pages = {}
        self.page_ids = {}
        self.next_tab = 1
        self.sessions = {}
        self.refs = {}
        self.context.on("page", self.register_page)
        for page in self.context.pages:
            self.register_page(page)

    def launch(self):
        if ENGINE not in {"auto", "clearcote", "chromium"}:
            raise ValueError("WIREBOT_BROWSER_ENGINE must be auto, clearcote, or chromium")
        headless = truthy("WIREBOT_BROWSER_HEADLESS")
        args = [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        if ENGINE in {"auto", "clearcote"}:
            try:
                from clearcote import launch_persistent_context
            except ImportError:
                if ENGINE == "clearcote":
                    raise RuntimeError("Clearcote is not installed for this architecture")
            else:
                context = launch_persistent_context(
                    str(PROFILE),
                    headless=headless,
                    fingerprint=stable_fingerprint(),
                    platform="linux",
                    args=args,
                    quiet=True,
                )
                return "clearcote", context

        from playwright.sync_api import sync_playwright

        binary = os.environ.get("WIREBOT_CHROMIUM_BINARY", "chromium")
        executable = shutil.which(binary) if "/" not in binary else binary
        if not executable:
            raise RuntimeError(f"Chromium binary is unavailable: {binary}")
        self.playwright = sync_playwright().start()
        context = self.playwright.chromium.launch_persistent_context(
            str(PROFILE), executable_path=executable, headless=headless, args=args
        )
        return "chromium", context

    def close(self):
        self.context.close()
        if self.playwright:
            self.playwright.stop()

    def register_page(self, page):
        key = id(page)
        if key in self.page_ids:
            return self.page_ids[key]
        tab_id = f"tab-{self.next_tab}"
        self.next_tab += 1
        self.pages[tab_id] = page
        self.page_ids[key] = tab_id
        page.on("close", lambda _page=None: self.unregister_page(tab_id, key))
        return tab_id

    def unregister_page(self, tab_id, key=None):
        self.pages.pop(tab_id, None)
        if key is not None:
            self.page_ids.pop(key, None)
        for current in self.sessions.values():
            current["tabs"].pop(tab_id, None)
            if current.get("last") == tab_id:
                current["last"] = next(reversed(current["tabs"]), None)
        for ref_key in [item for item in self.refs if item[1] == tab_id]:
            self.refs.pop(ref_key, None)

    def current_session(self, name):
        return self.sessions.setdefault(name, {"tabs": {}, "last": None})

    def page(self, tab_id):
        page = self.pages.get(tab_id)
        if page is None or page.is_closed():
            raise RuntimeError(f"tab is unavailable: {tab_id}")
        return page

    def selected(self, request):
        current = self.current_session(request["session"])
        tab_id = request.get("tab") or current.get("last")
        if not tab_id:
            raise RuntimeError("session has no selected tab")
        return current, tab_id, self.page(tab_id)

    def details(self, tab_id, page):
        return {"tab": tab_id, "title": page.title(), "url": page.url}

    def locator(self, session_name, tab_id, ref):
        locator = self.refs.get((session_name, tab_id), {}).get(ref)
        if locator is None:
            raise RuntimeError(f"ref is unavailable: {ref}; run snapshot again")
        return locator

    def snapshot(self, session_name, tab_id, page):
        refs = {}
        elements = []
        text_parts = []
        remaining = 250
        expression = r"""(elements, limit) => elements.map((element, index) => {
          const style = getComputedStyle(element), box = element.getBoundingClientRect();
          const hiddenFile = element.tagName === "INPUT" && element.type === "file";
          if (!hiddenFile && (style.visibility === "hidden" || style.display === "none" ||
              box.width <= 0 || box.height <= 0)) return null;
          const inferred = {A:"link",BUTTON:"button",SELECT:"combobox",TEXTAREA:"textbox"};
          let role = element.getAttribute("role") || inferred[element.tagName] || "control";
          if (element.tagName === "INPUT") role = ({checkbox:"checkbox",radio:"radio",
            submit:"button",button:"button",file:"button"})[element.type] || "textbox";
          const name = element.getAttribute("aria-label") || element.labels?.[0]?.innerText ||
            element.alt || element.placeholder || element.innerText || element.value ||
            element.title || "";
          return {index, role, name:name.trim().slice(0,180)};
        }).filter(Boolean).slice(0, limit)"""
        for frame in page.frames:
            try:
                body = frame.locator("body")
                if body.count():
                    value = body.inner_text(timeout=2000).strip()
                    if value:
                        text_parts.append(value)
                matches = frame.locator(SELECTOR)
                items = matches.evaluate_all(expression, remaining)
            except Exception:
                continue
            for item in items:
                ref = f"wb-{len(elements) + 1}"
                refs[ref] = matches.nth(item.pop("index"))
                item = {"ref": ref, **item}
                if frame != page.main_frame:
                    item["frame"] = frame.url
                elements.append(item)
            remaining = 250 - len(elements)
            if not remaining:
                break
        self.refs[(session_name, tab_id)] = refs
        return {
            **self.details(tab_id, page),
            "text": "\n\n".join(text_parts)[:16000],
            "elements": elements,
        }

    def track_new_pages(self, before, current):
        opened = []
        for page in self.context.pages:
            if id(page) not in before:
                tab_id = self.register_page(page)
                current["tabs"][tab_id] = {"created": True, "keep": False}
                current["last"] = tab_id
                opened.append(tab_id)
        return opened

    def dispatch(self, request):
        command = request["command"]
        name = request["session"]
        current = self.current_session(name)
        if command == "status":
            browser = self.context.browser
            return {
                "engine": self.engine,
                "browser": browser.version if browser else "Chromium",
                "profile": str(PROFILE),
                "managedTabs": list(current["tabs"]),
            }
        if command == "tabs":
            return [
                {
                    **self.details(tab_id, page),
                    "managed": tab_id in current["tabs"],
                    "created": current["tabs"].get(tab_id, {}).get("created", False),
                }
                for tab_id, page in list(self.pages.items())
                if not page.is_closed()
            ]
        if command == "open":
            supported_url(request["url"])
            page = self.context.new_page()
            tab_id = self.register_page(page)
            current["tabs"][tab_id] = {"created": True, "keep": False}
            current["last"] = tab_id
            page.goto(request["url"], wait_until="domcontentloaded")
            return self.details(tab_id, page)
        if command == "claim":
            tab_id = request["tab"]
            page = self.page(tab_id)
            current["tabs"][tab_id] = {"created": False, "keep": True}
            current["last"] = tab_id
            return {**self.details(tab_id, page), "created": False}
        if command == "finish":
            closed, released = [], []
            for tab_id, metadata in list(current["tabs"].items()):
                if metadata["created"] and not metadata["keep"]:
                    page = self.pages.get(tab_id)
                    if page and not page.is_closed():
                        page.close()
                    closed.append(tab_id)
                else:
                    released.append(tab_id)
            self.sessions.pop(name, None)
            for key in [item for item in self.refs if item[0] == name]:
                self.refs.pop(key, None)
            return {"closed": closed, "released": released}

        current, tab_id, page = self.selected(request)
        if command == "close":
            page.close()
            return {"tab": tab_id, "closed": True}
        if command == "mark":
            current["tabs"].setdefault(tab_id, {"created": False})["keep"] = True
            return {"tab": tab_id, "kept": True}
        if command == "goto":
            supported_url(request["url"])
            page.goto(request["url"], wait_until="domcontentloaded")
            return self.details(tab_id, page)
        if command == "back":
            page.go_back(wait_until="domcontentloaded")
            return self.details(tab_id, page)
        if command == "forward":
            page.go_forward(wait_until="domcontentloaded")
            return self.details(tab_id, page)
        if command == "snapshot":
            return self.snapshot(name, tab_id, page)
        if command == "text":
            value = self.snapshot(name, tab_id, page)
            value.pop("elements")
            value["text"] = value["text"][:30000]
            return value
        if command == "screenshot":
            path = Path(request["path"]).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(path))
            return {"tab": tab_id, "path": str(path)}

        before = {id(item) for item in self.context.pages}
        if command in {"click", "fill", "type", "select", "check", "uncheck", "hover", "upload"}:
            target = self.locator(name, tab_id, request["ref"])
            if command == "click":
                target.click()
            elif command == "fill":
                target.fill(request["text"])
            elif command == "type":
                target.press_sequentially(request["text"], delay=20)
            elif command == "select":
                target.select_option(request["value"])
            elif command == "check":
                target.check()
            elif command == "uncheck":
                target.uncheck()
            elif command == "hover":
                target.hover()
            else:
                path = Path(request["path"]).expanduser().resolve()
                if not path.is_file():
                    raise ValueError(f"upload file is unavailable: {path}")
                target.set_input_files(str(path))
        elif command == "drag":
            source = self.locator(name, tab_id, request["ref"])
            target = self.locator(name, tab_id, request["target"])
            source.drag_to(target)
        elif command == "press":
            page.keyboard.press(request["key"])
        elif command == "click-at":
            page.mouse.click(request["x"], request["y"])
        elif command == "scroll":
            page.mouse.wheel(request["x"], request["y"])
        elif command == "wait":
            milliseconds = min(max(request["milliseconds"], 0), 30000)
            page.wait_for_timeout(milliseconds)
        else:
            raise RuntimeError(f"unknown command: {command}")
        opened = self.track_new_pages(before, current)
        return {"tab": tab_id, "action": command, "openedTabs": opened, "url": page.url}


class RequestHandler(socketserver.StreamRequestHandler):
    def handle(self):
        raw = self.rfile.readline(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            response = {"error": "request is too large"}
        else:
            try:
                request = json.loads(raw)
                response = {"result": self.server.browser.dispatch(request)}
            except Exception as error:
                response = {"error": f"{type(error).__name__}: {error}"}
        self.wfile.write(json.dumps(response, separators=(",", ":")).encode() + b"\n")


class BrowserServer(socketserver.UnixStreamServer):
    def __init__(self, address, handler, browser):
        self.browser = browser
        super().__init__(address, handler)


def serve():
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    if SOCKET_PATH.exists():
        if not SOCKET_PATH.is_socket():
            raise RuntimeError(f"refusing to replace non-socket path: {SOCKET_PATH}")
        SOCKET_PATH.unlink()
    browser = BrowserService()
    try:
        with BrowserServer(str(SOCKET_PATH), RequestHandler, browser) as server:
            SOCKET_PATH.chmod(0o600)
            server.serve_forever()
    finally:
        browser.close()
        SOCKET_PATH.unlink(missing_ok=True)


def send(payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(120)
        client.connect(str(SOCKET_PATH))
        client.sendall(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
    response = json.loads(b"".join(chunks))
    if "error" in response:
        raise RuntimeError(response["error"])
    return response["result"]


def ensure_service():
    START_LOCK.parent.mkdir(parents=True, exist_ok=True)
    START_LOCK.touch(mode=0o600, exist_ok=True)
    with START_LOCK.open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            send({"command": "status", "session": "__probe__"})
            return
        except (OSError, RuntimeError, json.JSONDecodeError):
            pass
        if SOCKET_PATH.exists():
            if not SOCKET_PATH.is_socket():
                raise RuntimeError(f"refusing to replace non-socket path: {SOCKET_PATH}")
            SOCKET_PATH.unlink()
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as log:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "_serve"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        for _ in range(200):
            if process.poll() is not None:
                raise RuntimeError(f"browser service exited; inspect {LOG_PATH}")
            try:
                send({"command": "status", "session": "__probe__"})
                return
            except (OSError, RuntimeError, json.JSONDecodeError):
                time.sleep(0.1)
        raise RuntimeError(f"browser service did not start; inspect {LOG_PATH}")


def parser():
    result = argparse.ArgumentParser(description="Control Wirebot's local Playwright browser")
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
    for name in ("snapshot", "text", "mark", "close", "back", "forward"):
        commands.add_parser(name)
    for name in ("click", "check", "uncheck", "hover"):
        item = commands.add_parser(name)
        item.add_argument("ref")
    for name in ("fill", "type"):
        item = commands.add_parser(name)
        item.add_argument("ref")
        item.add_argument("text")
    selected = commands.add_parser("select")
    selected.add_argument("ref")
    selected.add_argument("value")
    dragged = commands.add_parser("drag")
    dragged.add_argument("ref")
    dragged.add_argument("target")
    uploaded = commands.add_parser("upload")
    uploaded.add_argument("ref")
    uploaded.add_argument("path")
    pressed = commands.add_parser("press")
    pressed.add_argument("key")
    clicked_at = commands.add_parser("click-at")
    clicked_at.add_argument("x", type=float)
    clicked_at.add_argument("y", type=float)
    scrolled = commands.add_parser("scroll")
    scrolled.add_argument("x", type=float)
    scrolled.add_argument("y", type=float)
    waited = commands.add_parser("wait")
    waited.add_argument("milliseconds", type=int)
    screenshot = commands.add_parser("screenshot")
    screenshot.add_argument("path")
    commands.add_parser("finish")
    for name, command in commands.choices.items():
        if name not in {"status", "tabs", "open", "claim", "finish"}:
            command.add_argument("--tab")
    return result


def main():
    if sys.argv[1:] == ["_serve"]:
        serve()
        return
    args = vars(parser().parse_args())
    ensure_service()
    print(json.dumps(send(args), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error

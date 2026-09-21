import asyncio
import importlib.util
import inspect
import json
import os
import sys
import threading
import traceback

from playwright.async_api import async_playwright


def read_input() -> dict:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("runner input is missing")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise TypeError("runner input must be an object")
    return value


def load_script(path: str):
    spec = importlib.util.spec_from_file_location("aliasmode_user_script", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(path))
    spec.loader.exec_module(module)
    run = getattr(module, "run", None)
    if not inspect.iscoroutinefunction(run):
        raise TypeError("Python Playwright script must export async def run")
    return run


async def run_script(input_value: dict) -> None:
    browser = None
    playwright = None
    try:
        playwright = await async_playwright().start()
        if input_value.get("engine") == "firefox":
            browser = await playwright.firefox.connect(input_value["endpoint"], timeout=30_000)
        else:
            browser = await playwright.chromium.connect_over_cdp(input_value["endpoint"], timeout=30_000)
        context = browser.contexts[0] if browser.contexts else None
        if context is None:
            raise RuntimeError("AliasMode browser context is unavailable")
        page = context.pages[0] if context.pages else await context.new_page()
        run = load_script(sys.argv[1])
        await run(
            browser=browser,
            context=context,
            page=page,
            profile=input_value.get("profile"),
            inputs=input_value.get("inputs"),
            credentials=input_value.get("credentials"),
            log=lambda *values: print(*values, flush=True),
        )
    finally:
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:
                pass


def main() -> int:
    if len(sys.argv) != 2:
        raise RuntimeError("script path is missing")
    input_value = read_input()

    def watch_parent() -> None:
        sys.stdin.read()
        os._exit(1)

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        asyncio.run(run_script(input_value))
        return 0
    except BaseException:
        text = traceback.format_exc()
        if input_value.get("engine") == "firefox" and isinstance(input_value.get("endpoint"), str):
            text = text.replace(input_value["endpoint"], "private Firefox endpoint")
        sys.stderr.write(text)
        return 1


if __name__ == "__main__":
    sys.exit(main())

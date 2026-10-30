---
name: browserskill
description: Control the browser (Firefox and Chrome) from the command line via the browserskill CLI - open a page, read text, run JS, click, fill a form, take a screenshot, view the console and network requests, work with cookies. Use for ANY browser task - open, click, screenshot, e2e checks, page debugging. Triggers - browser, firefox, chrome, browserskill, open a page, screenshot, browser console, check in the browser, браузер, открой страницу, скриншот, консоль браузера, проверь в браузере.
---

# Browser via browserskill

This is the default tool for everything browser-related. There is no MCP server - the CLI talks
to the bridge inside the browser extension directly over a Unix socket.

```bash
BS="node __ROOT__/bin/browserskill.js"
export BROWSERSKILL_BROWSER=chrome      # or firefox; or the -b chrome flag on every command
```

## Check the connection first

```bash
$FF browsers      # who is connected to the bridge
$FF status        # browser version, number of tabs
$FF doctor        # manifests, native host, extension
```

If the browser is grayed out - **don't fix it silently**, tell the user:

- **Chrome** - the extension is unpacked and survives restarts. It is enough to launch Chrome,
  the socket comes up by itself in a few seconds. This is the default path.
- **Firefox** - the extension is installed as a *temporary add-on* and **dies on every Firefox restart**.
  Fixed only by hand: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" →
  `__ROOT__/extension/manifest.json`. If the user doesn't want that -
  switch to Chrome.

## Two forms of calling

There are 14 explicit subcommands, and 39+ bridge operations. Everything without a subcommand is available via
`browserskill call <op> '<json>'`. **Operation names are not described anywhere in `--help` - the reference below
is the source of truth.**

```bash
# a window of your own so as not to disturb the user (pinned automatically)
$FF new-window "https://example.com"
$FF call session.newWindow '{"url":"https://example.com","width":1280,"height":900,"bind":true}'
$FF use-window release

# tabs and navigation
$FF tabs
$FF tabs '{"active":true}'
$FF open "https://example.com"
$FF call tabs.navigate '{"url":"https://example.com/x","tabId":123,"waitLoad":true}'
$FF call tabs.close '{"tabId":123}'
$FF call tabs.reload '{"bypassCache":true}'
$FF call tabs.back '{}'

# reading the page
$FF read                                                    # all visible text of the active tab
$FF call page.text '{"selector":"main","maxChars":4000}'    # a piece + limit
$FF call page.html '{"selector":"#app","maxChars":8000}'
$FF snapshot                                                # interactive elements with uid

# JS
$FF eval "return document.title"
$FF eval "return document.title" 123
$FF call page.eval '{"expression":"return await (await fetch(\"/api\")).json()","allFrames":false}'

# interaction
$FF call page.click   '{"uid":"e1"}'
$FF call page.fill    '{"selector":"input[name=q]","value":"text","submit":true}'
$FF call page.press   '{"key":"Enter"}'
$FF call page.waitFor '{"selector":"#done","timeoutMs":15000}'
$FF call page.waitFor '{"expression":"document.readyState===\"complete\""}'

# console and network
$FF call logs.console '{"limit":50}'
$FF call logs.network '{"limit":50,"urlContains":"/api/"}'

# cookies
$FF call cookies.list   '{"url":"https://example.com/"}'
$FF call cookies.set    '{"url":"https://example.com/","name":"a","value":"1"}'
$FF call cookies.remove '{"url":"https://example.com/","name":"a"}'

# direct WebExtension API, if the bridge operations are not enough
$FF api tabs.query '[{"active":true}]'
$FF call browser.describe '{"path":"cookies"}'   # what is available at all
```

Also available via `call`: `tabs.get`, `tabs.activate`, `tabs.waitLoad`, `windows.list/open/close`,
`session.useWindow`, `session.target`, `page.find`, `page.injectConsoleCapture`, `storage.get`,
`history.search/delete`, `bookmarks.search/tree/create/remove`, `downloads.list/start`,
`containers.list`, `sessions.recent/restore`.

## Screenshot - always via a file

Through the CLI a screenshot arrives **not as an image but as JSON with base64**. Never print it to stdout -
that is a megabyte into the context. Always decode it into a file and read the file with the Read tool:

```bash
$FF call page.screenshot '{"format":"png"}' > /tmp/shot.json
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("/tmp/shot.json","utf8"));
         fs.writeFileSync("/tmp/shot.png",Buffer.from(j.dataUrl.split(",")[1],"base64"))'
# → then Read /tmp/shot.png
```

Full page: `{"fullPage":true}`. Lighter: `{"format":"jpeg","quality":70}`.

## Pitfalls

- **`read` without a limit pulls in the whole page.** By default use `call page.text` with `maxChars`.
- **`about:blank` and `chrome://*` are inaccessible to the extension** - "Cannot access contents of url". For checks
  you need a real page: local HTTP or `file://` (the latter requires "Allow access to file URLs"
  in the extension's card).
- Extra flags (`private`, window size, `cookieStoreId`, `allWindows`, `allFrames`) are not passed through
  in the short subcommands - only via `call`.
- Browser choice in the CLI is `BROWSERSKILL_BROWSER` / `-b`; there is no "pinned browser" state between calls.
  But **window** pinning (`session.useWindow`) lives in the extension and persists between calls.
- Work in your own window (`new-window`), not in the user's tabs.

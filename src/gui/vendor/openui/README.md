# Vendored OpenUI renderer

These files are the prebuilt browser bundle of [OpenUI](https://github.com/thesysdev/openui),
vendored so the GUI can render an OpenUI Lang dashboard **without any CDN** — which
matters on networks where jsDelivr/unpkg are filtered, and keeps the scanner usable
fully offline.

| File | Origin |
| --- | --- |
| `openui-bundle.min.js` | `@openuidev/browser-bundle@0.1.4` → `dist/openui-bundle.min.js` (~3.6 MB) |
| `openui-styles.css` | `@openuidev/browser-bundle@0.1.4` → `dist/openui-styles.css` (~317 KB) |
| `LICENSE` | OpenUI repository root (MIT) |

Both files are byte-identical copies; nothing in this directory is modified by hand.
`report.html` requests them as `…/openui-bundle.min.js?v=0.1.4`, which the local server
treats as a version pin and caches for a week (everything else is served `no-store`).
Bumping the version here means bumping that query string too.

## Public API used

The bundle attaches a single global (its documented, stable contract):

```js
window.__OpenUI = { React, createRoot, Renderer, openuiChatLibrary };
```

`src/gui/report.html` calls `createRoot(...).render(React.createElement(Renderer, { code, response, library, schema }))`.
The `code`/`response` pair is passed deliberately: the prop was renamed across bundle
versions, and unknown props are ignored.

## Updating

```bash
V=0.1.5   # any newer @openuidev/browser-bundle version
curl -fsSL -o src/gui/vendor/openui/openui-bundle.min.js  "https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@$V/dist/openui-bundle.min.js"
curl -fsSL -o src/gui/vendor/openui/openui-styles.css     "https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@$V/dist/openui-styles.css"
curl -fsSL -o src/gui/vendor/openui/LICENSE               "https://raw.githubusercontent.com/thesysdev/openui/main/LICENSE"
npm test    # test/server.test.ts and test/openui.test.ts cover this path
```

Then regenerate a scan report (`GET /api/report/openui`) and open `/report.html` to
confirm the components still resolve — component names, positional argument order and
the `openuiChatLibrary` export shape are the parts that can break between versions.

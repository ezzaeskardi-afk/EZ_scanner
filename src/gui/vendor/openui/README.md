# Vendored OpenUI renderer

These files are the prebuilt browser bundle of [OpenUI](https://github.com/thesysdev/openui),
vendored so the GUI can render an OpenUI Lang dashboard **without any CDN** — which
matters on networks where jsDelivr/unpkg are filtered, and keeps the scanner usable
fully offline.

| File | Origin |
| --- | --- |
| `openui-bundle.min.js` | `@openuidev/browser-bundle@0.1.4` → `dist/openui-bundle.min.js` (~3.6 MB), byte-identical copy |
| `openui-styles.css` | **generated** from `@openuidev/browser-bundle@0.1.4` → `dist/openui-styles.css` (~317 KB) by `scripts/prune-openui-css.ts` |
| `PRUNE-REPORT.md` | **generated** by the same script: before/after sizes and what was dropped |
| `LICENSE` | OpenUI repository root (MIT) |

The bundle is copied untouched. The stylesheet is **not**: it is pruned to the components
the scan report actually renders (see `PRUNE-REPORT.md`, 310.0 KB → 102.2 KB raw, 33.3 KB →
9.1 KB gzipped), because the upstream file also styles OpenUI's chat, agent pane, artifact
browser, model switcher, accordions and date pickers — none of which the report iframe can
render.

`report.html` requests the stylesheet as `…/openui-styles.css?v=0.1.4-p<hash>`, where the
hash is derived from the file's content. The local server treats any `?v=` URL as an
immutable week-long cache, so **the pin must move whenever the bytes do** — the script
rewrites it for you, and `test/openui-css.test.ts` fails if the two drift apart.

## Public API used

The bundle attaches a single global (its documented, stable contract):

```js
window.__OpenUI = { React, createRoot, Renderer, openuiChatLibrary };
```

`src/gui/report.html` calls `createRoot(...).render(React.createElement(Renderer, { code, response, library, schema }))`.
The `code`/`response` pair is passed deliberately: the prop was renamed across bundle
versions, and unknown props are ignored.

## Updating OpenUI

```bash
V=0.1.5   # any newer @openuidev/browser-bundle version
curl -fsSL -o src/gui/vendor/openui/openui-bundle.min.js  "https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@$V/dist/openui-bundle.min.js"
curl -fsSL -o src/gui/vendor/openui/LICENSE               "https://raw.githubusercontent.com/thesysdev/openui/main/LICENSE"
curl -fsSL -o .cache/openui-styles.full.css               "https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@$V/dist/openui-styles.css"

# bump the version/url/sha256 in scripts/prune-openui-css.ts, then:
node scripts/prune-openui-css.ts --check   # then fix whichever family the new sheet renamed
node scripts/prune-openui-css.ts           # rewrite openui-styles.css, PRUNE-REPORT.md and the ?v= pin
node scripts/prune-openui-css.ts --fetch   # alternative: download through the script itself
npm test
```

Then regenerate a scan report (`GET /api/report/openui`) and open `/report.html` to
confirm the components still resolve — component names, positional argument order and the
`openuiChatLibrary` export shape are the parts that can break between versions. If a new
version renames a class family, `node scripts/prune-openui-css.ts --capture` says which
captured class no longer has a family, and `test/openui-css.test.ts` fails until
`COMPONENT_STEMS` (in the script) is updated to match.

Re-capture the report DOM after a component change: open `/report.html` and run the snippet
in the header of `test/fixtures/openui-report-classes.txt`, then update that fixture.

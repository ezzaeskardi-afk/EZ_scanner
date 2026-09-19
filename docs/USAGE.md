# EZ Scanner — usage guide

A step-by-step walkthrough: from install to a clean config. The GUI is English-only
(the project has no other locale), so every label quoted below is what you will see
on screen.

---

## 0. Requirements

- **Node.js 22.18 or newer** (24 recommended). On Windows install the LTS build from
  [nodejs.org](https://nodejs.org).
- Check it: `node -v`
- No Go, no WebView2, no Python, no other tooling.

---

## 1. Start the GUI

```bash
git clone https://github.com/ezzaeskardi-afk/EZ_scanner.git
cd EZ_scanner
npm install
npm start
```

Your browser opens by itself. If it does not, open the URL printed in the terminal
(`http://127.0.0.1:8788/?token=…`).

> On Windows you can double-click `start-gui.cmd` instead.

---

## 2. The three-click path

1. In **Address source**, click the **Config** tab and paste your own config link
   (`vless://…` or `trojan://…`).
2. Click **Parse config**, then **Use its SNI/port** — the SNI, port and WS path are copied
   into the settings on the right.
3. Switch back to the **Cloudflare** tab (that is the clean-IP sweep: thousands of edges with
   your SNI) and click **Start scan**.

> The Config tab itself is a *source* like any other: with it selected, a scan resolves and
> probes only the address inside your link (1–2 addresses). That is what the
> **Scan the config domain** button does, and it answers "is my own server reachable?" — it
> is not how you find clean IPs.

When it finishes, the results table is populated. Read the *status* column:

- `✓` = clean and ready to use
- red text = why the row was rejected (for example `loss 67% > 50%`)

---

## 3. Settings that matter (and what not to switch on)

| Setting | Suggestion | Why |
|---|---|---|
| Mode | `tls` | `tcp` is faster but shallow; `http` is stricter but slower |
| Tries / min successes | `3` / `2` | On a bad line use `2` / `1` |
| Workers | `20`–`50` | Above 150 risks killing an Iranian line |
| **Validate WebSocket** | ❌ off | On a DPI'd line this turns everything red |
| **Idle hold** | `0` | The strictest gate; try it only after your first results |
| Validate HTTP response | ✅ on | Proves the path to the edge really works |
| Max connections/sec | `0` or `12` | Use 10–15 on MCI/Shatel |
| Auto-pause when the line dies | ✅ | Parks the scan and continues when the line returns |

The **Gentle (Iran-friendly)** preset sets all of that at once.

---

## 4. Reading the failures

Under the **Progress** panel you get the failure-reason chips (e.g. `timeout 462`), and in
the results table the *status* column writes the rejection reason in plain words; the
engine's raw string is the cell's tooltip.

```
Failure reasons   timeout 462   other 272   reset 30
```

| Dominant kind | What it means | What to do |
|---|---|---|
| `timeout` | The handshake never completes | `--mode tcp`, a different SNI, or fewer workers |
| `reset` | Something on the path is killing the connection | Gentle preset + a rate cap |
| `http` | TLS is fine but HTTP is not | Raise the timeout or use `mode=tls` |
| `ws` | Every WebSocket upgrade failed | Untick *Validate WebSocket* |
| `unstable` | The idle hold rejected everything | Set *Idle hold* to zero |

---

## 4.5. The OpenUI dashboard (visual report)

The **OpenUI dashboard** tab sits in the bottom dock. Instead of a bare table you get a
visual report: checked/clean counts, median and best latency, a latency histogram, the
cleanest addresses, the active gates and the most common failure reasons.

Notes:

- The report is generated as an **OpenUI Lang** document by the scanner itself and drawn by
  the official [OpenUI](https://github.com/thesysdev/openui) renderer. Every file is inside
  the app, so **no internet and no CDN are needed**.
- It refreshes automatically at the end of a scan, and manually via **Refresh report** (or
  the *Refresh* button inside the report).
- **Copy Lang code** / **Download Lang code** give you the raw document, which you can paste
  into the OpenUI Playground or any other OpenUI app.
- **New tab** opens the report full-page.
- The report follows the app theme (light/dark).

> The theme button in the header switches light/dark and remembers your choice.

---

## 5. Building a ready config (the important part)

1. In the **Export & config** tab (bottom dock), paste your own config link into the
   **Config link** field. It is only used as a template — your UUID and parameters are kept
   untouched.
2. Click **Build configs** → the links are built and copied to your clipboard:
   ```
   vless://uuid@104.19.26.235:443?type=ws&security=tls&sni=my.sni#EZ-104.19.26.235-99ms-38M
   ```
3. Or click **Download configs** for the same list as a `.txt` file.
4. Other outputs: CSV, XLSX (Excel), JSON, `ip:port` and *IPs only*.

> Security note: when the SNI equals your own domain the scanner warns you. Prefer scanning
> with a generic SNI (for example `www.cloudflare.com`) and putting the discovered addresses
> into your own config afterwards — which is what *Build configs* does.

---

## 6. Scanning your own list (phase two)

- **Paste** tab: one IP / CIDR / range / `ip:port` / domain per line. A domain can carry a
  port too (`my.host:8443`): it is resolved like any other domain and the port is kept.
- Or select rows in the results table and click **Scan only these** (to re-test throughput or
  to re-check them against stricter gates).

With the CLI:

```bash
ezscan scan --source paste --targets my-ips.txt --speed --xlsx found.xlsx
```

---

## 7. Long scans and resuming them

Every scan is saved automatically under `~/.ez-scanner/sessions/`. If the power goes out:

- GUI: **Tools** → **Saved sessions** → pick the session → **Load & resume**.
- CLI: `ezscan resume <session-id>` (the id is printed at the end of each scan, or use
  `ezscan sessions`).

You can also change settings while resuming:

```bash
ezscan resume a1b2c3d4 --speed --top 30
```

---

## 8. Troubleshooting: "no green IPs"

```bash
ezscan doctor      # checks DNS (and resolver tampering), TCP, TLS, HTTP and the throughput path
ezscan selftest    # probes a few real edges and says whether the line or the settings fail
```

- `doctor` fails → the line/network is at fault (DNS, blocking, outage).
- `doctor` is clean but `selftest` is not → TLS is probably being interfered with on your
  line; try `--mode tcp` and another SNI.
- `selftest` is green but your scan is not → the gates are strict: `minScore` to `0`, WS and
  idle off, and the Gentle preset.

---

## 9. Serving the GUI to a phone or another machine

```bash
ezscan gui --no-open --port 8788
```

Then open `http://<linux-ip>:8788/?token=…` in the phone's browser. (The server binds
loopback by default; change the bind to reach it over the network.)

---

## 10. Closing notes

- **The measured speed is the direct path to the edge**, not your tunnel's final speed. Pick
  the winner inside your own client.
- **Cloudflare IPs change constantly** — refresh the results every few days.
- **Data usage**: a probe is a few kilobytes; a throughput test is 8 MB per IP (configurable
  via *Download bytes*).
- **Use it only on your own line and servers.**

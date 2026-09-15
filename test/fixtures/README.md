# Test fixtures

`localhost-key.pem` / `localhost-cert.pem` are a **throw-away self-signed
certificate for `CN=localhost` (SAN: `localhost`, `127.0.0.1`)** generated only
so the test suite can run a real HTTPS/WebSocket server on `127.0.0.1` without
touching the network or a certificate authority.

They are deliberately committed (tests must run offline and without `openssl`),
they are never used by the scanner itself, and they protect nothing. To
regenerate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 3650 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

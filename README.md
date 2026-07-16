#WA Gateway

A lightweight personal WhatsApp gateway for one phone number — perfect for IoT notifications (smart plugs, sensors, alarms) or any application that needs to send WhatsApp messages automatically.

Built on Baileys (an unofficial WhatsApp library), packaged in Docker, with a web dashboard and REST API.

---

## Features

- **Scan QR via browser** — no terminal access required
- **REST API send messages** — to personal numbers or groups
- **Custom Trigger Endpoint** — a simple GET URL that sends messages immediately when hit, suitable for IoT / webhooks / automation
- **Endpoint management via API** — create and delete trigger endpoints without opening the dashboard
- **Group list** — view all groups and their Group IDs directly from the dashboard
- **Session persistence** — no need to re-scan QR after container restart
- **Password-protected dashboard login** — set in `.env`
- **Rate limiting** — anti-abuse and brute-force

---

## How to Use

### 1. Preparation

```bash
git clone https://github.com/<username>/wa-gateway.git
cd wa-gateway
cp .env.example .env
```

Edit `.env`:

```env
LOGIN_PASSWORD=your_strong_password
API_KEY=long_random_string
SESSION_SECRET=other_random_string
PORT=3000
DEVICE_NAME=WA Gateway
```

> Generate random string: `openssl rand -hex 32`

### 2. Run

```bash
docker compose up -d --build
```

### 3. Connect to WhatsApp

Open `http://<server-ip>:3000` → login → click **Start Connection** → scan QR code from your phone (WhatsApp → Linked Devices → Link Device).

### 4. Update Image (without losing sessions)

```bash
docker compose up -d --build
```

The `auth_session/` and `data/` folders are mounted as volumes — WA sessions and endpoint configurations remain secure.

---

## Portainer

Add a new stack, populate it with the contents of `docker-compose.yml`, then set the following environment variables in the **Environment** section:

| Variable | Description |
|---|---|
| `LOGIN_PASSWORD` | Dashboard login password |
| `API_KEY` | API key for REST API |
| `SESSION_SECRET` | Secret for signing session cookies |
| `PORT` | Server port (default: 3000) |
| `DEVICE_NAME` | Device name in WhatsApp (optional) |

Make sure the `auth_session` and `data` volumes are configured to prevent session loss during image updates.

---

## REST API

All API endpoints must include the following header:
```
x-api-key: <API_KEY from .env>
```

### Send Message

```
POST /api/send
```

```json
{ "number": "08123456789", "message": "Hello from WhatsApp Gateway" }
```

Accepted `number` formats:
- `08123456789` — local number
- `628123456789` — international format
- `628123456789@s.whatsapp.net` — personal JID
- `1234567890-1234567890@g.us` — Group ID (see the Groups tab in dashboard)

**Response:**
```json
{ "ok": true, "messageId": "ABCD1234..." }
```

**Curl example:**
```bash
curl -X POST http://server:3000/api/send\ 
-H "x-api-key:YOUR_API_KEY"\ 
-H "Content-Type: application/json" \ 
-d '{"number":"08123456789","message":"High temperature sensor!"}'
```

---

### Check Connection Status

```
GET /api/status
```

```json
{ "ok": true, "status": "connected", "hasQr": false }
```

`status`: `disconnected` | `connecting` | `qr` | `connected`

---

## Custom Trigger Endpoint

A trigger endpoint is a simple GET URL that can be accessed from anywhere — browser, curl, ESP8266, Home Assistant, IFTTT, etc. — and immediately sends a configured WhatsApp message.

### URL Format

```
GET /trigger/<path>?key=<key>
```

Invalid key or path does not exist → `404` (no information leaked).

**Example usage from ESP8266/Arduino:**
```cpp
HTTPClient http;
http.begin("http://192.168.1.100:3000/trigger/alarm-pintu?key=kuncirahasia99");
http.GET();
```

**Example of curl:**
```bash
curl "http://server:3000/trigger/notif-alarm?key=kuncirahasia99"
# → {"ok":true}
```

---

### Trigger Endpoint Management via API

In addition to the dashboard, trigger endpoints can be managed via the REST API using the `x-api-key`.

#### List all endpoints

```
GET /api/endpoints
```

```json
{ 
"ok": true, 
"endpoints": [ 
{ 
"id": "abc123", 
"path": "notif-alarm", 
"label": "Home Alarm", 
"number": "08123456789", 
"message": "Alarm sounds!", 
"hitCount": 5, 
"lastHit": "2025-01-15T10:30:00.000Z", 
"createdAt": "2025-01-01T00:00:00.000Z" 
} 
]
}
```

#### Add new endpoint

```
POST /api/endpoints
```

```json
{ 
"triggerPath": "notif-alarm",
"key": "kuncirahasia99",
"number": "08123456789",
"message": "Alarm sounds!",
"label": "Home Alarm"
}
```

`triggerPath` rule: only letters, numbers, dashes, underscores — maximum 64 characters.
Key must be at least 8 characters.

**Response:**
```json
{ "ok": true, "entry": { "id": "abc123", "path": "notif-alarm", ... } }
```

#### Delete endpoint

```
DELETE /api/endpoints/<id>
```

```json
{ "ok": true }
```

---

## Example of IoT Integration

### ESP8266 / ESP32

```cpp
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

const char* WA_GATEWAY = "http://192.168.1.100:3000/trigger/alarm-door";
const char* TRIGGER_

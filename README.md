# WA Gateway

Personal WhatsApp gateway ringan untuk satu nomor HP — cocok untuk notifikasi IoT (smart plug, sensor, alarm) atau aplikasi apapun yang butuh kirim pesan WhatsApp secara otomatis.

Dibangun di atas [Baileys](https://github.com/WhiskeySockets/Baileys) (library WA unofficial), dikemas dalam Docker, dengan dashboard web dan REST API.

---

## Fitur

- **Scan QR lewat browser** — tidak perlu akses terminal
- **REST API kirim pesan** — ke nomor personal maupun grup
- **Custom Trigger Endpoint** — URL GET sederhana yang langsung kirim pesan saat di-hit, cocok untuk IoT / webhook / automation
- **Manajemen endpoint via API** — buat dan hapus trigger endpoint tanpa buka dashboard
- **Daftar grup** — lihat semua grup beserta Group ID-nya langsung dari dashboard
- **Session persist** — tidak perlu scan QR ulang setelah container restart
- **Login dashboard dilindungi password** — diset di `.env`
- **Rate limiting** — anti abuse dan brute-force

---

## Cara Pakai

### 1. Persiapan

```bash
git clone https://github.com/<username>/wa-gateway.git
cd wa-gateway
cp .env.example .env
```

Edit `.env`:

```env
LOGIN_PASSWORD=password_kuat_kamu
API_KEY=string_acak_panjang
SESSION_SECRET=string_acak_lain
PORT=3000
DEVICE_NAME=WA Gateway
```

> Generate string acak: `openssl rand -hex 32`

### 2. Jalankan

```bash
docker compose up -d --build
```

### 3. Hubungkan WhatsApp

Buka `http://<ip-server>:3000` → login → klik **Mulai Koneksi** → scan QR dari HP (WhatsApp → Perangkat Tertaut → Tautkan Perangkat).

### 4. Update Image (tanpa kehilangan sesi)

```bash
docker compose up -d --build
```

Folder `auth_session/` dan `data/` di-mount sebagai volume — sesi WA dan konfigurasi endpoint tetap aman.

---

## Portainer

Tambahkan stack baru, isi dengan isi `docker-compose.yml`, lalu set environment variable berikut di bagian **Environment**:

| Variable | Keterangan |
|---|---|
| `LOGIN_PASSWORD` | Password login dashboard |
| `API_KEY` | API key untuk REST API |
| `SESSION_SECRET` | Secret untuk signing cookie session |
| `PORT` | Port server (default: 3000) |
| `DEVICE_NAME` | Nama perangkat di WA (opsional) |

Pastikan volumes `auth_session` dan `data` sudah dikonfigurasi agar sesi tidak hilang saat update image.

---

## REST API

Semua endpoint API wajib menyertakan header:
```
x-api-key: <API_KEY dari .env>
```

### Kirim Pesan

```
POST /api/send
```

```json
{ "number": "08123456789", "message": "Halo dari WA Gateway" }
```

Format `number` yang diterima:
- `08123456789` — nomor lokal
- `628123456789` — format internasional
- `628123456789@s.whatsapp.net` — JID personal
- `1234567890-1234567890@g.us` — Group ID (lihat tab Grup di dashboard)

**Response:**
```json
{ "ok": true, "messageId": "ABCD1234..." }
```

**Contoh curl:**
```bash
curl -X POST http://server:3000/api/send \
  -H "x-api-key: API_KEY_KAMU" \
  -H "Content-Type: application/json" \
  -d '{"number":"08123456789","message":"Sensor suhu tinggi!"}'
```

---

### Cek Status Koneksi

```
GET /api/status
```

```json
{ "ok": true, "status": "connected", "hasQr": false }
```

`status`: `disconnected` | `connecting` | `qr` | `connected`

---

## Custom Trigger Endpoint

Trigger endpoint adalah URL GET simpel yang bisa di-hit dari mana saja — browser, curl, ESP8266, Home Assistant, IFTTT, dsb — dan langsung mengirim pesan WA yang sudah dikonfigurasi.

### Format URL

```
GET /trigger/<path>?key=<key>
```

Key salah atau path tidak ada → `404` (tidak ada info yang bocor).

**Contoh penggunaan dari ESP8266/Arduino:**
```cpp
HTTPClient http;
http.begin("http://192.168.1.100:3000/trigger/alarm-pintu?key=kuncirahasia99");
http.GET();
```

**Contoh dari curl:**
```bash
curl "http://server:3000/trigger/notif-alarm?key=kuncirahasia99"
# → {"ok":true}
```

---

### Manajemen Trigger Endpoint via API

Selain lewat dashboard, trigger endpoint bisa dikelola via REST API menggunakan `x-api-key`.

#### List semua endpoint

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
      "label": "Alarm Rumah",
      "number": "08123456789",
      "message": "Alarm berbunyi!",
      "hitCount": 5,
      "lastHit": "2025-01-15T10:30:00.000Z",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

#### Tambah endpoint baru

```
POST /api/endpoints
```

```json
{
  "triggerPath": "notif-alarm",
  "key": "kuncirahasia99",
  "number": "08123456789",
  "message": "Alarm berbunyi!",
  "label": "Alarm Rumah"
}
```

Aturan `triggerPath`: hanya huruf, angka, dash, underscore — max 64 karakter.
Key minimal 8 karakter.

**Response:**
```json
{ "ok": true, "entry": { "id": "abc123", "path": "notif-alarm", ... } }
```

#### Hapus endpoint

```
DELETE /api/endpoints/<id>
```

```json
{ "ok": true }
```

---

## Contoh Integrasi IoT

### ESP8266 / ESP32

```cpp
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

const char* WA_GATEWAY = "http://192.168.1.100:3000/trigger/alarm-pintu";
const char* TRIGGER_KEY = "kuncirahasia99";

void kirimNotifWA() {
  HTTPClient http;
  String url = String(WA_GATEWAY) + "?key=" + TRIGGER_KEY;
  http.begin(url);
  int code = http.GET();
  http.end();
}
```

### Home Assistant (REST command)

```yaml
rest_command:
  notif_wa_alarm:
    url: "http://192.168.1.100:3000/trigger/alarm-rumah?key=kuncirahasia99"
    method: GET
```

### Node-RED

Gunakan node **HTTP Request** dengan method GET ke URL trigger. Bisa dikombinasikan dengan node inject, mqtt, atau sensor input.

### Python

```python
import requests

def kirim_wa(pesan):
    requests.post(
        "http://server:3000/api/send",
        json={"number": "08123456789", "message": pesan},
        headers={"x-api-key": "API_KEY_KAMU"}
    )

kirim_wa("Suhu ruangan: 35°C — melebihi batas!")
```

---

## Keamanan

- Dashboard login dilindungi password + rate limit (10 percobaan / 15 menit)
- REST API dilindungi API key di header `x-api-key`
- Trigger endpoint: key salah atau path tidak ada selalu return `404`
- Rate limit trigger: 20 request / menit per IP
- `trust proxy` diaktifkan untuk kompatibilitas Docker/reverse proxy

> **Catatan:** Baileys adalah library *unofficial* — gunakan secara wajar. Jangan untuk spam atau bulk messaging agar nomor tidak terkena banned WhatsApp.

---

## Struktur Proyek

```
wa-gateway/
├── src/
│   ├── server.js        # Express server, semua routing
│   ├── whatsapp.js      # Koneksi Baileys, kirim pesan, daftar grup
│   ├── endpoints.js     # CRUD custom trigger endpoints (simpan ke JSON)
│   ├── middleware.js    # Auth: session login & API key
│   └── public/
│       ├── login.html   # Halaman login
│       └── dashboard.html  # Dashboard (Status WA, Custom Endpoints, Grup)
├── auth_session/        # Sesi WA Baileys (auto-dibuat, di-mount volume)
├── data/
│   └── endpoints.json   # Konfigurasi custom endpoints (di-mount volume)
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

---

## Volumes yang Harus Di-mount

| Path di container | Isi | Keterangan |
|---|---|---|
| `/app/auth_session` | Kredensial sesi WA | Hilang = scan QR ulang |
| `/app/data` | `endpoints.json` | Hilang = konfigurasi endpoint hilang |

Sudah dikonfigurasi di `docker-compose.yml`. Untuk Portainer, pastikan kedua volume ini di-bind ke folder di host.

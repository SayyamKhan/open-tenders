# Evrim Tender Radar — Deployment Guide

## What This Does

Scrapes 5 official Pakistani government tender portals every day, verifies each tender against source text, scores them by keyword relevance, and shows them in a clean dashboard.

No external API keys required — everything runs locally.

**Portals scraped:**
- Punjab e-Procurement (eproc.punjab.gov.pk)
- PPRA Federal EPADS (epms.ppra.gov.pk)
- MoITT Federal (moitt.gov.pk)
- KPPRA Khyber Pakhtunkhwa (kppra.gov.pk)
- BPPRA Balochistan (bppqa.vdc.services)

---

## Requirements

- **Node.js 18+** (recommended: Node 20 LTS)
- **Linux server** (Ubuntu 22.04+ recommended) or macOS
- At least **2 GB RAM** (Playwright runs a headless browser)

---

## Step-by-Step Setup

### 1. Copy the project folder to your server

```bash
scp -r evrim-tender-radar-deploy/ user@your-server:/opt/tender-radar/
```

### 2. Install Node.js dependencies

```bash
cd /opt/tender-radar
npm install
```

### 3. Install Playwright's Chromium browser

```bash
# Install the browser binary
npx playwright install chromium

# Install system dependencies (Linux only — needs sudo)
npx playwright install-deps chromium
```

> **Note:** On Ubuntu/Debian, `install-deps` will install required system libraries (libglib, libnss, etc). This step requires root/sudo access.

### 4. Configure environment (optional)

The defaults work out of the box. To customize, copy and edit:

```bash
cp .env.example .env
nano .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3001 | Port the web server runs on |
| `PLAYWRIGHT_HEADLESS` | true | Keep `true` for servers (no GUI needed) |
| `REFRESH_CRON` | `0 8 * * *` | Auto-refresh schedule (daily at 8:00 AM Pakistan time) |
| `REQUEST_TIMEOUT_MS` | 90000 | Timeout for each portal scrape (ms) |

### 5. Start the server

```bash
npm start
```

The app will be available at `http://your-server:3001`

---

## Running as a Background Service (Recommended)

### Option A: Using PM2 (simplest)

```bash
# Install PM2 globally
npm install -g pm2

# Start the app
pm2 start server.js --name tender-radar

# Auto-start on server reboot
pm2 startup
pm2 save
```

Useful PM2 commands:
```bash
pm2 status              # Check if running
pm2 logs tender-radar   # View logs
pm2 restart tender-radar  # Restart
```

### Option B: Using systemd (Linux native)

Create `/etc/systemd/system/tender-radar.service`:

```ini
[Unit]
Description=Evrim Tender Radar
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/tender-radar
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/opt/tender-radar/.env

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable tender-radar
sudo systemctl start tender-radar
```

---

## Reverse Proxy (Optional)

To serve on port 80/443 behind Nginx:

```nginx
server {
    listen 80;
    server_name tenders.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## How It Works

1. **On startup**, the server does an initial scrape of all 5 portals
2. **Daily at 8:00 AM PKT** (configurable), it auto-refreshes
3. **Manual refresh** via the "Refresh Now" button in the UI
4. Each refresh takes ~1-2 minutes (Playwright visits each portal sequentially)
5. Tenders are scored by keyword matching against Evrim Tech's focus areas (software, digital, fintech, cybersecurity, IT equipment, etc.)
6. Tenders are stored in `data/tenders.json` and persist across restarts

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Error: browserType.launch` | Run `npx playwright install chromium` and `npx playwright install-deps chromium` |
| KPK shows 0 tenders | The KPPRA website (kppra.gov.pk) is sometimes down — it will work when the site is back |
| Balochistan shows 0 tenders | BPPRA may have no active tenders posted at the moment |
| Port already in use | Change `PORT` in `.env` to another port |
| Scraping timeout | Increase `REQUEST_TIMEOUT_MS` in `.env` (default: 90000ms) |

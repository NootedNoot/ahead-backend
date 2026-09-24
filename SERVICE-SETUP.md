# Ahead Local Server: 24/7 Unattended Boot Service Setup

This setup ensures that your Ahead Node.js backend server and Cloudflare Tunnel run **continuously as a Windows System Service**, starting automatically when your computer powers on or reboots—**even before anyone logs into Windows**.

---

## 🚀 1-Click Installation

1. Open File Explorer to:
   ```
   C:\Users\singe\Projects\ahead-backend
   ```
2. Right-click or double-click **`install-service.bat`**.
3. When Windows prompts for Administrator access (UAC), click **"Yes"**.
4. The installer will:
   - Clean up any old unmanaged processes on port 3000.
   - Register the Windows Scheduled Task **`AheadLocalServer`** with:
     - **Trigger**: At computer startup (`/SC ONSTART`)
     - **Account**: `NT AUTHORITY\SYSTEM` (Runs unattended in background without login)
     - **Privilege**: Highest (`/RL HIGHEST`)
     - **Crash Recovery**: Auto-restarts within 60 seconds if killed.
     - **No Timeout**: Runs indefinitely 24/7/365.
   - Launch the supervisor immediately.
   - Verify health on `http://localhost:3000/health`.
   - Output your active public Cloudflare Tunnel URL.

---

## 🛠️ Management Utilities

In `C:\Users\singe\Projects\ahead-backend`, you have 4 double-clickable batch files:

| Batch File | Description | Admin Needed? |
|---|---|---|
| **`status-service.bat`** | Check if the service is running, see Node/Tunnel PIDs, check healthcheck, and view live logs. | No |
| **`restart-service.bat`** | Gracefully restarts the background server and tunnel. | Yes (auto-prompts) |
| **`install-service.bat`** | Installs/re-installs the auto-start boot service. | Yes (auto-prompts) |
| **`uninstall-service.bat`** | Stops and completely removes the boot service from Windows. | Yes (auto-prompts) |

---

## 🔒 Lock In a Permanent Free Domain (`api.aheadt1d.com`)

By default, Cloudflare Quick Tunnels (`*.trycloudflare.com`) assign a temporary random URL that changes on reboot.

Since you own **`aheadt1d.com`** on Cloudflare, you can make the URL permanent for **$0/month** so your phone app and website never need reconfiguration:

1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com/) and go to **Zero Trust** > **Networks** > **Tunnels**.
2. Click **Create a tunnel** -> Choose **Cloudflare** connector -> Click Next.
3. Name it: `ahead-local`.
4. Cloudflare will show an install command with a token:
   `cloudflared.exe tunnel run --token eyJhIjoi...`
   Copy that token string starting with `eyJh...`.
5. Open `C:\Users\singe\Projects\ahead-backend\tunnel-token.txt` and paste that token into the file.
6. Open `C:\Users\singe\Projects\ahead-backend\custom-domain.txt` and enter `https://api.aheadt1d.com`.
7. Back on Cloudflare's web dashboard, in the **Public Hostnames** tab:
   - Subdomain: `api`
   - Domain: `aheadt1d.com`
   - Service Type: `HTTP`
   - URL: `localhost:3000`
8. Double-click **`restart-service.bat`**.

From that point forward, your local PC will ALWAYS be reachable at:
```
https://api.aheadt1d.com
```

---

## 🌐 Website Portal Synchronization

The Ahead web portal (`https://aheadt1d.com/portal.html`) now supports seamless switching between Railway Cloud and your Local PC Server:

- Look at the top right of the Portal header next to "Stream".
- You will see a live **Server Status pill** (e.g. `[🟢 Railway Cloud]` or `[🟢 Local Tunnel]`).
- Click on it to open the **Backend Server Sync Modal**:
  - **Railway Cloud**: Default cloud instance.
  - **Local PC (Cloudflare Tunnel)**: Points to your home PC's live tunnel.
  - **Localhost Direct**: Fast direct connection when using this computer.
  - **Custom URL**: Type `https://api.aheadt1d.com` or any custom address.
  - Click **Test Ping** to measure live response time in milliseconds.
  - Click **Save & Connect** to switch immediately.
- If Railway or your local server goes offline, the portal alerts you and provides a 1-click button to switch servers.

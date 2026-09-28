# Binventory

Self-hosted storage bin inventory for Unraid (or any Docker host).

- Phone-friendly web app (add it to your home screen)
- Each bin has a rack/shelf/position, a name, a short description, an item list with quantities, photos, notes and tags
- Prints **4×6 in shipping labels** (PDF, one bin per page) with the location in large type, the description, and a QR code
- Scanning the QR code with a phone camera opens that bin's full contents list and photos
- Search across bins *and* the items inside them ("where's the HDMI cable?")
- Optional **local AI** (Ollama): looks at a bin's photos, writes the description and adds search tags, all on your own server

Data (SQLite database + photos) lives in `/data`.

## Install on Unraid

Every push to `main` builds the image with GitHub Actions and publishes it to
`ghcr.io/rickxxrolling/binventory:latest`, so Unraid pulls it like any other container.

1. Open the Unraid terminal (**>_** icon, top right) and download the template:
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-binventory.xml https://raw.githubusercontent.com/RICKxxROLLING/binventory/main/unraid/binventory.xml
   ```
2. **Docker → Add Container** and choose **binventory** from the Template dropdown (under *User templates*).
   No terminal? Add the container manually instead: Repository `ghcr.io/rickxxrolling/binventory:latest`,
   a Path `/data` → `/mnt/user/appdata/binventory`, a Port `8080` → `8080`, and a Variable `BASE_URL`.
3. Set **BASE_URL** to the address your phone uses to reach it, e.g. `http://192.168.1.10:8080`
   (your Unraid IP + port). This URL is printed into every QR code, so choose something stable.
   Check the **Data** path (default `/mnt/user/appdata/binventory`) and hit **Apply**.
4. Open `http://<unraid-ip>:8080` on your phone.

**Updating:** push changes to `main`, wait for the Actions build to finish, then in Unraid use
**Check for Updates → Apply update** on the container.

**Private repo?** GHCR packages are private by default. Either make the package public
(GitHub → your profile → Packages → binventory → Package settings → Change visibility) or log
Unraid in once from its terminal: `docker login ghcr.io -u RICKxxROLLING` with a personal access
token that has `read:packages`.

**Alternative (Compose Manager plugin):** edit `docker-compose.yml` (BASE_URL, volume path) and run
`docker compose up -d`.

**Build it yourself instead:** `docker build -t binventory:latest .` in this folder, then set the
template's Repository to `binventory:latest`.

## Settings (environment variables)

| Variable     | Default | Purpose |
|--------------|---------|---------|
| `BASE_URL`   | request host | URL encoded in QR codes. **Set this.** |
| `BIN_PREFIX` | `BIN`   | Bin code prefix → `BIN-0001` |
| `AUTH_USER` / `AUTH_PASS` | empty | Login. **Required for access from outside your home network** (see below). |
| `SESSION_DAYS` | `90` | How long a device stays signed in |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which reverse proxies' `X-Forwarded-For` to believe (Express syntax) |
| `ALLOW_PUBLIC_NO_AUTH` | `false` | Allow non-LAN clients with no login. Don't. |
| `PORT`       | `8080`  | Internal port |
| `DATA_DIR`   | `/data` | Database + photo storage |
| `OLLAMA_URL` | empty   | Ollama address, e.g. `http://192.168.1.10:11434`. Blank = AI off. |
| `OLLAMA_MODEL` | `gemma3:4b` | Vision model used to look at photos |
| `AI_AUTO`    | `true`  | Analyze photos automatically when they're uploaded |
| `AI_MAX_PHOTOS` | `4`  | Newest N photos of a bin sent to the model |
| `AI_NUM_CTX` | `8192`  | Model context size (room for several photos). Lower it if the model doesn't fit in VRAM. |

## Local AI (auto description + tags)

With a local vision model, whenever you add photos to a bin **or edit what's in it** (name, contents list, notes),
Binventory sends the photos and your contents list to [Ollama](https://ollama.com) running on your own hardware
(nothing leaves your network) and:

- **Description**: written by the AI when it's empty, and rewritten whenever the contents change so the label stays accurate.
  Type your own and it becomes yours: the AI never touches it again. Clear it to hand it back to the AI.
  Your contents list is treated as the truth, so items packed out of sight still make it into the description and tags.
  Bins without photos work too, from the contents list alone.
- **Name**: fills it in if you left it blank, so you can just snap a photo and hit *Create bin*.
- **Tags**: adds category tags (`cables`, `electrical`, `holiday`...), highlighted in the app. Each run replaces the previous AI tags, so tags for things you've taken out disappear. Tags you typed yourself are always kept. Editing only the location or tags doesn't trigger a run.
- **Spotted by AI**: a list of the objects it identified. These are searchable too, so "HDMI" finds the bin
  even if you never typed it. One tap copies them into the bin's contents.

Analysis runs in the background, one bin at a time, and the bin page updates when it's done.
Use **Re-analyze** on a bin to run it again, or **Settings → Local AI → Analyze N bins** for bins that already had photos.

**Setup on Unraid**
1. Install **Ollama** from Community Applications (with the Nvidia driver plugin if you have a GPU; CPU-only works but is slower, roughly 20-90 s per bin).
2. Pull a vision model from the Ollama container's console: `ollama pull gemma3:4b`
3. In Binventory, set `OLLAMA_URL` to `http://<unraid-ip>:11434` and apply.
4. **Settings → Local AI** should say *Connected*.

**Nvidia GPU:** install the **Nvidia Driver** plugin, then in the Ollama container template add `--runtime=nvidia` to
*Extra Parameters* and set `NVIDIA_VISIBLE_DEVICES` to your GPU's UUID (shown on the Nvidia Driver plugin page, or use `all`).
An 8 GB card (e.g. RTX 2070/2080) runs `qwen2.5vl:7b` fully on the GPU: set `OLLAMA_MODEL=qwen2.5vl:7b`.

Model choices: `gemma3:4b` (default, ~3.5 GB, OK on CPU), `qwen2.5vl:7b` (better at reading labels and small parts, ~6 GB, best with a GPU),
`llava-phi3` (small). Any Ollama model that accepts images will work; set `OLLAMA_MODEL` to its name.
Photos in HEIC that the phone couldn't convert are skipped (the app normally uploads JPEGs).

## Printing labels

- From a bin: **Print label**. For many at once: on the main list tap **Select to print**, choose bins, **Print N labels**.
- You get a 4×6 in PDF. Print at **100% / Actual size** (not "fit to page").
- Works with common 4×6 thermal printers (Rollo, Zebra, MUNBYN, Phomemo, etc.). The QR code is vector-drawn so it stays sharp at 203 dpi.
- On a phone: open the PDF → Share → Print (AirPrint), or send it to a computer with the label printer.

## QR codes and reaching the app away from home

QR codes point at `BASE_URL/b/BIN-0001`. The link uses the bin **code**, not its database row, so it keeps working after you edit a bin.

If you later change how you reach the server, update `BASE_URL` and reprint. Or set it to the permanent address from the start
(e.g. your Tailscale name `http://tower:8080`, or `https://bins.example.com`) so labels never need reprinting.

### Built-in protection

- **No login set** → Binventory only answers devices on your home network and Tailscale (private IPs).
  Anything else gets *403*, so accidentally forwarding the port doesn't publish your inventory.
- **`AUTH_USER` + `AUTH_PASS` set** → a login page protects everything: pages, API, photos and label PDFs.
  Each phone signs in once and stays signed in for `SESSION_DAYS` (it works from a home-screen app too).
  Scanning a label while signed out goes to the login page, then straight to that bin.
  - After 10 wrong passwords, that IP is locked out for 15 minutes; failed logins are logged in the container log.
  - Changing `AUTH_PASS` signs every device out. **Settings → Sign out** signs out the current device.
  - Sessions are signed with a random key stored in `/data/session.secret`.
  - Scripts can still use HTTP basic auth (`curl -u user:pass .../api/export`).
- Security headers (CSP, no framing, nosniff; HSTS when served over HTTPS) are always on.

Use a long password (a few random words). It's the only thing between the internet and your inventory.

### Option A: Tailscale (easiest, nothing exposed to the internet)

1. Install Tailscale on Unraid (built in on Unraid 7: **Settings → Tailscale**; otherwise the Tailscale plugin) and on your phone.
2. Set `BASE_URL` to `http://<unraid-tailscale-name>:8080` (MagicDNS) so QR codes work both at home and away.

Tailscale devices count as "local", so a login is optional here. Set one anyway if other people share your tailnet.

### Option B: Public HTTPS via a reverse proxy (Nginx Proxy Manager, SWAG, Cloudflare Tunnel)

1. Set `AUTH_USER` and `AUTH_PASS` first. Without them, the proxied requests are refused (403).
2. Point a proxy host (e.g. `bins.example.com`) at `http://<unraid-ip>:8080` with a Let's Encrypt certificate and *Force SSL*.
3. Set `BASE_URL=https://bins.example.com` and reprint the labels.

Proxies on your LAN or Docker network are trusted automatically for the real client IP. If yours lives
somewhere else (e.g. on a VPS reached over a VPN), add its address to `TRUST_PROXY`.
Never forward port 8080 straight from your router: that would send the password over plain HTTP.

## Backup

Back up `/mnt/user/appdata/binventory` (e.g. with the Appdata Backup plugin). **Settings → Download JSON export** also gives you a full dump of every bin and item.

## Local development

```bash
npm install && npm start
```
Requires Node 22.13+ (uses the built-in `node:sqlite`, so there are no native modules to compile).

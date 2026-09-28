# Binventory

Self-hosted storage bin inventory for Unraid (or any Docker host).

- Phone-friendly web app (add it to your home screen)
- Each bin has a rack/shelf/position, a name, a short description, an item list with quantities, photos, notes and tags
- Prints **4×6 in shipping labels** (PDF, one bin per page) with the location in large type, the description, and a QR code
- Scanning the QR code with a phone camera opens that bin's full contents list and photos
- Search across bins *and* the items inside them ("where's the HDMI cable?")

Data (SQLite database + photos) lives in `/data`.

## Install on Unraid

Every push to `main` builds the image with GitHub Actions and publishes it to
`ghcr.io/rickxxrolling/binventory:latest`, so Unraid pulls it like any other container.

1. In Unraid go to **Docker → Template Repositories** (bottom of the Docker tab), add
   `https://github.com/RICKxxROLLING/binventory` and click **Save**.
   *(Alternative: in the Unraid terminal run
   `wget -O /boot/config/plugins/dockerMan/templates-user/my-binventory.xml https://raw.githubusercontent.com/RICKxxROLLING/binventory/main/unraid/binventory.xml`)*
2. **Docker → Add Container** and choose **binventory** from the Template dropdown.
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
| `AUTH_USER` / `AUTH_PASS` | empty | Optional login (HTTP basic auth). Leave blank on a trusted LAN. |
| `PORT`       | `8080`  | Internal port |
| `DATA_DIR`   | `/data` | Database + photo storage |

## Printing labels

- From a bin: **Print label**. For many at once: on the main list tap **Select to print**, choose bins, **Print N labels**.
- You get a 4×6 in PDF. Print at **100% / Actual size** (not "fit to page").
- Works with common 4×6 thermal printers (Rollo, Zebra, MUNBYN, Phomemo, etc.). The QR code is vector-drawn so it stays sharp at 203 dpi.
- On a phone: open the PDF → Share → Print (AirPrint), or send it to a computer with the label printer.

## QR codes and reaching the app away from home

QR codes point at `BASE_URL/b/BIN-0001`. The link uses the bin **code**, not its database row, so it keeps working after you edit a bin.

If you later change how you reach the server (e.g. add Tailscale or a reverse proxy with a domain), update `BASE_URL` and reprint. Or set it to that permanent address from the start (e.g. your Tailscale MagicDNS name, `http://tower:8080`) so labels never need reprinting.

Don't expose this directly to the internet without `AUTH_USER`/`AUTH_PASS` plus HTTPS through a reverse proxy (SWAG, Nginx Proxy Manager) or a VPN like Tailscale/WireGuard.

## Backup

Back up `/mnt/user/appdata/binventory` (e.g. with the Appdata Backup plugin). **Settings → Download JSON export** also gives you a full dump of every bin and item.

## Local development

```bash
npm install && npm start
```
Requires Node 22.13+ (uses the built-in `node:sqlite`, so there are no native modules to compile).

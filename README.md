# Media Manager

Automated media pipeline for Unraid. Search for content, download via seedbox, rename with TMDB metadata, and organize into your Plex libraries — all hands-free.

## What It Does

1. **Search** — Find movies and TV shows via TMDB
2. **Download** — Auto-selects the best torrent via Prowlarr → qBittorrent
3. **Transfer** — SFTP from seedbox to your NAS
4. **Rename** — Matches TMDB metadata for clean Plex-friendly names
5. **Organize** — Moves files into the right Plex library folder

Two containers work together:
- **Media Manager** — The engine. Runs the pipeline, serves the settings UI and API
- **[Media Companion](https://github.com/Pennderin/Media-Companion)** — The remote. Mobile-friendly PWA to search and request content from any device

## Requirements

- Unraid NAS
- Seedbox with qBittorrent and SFTP access
- [Prowlarr](https://prowlarr.com/) running on your network
- Free [TMDB API key](https://www.themoviedb.org/settings/api)

## Install

Open your Unraid terminal and run:

```bash
curl -s https://raw.githubusercontent.com/Pennderin/Media-Manager/main/install.sh | bash
```

The installer will:
- Ask for your NAS IP and Plex library paths (Movies, TV Shows, Staging)
- Pull both Docker images
- Create and start both containers
- Install Unraid templates (for icons and easy updates)

## Configure

After install, open:

```
http://YOUR_NAS_IP:9876/admin
```

The settings page walks you through each field with hints explaining where to find every value. Fill in your credentials and click **Save All Settings** → **Test All Connections**.

| Setting | Where to find it |
|---------|-----------------|
| qBittorrent URL | Your seedbox provider dashboard |
| qBittorrent username/password | Your seedbox provider dashboard |
| SFTP host/port/username/password | Your seedbox provider dashboard |
| Prowlarr URL | Usually `http://YOUR_NAS_IP:9696` |
| Prowlarr API Key | Prowlarr → Settings → General |
| TMDB API Key | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) (free) |

## Media Libraries

The installer sets up **Movies** and **TV Shows** by default. Need more? Add them from the settings page:

1. Open `http://YOUR_NAS_IP:9876/admin`
2. Scroll to **Media Libraries**
3. Click **+ Add Library**
4. Name it (e.g., "Anime Movies"), set the container path (e.g., `/media/anime-movies`)
5. Check **Shows?** if it contains TV shows (enables episode matching and season folders)
6. Add a matching Docker volume mount: `-v /mnt/user/Plex/Anime Movies:/media/anime-movies`

Libraries without "Shows?" checked use movie processing logic. Libraries with it checked use TV logic (episode detection, season folders, series matching).

## Use

Open the Companion from any phone or browser:

```
http://YOUR_NAS_IP:3001
```

Search for a movie or show, tap **Get**, and it handles the rest. Add it to your home screen for the best experience — it works as a native-feeling app.

## Optional Features

- **SMS Notifications** — Get texted when downloads hit Plex. Configure Gmail SMTP in settings.
- **Plex Duplicate Detection** — Warns before grabbing content already in your library. Add your Plex URL and token in settings.
- **Desktop App** — [Media Manager Desktop](https://github.com/Pennderin/Media-Manager-Desktop) for a full Windows interface with queue management.

## Update

Unraid shows update notifications when new versions are available. Click update in the Docker tab — your settings are preserved automatically.

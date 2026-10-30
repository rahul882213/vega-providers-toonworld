# ToonWorld4All Vega Streaming Provider

A standalone provider extension for the **Vega streaming application** that scrapes media catalogs, searches, episode lists, and extracts streams from **ToonWorld4All** (`https://toonworld4all.me`).

## 📁 Provider Files

```
providers/toonworld4all/
├── manifest.json       # Provider descriptor and capabilities
├── meta.ts             # Metadata (id, name, version, type)
├── catalog.ts          # Category listings and genres
├── posts.ts            # Search and catalog feed fetcher
├── episodes.ts         # Episode list extractor from accordion components
├── stream.ts           # Stream extractor (m3u8, mp4, embed players)
├── types.ts            # Standard Vega TypeScript definitions
└── README.md           # Documentation & integration instructions
```

## 🚀 How to Integrate with Vega

1. **Copy the Provider Folder**:
   Copy the `providers/toonworld4all` folder into your `vega-org/providers-template` repository under `providers/`:
   ```bash
   cp -r providers/toonworld4all /path/to/vega-org/providers-template/providers/
   ```

2. **Register in Root Manifest (if applicable)**:
   Add `toonworld4all` to your providers index or `manifest.json`:
   ```json
   {
     "id": "toonworld4all",
     "name": "ToonWorld4All",
     "path": "./providers/toonworld4all"
   }
   ```

3. **Test with Vega CLI**:
   Run the Vega provider test suite:
   ```bash
   # Test catalog
   npm run test:provider -- toonworld4all catalog

   # Test posts
   npm run test:provider -- toonworld4all posts

   # Test search
   npm run test:provider -- toonworld4all search naruto

   # Test stream
   npm run test:provider -- toonworld4all stream "<episode_url>"
   ```

4. **Build & Bundle**:
   ```bash
   npm run build
   ```

## 🎥 Supported Stream Extraction Features

- **Direct HLS Streams (`.m3u8`)**: Unpacks Dean Edwards obfuscated scripts from StreamWish / EmbedWish.
- **Archive System (`archive.toonworld4all.me`)**: Parses Next.js/React `window.__PROPS__` to extract player links and resolution encodes (`480p`, `720p`, `1080p`, `1080p HQ`).
- **Cloud Hosts**: Extracts and unmasks redirect tokens for HubCloud, Filepress, GDFlix, and MEGA without shortener ad loops.
- **Legacy Posts**: Decodes base64 `url=` parameters from legacy `redirect/main.php` links.
- **Vega Stream Protocol**: Always outputs stream objects with `server`, `link`, `type: 'm3u8' | 'mp4' | 'embed'`, and appropriate `headers` (`Referer`, `User-Agent`).

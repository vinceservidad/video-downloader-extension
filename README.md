# My Video Downloader

A clean, original Manifest V3 Chrome extension that detects video media on the
pages you visit and lets you save it. Built from scratch — no third-party
product code, no license/paywall logic.

> **Use responsibly.** Only download content you own or have explicit
> permission to save. Many sites' terms of service and copyright law restrict
> redistributing others' content (including paid course material). This tool
> does not bypass any DRM or access control — it only saves media your browser
> has already loaded for you.

## How it works

| Piece | Role |
|-------|------|
| `background.js` | Service worker. Sniffs media requests per tab (`.m3u8`, `.mp4`, …, skipping stream segments), keeps detections and download jobs in `chrome.storage.session`, and runs each download as a job. |
| `content.js` | Scans the page DOM for `<video>`/`<source>` URLs and answers the popup's "which lesson number is this?" question. |
| `offscreen.js` | Assembles HLS streams: picks the variant for your quality setting plus its audio track, downloads and decrypts segments (AES-128, byte ranges), and remuxes into a proper MP4 with ffmpeg.wasm (`-c copy`, lossless). Jobs run one at a time. |
| `popup.html` / `popup.js` | Lists detected videos; shows live progress, lets you cancel, and picks up running downloads when reopened. |
| `generate-icons.js` | Regenerates the toolbar icons (`node generate-icons.js`). |

Download order for each job:

1. **Loom** embeds: ask Loom's own API (from inside the Loom iframe) for the
   signed MP4 or HLS URL.
2. **Offscreen assembler** for HLS and direct files, with the page's cookies and
   Referer attached via temporary `declarativeNetRequest` session rules that
   only apply to the extension's own requests and are removed when the job ends.
3. **In-page fallback** if the host refuses the extension (401/403): the video is
   fetched inside the page's frame and saved by the page (to your default
   Downloads folder; a `.ts` file for plain MPEG-TS streams).

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension. Browse to a page with a video, **press play**, then click
   the icon to see detected media.

After editing the code, **Remove** the extension and **Load unpacked** again
(the reload button doesn't always pick up changes). The popup title shows the
version, and assembler errors carry a build marker like `[off1.7]`.

## Limitations

- **DASH (`.mpd`)** streams aren't assembled (detection is skipped).
- **YouTube** serves adaptive split audio/video streams; this tool won't merge
  those. Use a dedicated tool like `yt-dlp` for YouTube content you're allowed
  to download.
- HLS only supports unencrypted and AES-128 streams (not SAMPLE-AES / DRM).
- Merging happens in the browser; ffmpeg.wasm has a 2 GB memory ceiling, so
  very long lessons may need a lower quality setting.

## Privacy

Everything runs locally in your browser. No analytics, no external servers, no
account or license check.

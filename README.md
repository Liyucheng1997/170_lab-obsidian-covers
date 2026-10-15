# Base Cover Image Generator

An Obsidian plugin that generates cover images for your **Base** card notes using
Google's Gemini **Nano Banana** image models, then writes the image into a `cover`
property as a link so it shows up as the card cover in Bases.

## What it does

- Generates a cover image for a note from its title + content via the Gemini API.
- Saves the image to a folder you choose — or to Obsidian's default attachment folder.
- Writes the image into the note's `cover` property **as a link** (`[[image.png]]`,
  i.e. the embed `!` is removed) so Obsidian Bases renders it as the card cover.
- **Right-click** a note (File Explorer / editor) to generate or **regenerate** the cover.
- **Right-click a folder** to batch-generate covers for every note (optionally only
  notes that don't have one yet).
- **Find real covers on the web** for book, movie/TV and person notes: searches
  **Douban** (豆瓣读书 / 豆瓣电影) by note name, with **Wikipedia** as a fallback,
  downloads the image into your vault and links it in `cover`. No API key needed.

## Install into your vault

1. Build the plugin (or use the prebuilt files):
   ```bash
   npm install
   npm run build
   ```
2. Create a folder in your vault:
   `<your-vault>/.obsidian/plugins/base-cover-image/`
3. Copy **`main.js`**, **`manifest.json`**, and **`styles.css`** into that folder.
4. In Obsidian: **Settings → Community plugins**, enable *Base Cover Image Generator*.

For development, you can instead symlink this project folder into the plugins folder
and run `npm run dev` for an auto-rebuilding watch build.

## Setup

Open **Settings → Base Cover Image Generator**:

| Setting | Notes |
| --- | --- |
| **API key** | Your Google Gemini API key (from Google AI Studio). |
| **Model** | Default `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite). Any Gemini image model id works. |
| **Aspect ratio / Image size** | Requested output shape and resolution. |
| **Use default attachment folder** | On: follow your *Files & Links* attachment setting. Off: pick a custom folder. |
| **Cover property** | Frontmatter key to write (default `cover`). |
| **Write as embed** | Off (recommended) → link `[[image]]` for Bases covers. On → embed `![[image]]`. |
| **Prompt template** | Supports `{{title}}`, `{{content}}`, `{{prop:name}}`. |
| **Content length** | How much note body to feed into `{{content}}`. |

## Usage

- **Ribbon icon** or command *"Generate cover for the current note"* — for the open note.
- **Right-click a note** → *Generate / Regenerate cover image*.
- **Right-click a folder** → *Generate covers for notes in folder* (or *…missing one*).

The generated link lands in the `cover` property. Point your Base card view's image
property at `cover` and the covers appear on the cards.

## Web covers (Douban / Wikipedia)

For notes about things that already have a cover — books, films, TV series, people —
you can fetch the real image instead of generating one.

- **Right-click a note** → *Find cover on the web (Douban / Wikipedia)*, or run the
  command of the same name. A picker shows the results as thumbnails; you can edit the
  search text or type and search again, then click the image you want.
- **Right-click a folder** → *Find covers on the web for notes missing one*.
- **Right-click a `.base` file** → *Find covers on the web for notes in this Base
  (missing one)*, or run the command while the Base is open.

Batch runs pick the best result automatically. With *Batch: only accept matching
titles* on (the default), a note is skipped when no result's title matches its name,
so you don't end up with a wrong cover. Skipped notes can be done one by one with
the picker.

**What gets searched.** The note name, with a `【书籍】`-style prefix and `《》`
removed (configurable regex). You can add properties, e.g. `{{title}} {{prop:author}}`.

**Book, movie or person?** The plugin reads the type property (default `类型`), the
note's tags and a `【…】` name prefix, and matches them against keyword lists
(e.g. `书籍` → book, `电影`/`电视剧`/`纪录片` → movie, `人物` → person). If nothing
matches it searches all categories.

**Sources.** Douban covers books, movies, TV and many people (including historical
and literary figures). Wikipedia (`zh`, then `en` by default) is only asked when
Douban has no matching result — useful for historical figures like 曹操. Douban
images require a douban.com Referer, which the plugin sends; on desktop it falls back
to Node's HTTP client if Obsidian's request API can't send it.

Keep *Batch: parallel requests* low and the delay at ~1 s — both Douban and
Wikipedia block clients that send requests too quickly.

## How the cover value is formatted

Obsidian embeds an image as `![[image.png]]`. Bases displays a card cover from a
**link** property, so this plugin stores `[[image.png]]` (the `!` stripped). Toggle
*Write as embed* if you prefer the embed form for in-note rendering.

## Notes

- Requests go directly from your device to the Gemini API using Obsidian's
  `requestUrl` (no CORS issues, no proxy). Your API key is stored locally in the
  vault's plugin data.
- The image model id and the `/v1beta/interactions` endpoint reflect the Gemini
  image API as of mid-2026. If Google changes the model id, just update the
  **Model** field in settings.

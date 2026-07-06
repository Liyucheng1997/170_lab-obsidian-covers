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

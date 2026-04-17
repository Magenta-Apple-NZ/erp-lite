# Business Hub

A local browser-based business dashboard — one page to access all your spreadsheets, accounting links, compliance portals, and tools.

## Setup

1. Open a terminal and navigate to this folder
2. Run: `python3 -m http.server 8000`
3. Open `http://localhost:8000` in Chrome or Edge

**Why a local server?** Chrome blocks `file://` links when a page is loaded over `http://`. If you open `index.html` directly via `file://`, local file/folder links will work natively. When using the local server, use the "Copy path" button next to file items to grab the path.

## Configuration

Edit `config.json` to manage all content. No code changes needed.

### Item types

| Type     | Opens                            | Example field |
|----------|----------------------------------|---------------|
| `link`   | URL in a new browser tab         | `"url": "https://..."` |
| `file`   | Local file (spreadsheet, doc)    | `"path": "/Users/..."` |
| `folder` | Local folder in Finder           | `"path": "/Users/..."` |

### Pinned items

Add a `"pinned"` array at the top level of `config.json` for your most-used items. These appear as quick-access buttons above the groups.

### Seasonal tags

Tag items with a `"season"` field using three-letter month abbreviations:

```json
"season": "oct-mar"
```

- Items in season are shown normally with a green "In season" badge
- Off-season items are dimmed with a grey badge
- Wraps around the year boundary (e.g., `oct-mar` = October through March)

### Collapse/expand

Click any group header to collapse or expand it. State is saved in your browser.

### Reload

Click the ↻ button in the header to reload `config.json` without refreshing the page.

## File paths

- Use absolute paths (e.g., `/Users/amcleod/Documents/...`)
- Paths with spaces work fine
- iCloud Drive paths look like: `/Users/amcleod/Library/Mobile Documents/com~apple~CloudDocs/...`

# Manifest Notes (dom-scout)

In Plasmo, there is no manifest.json — all manifest config lives in package.json under the "manifest" key.
Plasmo auto-generates the full Chrome manifest at build time.

## Permissions

- "storage"    → Save/Read data locally
- "scripting"  → Inject JS into pages programmatically
- "sidePanel"  → Unlock the Chrome side panel API
- "webRequest" → Track main-frame redirects for the redirect trace

## host_permissions

- "<all_urls>" → Allows the extension to run on every website, not just specific domains

## action: {}

Registers the toolbar icon. Empty object means no default popup —
clicking the icon fires onClicked in background.ts instead, which opens the side panel.

## side_panel

Tells Chrome which HTML file to load when the side panel opens.
Plasmo auto-generates sidepanel.html from src/sidepanel.tsx.

## background (auto-detected by Plasmo)

Plasmo detects src/background.ts and registers it as the service worker automatically.
It runs in the background, not tied to any page.

## content_scripts (auto-detected by Plasmo)

Plasmo detects src/content.tsx and its exported `config` object:
  export const config: PlasmoCSConfig = {
    matches: ["<all_urls>"],
    run_at: "document_start"
  }
Auto-injects into every page at document_start — the earliest possible moment,
before the DOM is even built. Critical so the tracker gets in before any page scripts run.

## web_accessible_resources

tracker.js is listed here so content.tsx can inject it with chrome.runtime.getURL().
Chrome requires this declaration before a web page can load the extension asset.

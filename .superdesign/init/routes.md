# Routes

This project is not using a browser SPA router or a framework router.

## Entry points

- Desktop app renderer: `renderer/chat.html`
  - Purpose: Main application UI shown inside Electron
  - Layout: Sidebar + content canvas + modal stack

- Marketing site: `web/index.html`
  - Purpose: Public landing page / product marketing
  - Layout: Single long-scroll page with anchored sections

## URL-like sections on marketing site

- `#features`
- `#screenshots`
- `#why`
- `#install`

## Router config

No dedicated router config file exists in the repository.

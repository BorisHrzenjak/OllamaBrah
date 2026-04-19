# Components

This repository does not currently expose a reusable shared UI component library in a conventional `components/` or `ui/` directory.

## Observed state

- Main desktop UI is implemented inline in `renderer/chat.html`
- Marketing site is implemented as static HTML/CSS in `web/index.html` and `web/style.css`
- Reusable visual primitives such as buttons, cards, tabs, modals, and settings rows are defined as CSS classes inside the monolithic renderer file instead of isolated component files

## Implication for SuperDesign

Treat the following as the current primitive source of truth:

- `renderer/chat.html`
- `web/style.css`
- `web/index.html`

There are no standalone shared primitives to extract from source yet.

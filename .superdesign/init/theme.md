# Theme

## Desktop App Theme Source

- File: `renderer/chat.html`

### Base token system

```css
:root {
  --bg-primary: #0a0a0a;
  --bg-secondary: #141414;
  --bg-tertiary: #1f1f1f;
  --bg-quaternary: #2a2a2a;
  --text-primary: #fafafa;
  --text-secondary: #a3a3a3;
  --text-muted: #737373;
  --accent: #f5a623;
  --accent-hover: #e8971a;
  --accent-subtle: rgba(245, 166, 35, 0.1);
  --border: #262626;
  --border-subtle: #1f1f1f;
}
```

### Typography

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
```

```css
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}
```

### Theme model

The renderer ships many preset palette overrides directly inside `renderer/chat.html`, including:

- `dracula`
- `tokyo-night`
- `github-light`
- `solarized-light`
- `catppuccin-latte`
- `catppuccin-mocha`
- `kanagawa`
- `rose-pine`
- `nord`
- `night-owl`
- `one-dark-pro`
- `kanagawa-lotus`
- `rose-pine-dawn`
- `nord-light`
- `night-owl-light`
- `one-light`

## Marketing Site Theme Source

- File: `web/style.css`

### Base token system

```css
:root {
  --bg: #0b0c0e;
  --surface: #13151a;
  --surface-2: #1a1d24;
  --border: #242830;
  --text: #e4e0d8;
  --text-dim: #7a8090;
  --text-dimmer: #454c58;
  --amber: #d97f3a;
  --green: #4a8c5c;
  --code: #8fa3b8;
  --font-serif: 'DM Serif Display', Georgia, serif;
  --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Cascadia Code', monospace;
}
```

### Visual character

- Dark editorial / terminal hybrid
- Warm amber accent
- Serif display headlines + utilitarian mono labels
- Sharper, more authored brand point of view than the app UI

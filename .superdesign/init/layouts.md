# Layouts

## Desktop App Shell

- File: `renderer/chat.html`
- Description: Single-file Electron renderer containing the entire application shell, including sidebar, top bar, chat surface, modals, dashboard, settings, memory manager, and theme selector.

### Key layout structure

```html
<div id="appContainer">
  <aside id="conversationSidebar">...</aside>
  <main id="mainContent">...</main>
</div>

<div id="settingsModal" class="modal">...</div>
<div id="dashboardModal" class="modal">...</div>
<div id="llmfitModal" class="modal">...</div>
<div id="memoryModal">...</div>
```

### Key layout styling anchors

```css
#conversationSidebar {
  width: 260px;
  min-width: 260px;
  background-color: var(--bg-secondary);
  border-right: 1px solid var(--border-subtle);
}

.modal-content {
  background-color: var(--bg-secondary);
}

.settings-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
}
```

## Marketing Site Layout

- Files: `web/index.html`, `web/style.css`
- Description: Static landing page with fixed nav, editorial hero, value strip, feature grids, screenshots, comparison table, install steps, and CTA/footer.

### Key layout structure

```html
<nav id="nav">...</nav>
<section id="hero">...</section>
<section id="features" class="section">...</section>
<section id="screenshots" class="section">...</section>
<section id="install" class="section">...</section>
<section id="cta" class="section">...</section>
```

### Key layout styling anchors

```css
.hero-inner {
  display: grid;
  grid-template-columns: 1fr 1.1fr;
  gap: 64px;
}

.diff-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.screenshots-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}
```

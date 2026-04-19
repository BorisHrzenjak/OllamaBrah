# Extractable Components

## ConversationSidebar

- Source: `renderer/chat.html`
- Category: layout
- Description: Left rail for new chat, search, conversation list, and dashboard entry
- Extractable props: `activeConversationId` (string, default: ""), `showRuns` (boolean, default: false)
- Hardcoded: layout width, button labels, icon set, base spacing, list treatment

## AppTopBar

- Source: `renderer/chat.html`
- Category: layout
- Description: Top application bar with product name, model status, and utility icons
- Extractable props: `modelName` (string, default: "gpt-oss:latest"), `status` (string, default: "ready")
- Hardcoded: product wordmark placement, icon treatment, base chrome styling

## SettingsModal

- Source: `renderer/chat.html`
- Category: layout
- Description: Two-column settings shell with left nav and right content panel
- Extractable props: `activeSection` (string, default: "appearance")
- Hardcoded: section labels, icon names, modal frame, footer actions

## DashboardCards

- Source: `renderer/chat.html`
- Category: basic
- Description: Metric card grid used inside the usage dashboard modal
- Extractable props: `title` (string, default: "Metric"), `value` (string, default: "0")
- Hardcoded: card shape, icon treatment, card spacing, text hierarchy

## MarketingHero

- Source: `web/index.html`
- Category: layout
- Description: Landing page hero with editorial headline, product framing, and app screenshot
- Extractable props: none recommended
- Hardcoded: typography pairing, CTA copy, screenshot framing, dark amber theme

# Homepage Plan

## Project Goal

Turn `https://ollama-bro.vercel.app/` into a landing site that clearly answers:

- What is OllamaBrah?
- Who is it for?
- Why use it instead of OpenWebUI or AnythingLLM?
- Why is it better for a specific kind of user?
- How do I install it quickly?

Primary conversion:

- GitHub stars
- Release downloads
- Installer clicks

Secondary conversion:

- Docs reads
- GitHub repo visits
- Issue/discussion engagement

## Target Audience

The site should target this user first:

- Windows users
- Solo users, not teams
- Local AI users running `Ollama` or `llama.cpp`
- Privacy-sensitive users
- People who want an app, not a self-hosted platform
- People working with files, screenshots, PDFs, voice, and local model control

Do not optimize the messaging for:

- Enterprises
- Multi-user teams
- Kubernetes or Docker admins
- Browser or mobile-first users
- "Any provider / any deployment / any scale" buyers

## Positioning Strategy

Core positioning:

`OllamaBrah is a desktop-native local AI workbench for Ollama and llama.cpp users who want private chat, OCR, memory, voice, and safe local agents without running a whole web platform.`

What the site should communicate in one screen:

- Local-first
- Desktop-native
- Private
- Powerful with files and GGUFs
- Built for solo users
- Simpler than platform products

Competitive frame:

Do not say:

- Better than OpenWebUI at everything
- All-in-one AI platform

Do say:

- Better fit for personal desktop local AI
- Less setup and less platform overhead
- Focused on local model workflows, files, voice, and controlled agenting

## What To Change From The Current Site

Current site strengths to keep:

- Visual demo feel
- Direct feature explanations
- Screenshot-driven credibility
- Privacy and open-source tone
- Simple CTA structure

Current site problems:

- Old product name
- Still framed as Chrome extension
- Hero is too old-product-specific
- Homepage is too long and documentation-heavy
- Installation flow is obsolete for the desktop app
- Value prop does not separate the app from bigger competitors
- No focused "who this is for" positioning
- No "why this instead of platform products" explanation

Main structural change:

Split the site into:

- A tighter landing page
- A proper install page
- A docs page or docs section
- Optional comparison page later

The homepage should sell.
The docs should explain.

## Recommended Site Architecture

Top nav:

- Features
- Screenshots
- Why OllamaBrah
- Install
- Docs
- GitHub

Optional:

- Compare

Primary pages or sections:

1. Home
2. Install
3. Docs
4. GitHub outbound

Optional later:

5. Compare
6. Changelog

## Homepage Structure

### 1. Hero

Goal:

- Instantly reposition from browser extension to desktop app
- Establish audience and product type

Content:

- Eyebrow:
  `Desktop App · Local AI · Open Source`
- Headline:
  `The desktop AI workbench for Ollama and llama.cpp users.`
- Subhead:
  `Chat with local models, understand PDFs and screenshots, use voice, memory, and safe local agents, all in a native desktop app without Docker or browser-tab sprawl.`
- Primary CTA:
  `Download for Windows`
- Secondary CTA:
  `View on GitHub`
- Tertiary text:
  `Private by default · Runs local-first · No account required`

Visual:

- Use a polished desktop window mockup, not extension chrome
- Show actual app UI with sidebar, model switcher, attachments, and a visible `llama.cpp` or memory or agent state

Replace current hero messaging entirely.

### 2. Fast Value Strip

Goal:

- Summarize the product in 4 fast bullets

Suggested items:

- `Ollama + llama.cpp`
- `OCR + file chat`
- `Voice + memory`
- `Safe local agents`

Keep this short and scannable.

### 3. Why It Exists

Goal:

- Explain the product category clearly

Copy direction:

- People want local AI
- Many options feel like self-hosted platforms
- OllamaBrah is for people who want a serious local AI assistant as a desktop app

Example themes:

- An app, not a stack
- Local-model control without infrastructure overhead
- Built for one person at one machine

### 4. Core Differentiators

Goal:

- Explain why this app exists versus bigger products

Use 4 to 6 cards.

Recommended cards:

- **Native desktop workflow**
  `Use a real app instead of managing a browser-based AI platform.`
- **Direct local backend control**
  `Built around Ollama and direct llama.cpp / GGUF workflows.`
- **Real file understanding**
  `Chat with PDFs, screenshots, scanned docs, and code files with OCR and chunked context injection.`
- **Safe agent mode**
  `Tool permissions, allowed directories, and blocked paths keep local automation controlled.`
- **Personal memory and voice**
  `Persistent semantic memory plus voice input and local TTS.`
- **Focused solo-user design**
  `No team-admin clutter. Just your models, your files, your machine.`

This is one of the most important sections.

### 5. Feature Showcase

Goal:

- Preserve the current feature-rich feel, but organize around real workflows instead of a long flat list

Recommended grouping:

- **Models and Runtime**
  `Ollama, llama.cpp, GGUF profiles, GPU layers, context control, model management`
- **Chat and Conversations**
  `Streaming, regenerate history, forks, tags, pinned messages, export`
- **Files and OCR**
  `PDFs, images, scanned documents, relevant chunk injection`
- **Research and Agents**
  `Web search, deep research, agent mode, safe permissions`
- **Memory and Voice**
  `Semantic memory, voice input, Kokoro TTS`
- **Customization**
  `Personas, slash commands, themes, per-model settings`

This should replace the current "10 feature cards" section with a stronger, grouped structure.

### 6. Screenshots

Goal:

- Keep proof, but curate more intentionally

Current screenshots are valuable. Keep the gallery, but reorder around the new positioning.

Recommended order:

1. Main chat interface
2. `llama.cpp` or model management
3. File attachments or OCR flow
4. Memory manager
5. Agent mode
6. Deep research
7. Kokoro or voice settings
8. Dashboard or stats

Each screenshot caption should describe user value, not just UI.

Example:

- Bad: `Settings`
- Better: `Tune per-model parameters, memory, voice, and local runtimes from one place`

### 7. Why Use This Instead Of Platform Tools

Goal:

- Answer the exact user question without sounding insecure

Format:

3-column comparison.

Columns:

- `OllamaBrah`
- `AnythingLLM`
- `OpenWebUI`

Rows:

- Product shape
- Best fit
- Installation overhead
- Team and admin features
- Desktop-native feel
- Direct local runtime focus
- File and OCR workflows
- Personal use simplicity

Tone:

- Factual, not combative

This section can be brief on homepage and later expanded into dedicated comparison pages.

### 8. Who It's For

Goal:

- Make the niche feel intentional, not like a limitation

Suggested personas:

- **Local LLM power users**
- **Developers working with code and docs**
- **Privacy-sensitive solo professionals**
- **Researchers with PDFs, screenshots, and notes**
- **GGUF and llama.cpp tinkerers**

Also include:

**Not ideal for**

- Multi-user teams
- Enterprise admin workflows
- Browser or mobile-first deployments

This increases credibility.

### 9. Privacy and Open Source

Goal:

- Retain a strong trust section from the current site

Keep and modernize:

- Local-first
- Open source
- No account required
- Inspectable code
- Your files stay with you

Remove old extension-specific technical framing unless it still applies.

New framing should reference:

- Desktop app
- Local proxy where relevant
- Local backends
- Optional API-based search features explained clearly

### 10. Install

Goal:

- Replace the old extension install flow with a simple app-install flow

Keep this lightweight on homepage:

- Download installer
- Install Ollama
- Optionally configure `llama.cpp`
- Launch and choose backend
- Start chatting

Then link to full install docs.

This section should feel much simpler than the current long `proxy server + load unpacked extension` instructions.

### 11. Final CTA

Goal:

- Close cleanly

Suggested CTA:

- Headline:
  `Run private local AI like an app, not a deployment project.`
- Buttons:
  `Download for Windows`
  `Star on GitHub`

Small note:

`Built for Ollama and llama.cpp users who want real desktop workflows.`

## Content Strategy

Homepage tone:

- Practical
- Confident
- Specific
- No hypey "AI for everyone" language

Key phrases to use:

- Desktop-native
- Local AI workbench
- Private by default
- Ollama and llama.cpp
- GGUF models
- OCR and file chat
- Safe local agents
- Solo-user focused

Key phrases to avoid:

- All-in-one AI platform
- Enterprise-ready
- Collaborative workspace
- Multi-tenant
- Cloud-native
- AI for your entire team

## Copy Plan

New headline options:

- `The desktop AI workbench for Ollama and llama.cpp users`
- `Private local AI, minus the self-hosting headache`
- `A native desktop app for serious local AI workflows`

Subhead options:

- `Use local models, files, OCR, memory, voice, and controlled local agents in one desktop app.`
- `Built for solo users who want an app, not a browser-based AI platform.`

Differentiation sentence:

- `OllamaBrah is not trying to be the biggest AI platform. It is built to be the best personal desktop app for local-model users.`

## UX Plan

What to keep from current UX:

- Dark visual direction
- Clear nav
- Screenshot-led product storytelling
- Strong spacing and product-card rhythm

What to improve:

- Reduce homepage text density
- Move most long-form docs off homepage
- Strengthen hierarchy between sections
- Make CTAs download-focused
- Make screenshots support the story instead of acting like a giant gallery dump
- Add stronger scannability for comparison and use-case sections

Mobile:

Ensure:

- Hero copy wraps cleanly
- Screenshot cards stay readable
- Comparison section stacks gracefully
- Install steps remain short and tappable

## Visual Direction

Do not make this look like generic SaaS.

Visual direction should signal:

- Developer or power-user tool
- Desktop software
- Local hardware and model tinkering
- Modern but slightly opinionated

Recommended cues:

- Terminal-adjacent but polished
- Stronger desktop app window framing
- Subtle model and runtime badges
- Visible backend states
- Use real UI screenshots, not abstract AI blobs

Preserve the current dark aesthetic, but upgrade the identity around:

- `desktop`
- `local runtime`
- `file-aware assistant`
- `serious utility`

## Asset Plan

You likely need these assets for the revised site.

Must have:

- Updated app logo or wordmark: `OllamaBrah`
- Updated hero screenshot
- 6 to 8 curated screenshots
- Windows installer CTA asset or release link
- GitHub link

Should have:

- One annotated screenshot showing `attachments + memory + model + agent`
- One screenshot focused on `llama.cpp` model profile or runtime controls
- One screenshot focused on OCR or file handling
- One screenshot focused on agent permissions

Optional:

- Short looping app demo GIF or video
- Tiny icons for local, OCR, memory, voice, agents, and `llama.cpp`

## Migration Plan From Current Site

Remove or rewrite:

- `Local AI, right in Chrome`
- All `Chrome extension` references
- `Load unpacked extension`
- `Chrome` as prerequisite
- Extension-specific wording like browser sandbox if no longer central
- Current old GitHub destination if needed
- Docs sections that belong in product docs, not homepage

Keep and adapt:

- Features section
- Screenshots section
- About and privacy section
- Docs section, but shorten and link out
- Final CTA structure

## Implementation Phases

### Phase 1: Messaging Rewrite

- Rename all branding to `OllamaBrah`
- Rewrite hero
- Rewrite nav labels
- Rewrite install messaging
- Rewrite about section
- Add "Why OllamaBrah" section

### Phase 2: Structural Cleanup

- Shorten homepage docs
- Move detailed install and docs content off homepage or collapse it heavily
- Reorganize features into grouped workflow sections
- Insert comparison section
- Insert "who it's for" section

### Phase 3: Visual and Content Polish

- Update screenshots and captions
- Improve CTAs
- Add cleaner product-value strip
- Tune mobile layout
- Add comparison styling and install emphasis

### Phase 4: SEO and Discoverability

- Update page title
- Update meta description
- Add keywords around:
  - `Ollama desktop app`
  - `llama.cpp desktop UI`
  - `local AI app Windows`
  - `AnythingLLM alternative`
  - `OpenWebUI alternative for desktop`

## Suggested Sitemap Copy

Nav:

- Features
- Screenshots
- Why OllamaBrah
- Install
- Docs
- GitHub

Footer:

- Features
- Install
- Docs
- GitHub
- Releases
- License

## Success Criteria

The revised homepage should make a new visitor understand in under 15 seconds:

- This is a desktop app
- This is for local AI
- This is for Ollama or llama.cpp users
- This is for solo desktop workflows
- This is different from platform tools
- I can download it now

If a visitor leaves thinking "this is another general-purpose AI web UI," the site failed.

## Final Recommendation

The highest-leverage change is this:

Stop treating the homepage as a giant feature manual.
Treat it as a focused argument for why a desktop-native local AI app deserves to exist.

That is the niche.

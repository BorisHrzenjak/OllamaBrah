---
name: web-extractor
description: Fetch URLs, extract clean content, optionally save locally.
builtin: true
---

# Web Extractor Skill

You are in web extraction mode. You fetch web pages and extract clean, readable content.

## Process

### Single URL
1. Call `fetchPage` on the URL
2. Strip navigation, ads, footers, and boilerplate — keep only the main article or content body
3. Present the extracted content in clean markdown

### Multiple URLs
Process URLs in sequence:
1. Call `fetchPage` on each URL one at a time
2. Extract the main content from each
3. After all URLs are processed, produce a combined summary that:
   - Identifies common themes across sources
   - Highlights unique information from each source
   - Notes any contradictions between sources

### Save locally
If the user wants to save the extracted content:
1. Determine the target file path (ask the user if not specified)
2. Use `writeFile` to save the clean markdown version to that path
3. Confirm the file was written successfully

## Extraction Guidelines
- Remove: navigation menus, cookie banners, ads, social share buttons, comment sections, related articles
- Keep: article title, author/date if present, main body text, code blocks, tables, key images (described in text)
- Preserve: headings, bullet points, numbered lists, and code formatting in markdown
- If a page requires JavaScript to render and shows little content, note this to the user

## Output Format
- Start with the page title and URL
- Follow with the clean extracted content
- End with a one-line summary of what the page is about

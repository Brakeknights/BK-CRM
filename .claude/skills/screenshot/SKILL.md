---
description: Take a screenshot of any page or section of the Brakeknights site
---

# Screenshot Skill

Use this skill any time the user asks to see a screenshot of the site or a specific page/section.

## Command

```bash
node scripts/screenshot.js [path] [selector] [output]
```

| Argument   | Default               | Description                                      |
|------------|-----------------------|--------------------------------------------------|
| `path`     | `/`                   | URL path to visit                                |
| `selector` | *(none)*              | CSS selector to scroll to before screenshotting  |
| `output`   | `/tmp/screenshot.png` | Where to save the file                           |

- If `selector` is omitted, a full-page screenshot is taken.
- If `selector` is provided, the page scrolls to that element using `offsetTop` and takes a viewport screenshot.

## Examples

```bash
# Full homepage
node scripts/screenshot.js /

# Homepage scrolled to the contact form
node scripts/screenshot.js / '#contact'

# Contact page, full page
node scripts/screenshot.js /contact

# Service page scrolled to a specific section
node scripts/screenshot.js /brake-pad-rotor-replacement '#hero'

# Custom output path
node scripts/screenshot.js / '#contact' /tmp/contact-form.png
```

## After taking the screenshot

Send it to the user with:
```
SendUserFile({ files: ["/tmp/screenshot.png"], status: "normal" })
```

## Notes

- The script starts its own server and shuts it down after — no need to start one manually.
- Always uses `offsetTop` for scrolling (never `getBoundingClientRect`), per CLAUDE.md.
- Server must not require env vars to start (SMTP_PASS absence is fine — emails just won't send).

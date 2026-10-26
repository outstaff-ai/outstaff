---
title: DiceBear (avatars)
description: Deterministic avatars per person, rendered locally, with directory and URL sources.
---

The `dicebear` avatars adapter (`@outstaff/integration.avatars.dicebear`) gives every person a stable, good-looking avatar. It renders locally with [DiceBear](https://www.dicebear.com) (`@dicebear/core` and `@dicebear/collection`, exact pins), so it makes no network calls. The same seed, style and options always give the same SVG. Capability: `avatars.generate`.

```yaml
integrations:
  avatars:
    adapter: dicebear
    style: notionists # default
    background: [b6e3f4, c0aede] # optional, hex colors
    size: 256 # optional, pixels
```

The seed is the person's handle. Set `people[].avatar.seed` to get a different avatar without renaming the person.

Output is SVG only. PNG would need a rasterizer, and the pure-JS options are either large or ship native binaries per platform, which would complicate the container images. Chat and tracker profile uploads accept SVG poorly in places, so a host that needs PNG can convert it. Avatars are uploaded to chat and tracker profiles when you run `ost hire` or `ost setup`.

## Styles and licenses

The default, `notionists`, is CC0: no attribution needed. Some styles are CC BY 4.0 or carry their own terms; if you pick one, credit the creator where the avatars are shown. Licenses below come from the styles' own metadata.

| Style                | License                              | Creator                 | Attribution needed |
| -------------------- | ------------------------------------ | ----------------------- | ------------------ |
| `adventurer`         | CC BY 4.0                            | Lisa Wischofsky         | yes                |
| `adventurer-neutral` | CC BY 4.0                            | Lisa Wischofsky         | yes                |
| `avataaars`          | Free for personal and commercial use | Pablo Stanley           | yes                |
| `avataaars-neutral`  | Free for personal and commercial use | Pablo Stanley           | yes                |
| `big-ears`           | CC BY 4.0                            | The Visual Team         | yes                |
| `big-ears-neutral`   | CC BY 4.0                            | The Visual Team         | yes                |
| `big-smile`          | CC BY 4.0                            | Ashley Seo              | yes                |
| `bottts`             | Free for personal and commercial use | Pablo Stanley           | yes                |
| `bottts-neutral`     | Free for personal and commercial use | Pablo Stanley           | yes                |
| `croodles`           | CC BY 4.0                            | vijay verma             | yes                |
| `croodles-neutral`   | CC BY 4.0                            | vijay verma             | yes                |
| `dylan`              | CC BY 4.0                            | Natalia Spivak          | yes                |
| `fun-emoji`          | CC BY 4.0                            | Davis Uche              | yes                |
| `glass`              | CC0 1.0                              | DiceBear                | no                 |
| `icons`              | MIT                                  | The Bootstrap Authors   | no                 |
| `identicon`          | CC0 1.0                              | DiceBear                | no                 |
| `initials`           | CC0 1.0                              | DiceBear                | no                 |
| `lorelei`            | CC0 1.0                              | Lisa Wischofsky         | no                 |
| `lorelei-neutral`    | CC0 1.0                              | Lisa Wischofsky         | no                 |
| `micah`              | CC BY 4.0                            | Micah Lanier            | yes                |
| `miniavs`            | CC BY 4.0                            | Webpixels               | yes                |
| `notionists`         | CC0 1.0                              | Zoish                   | no                 |
| `notionists-neutral` | CC0 1.0                              | Zoish                   | no                 |
| `open-peeps`         | CC0 1.0                              | Pablo Stanley           | no                 |
| `personas`           | CC BY 4.0                            | Draftbit - draftbit.com | yes                |
| `pixel-art`          | CC0 1.0                              | DiceBear                | no                 |
| `pixel-art-neutral`  | CC0 1.0                              | DiceBear                | no                 |
| `rings`              | CC0 1.0                              | DiceBear                | no                 |
| `shapes`             | CC0 1.0                              | DiceBear                | no                 |
| `thumbs`             | CC0 1.0                              | DiceBear                | no                 |
| `toon-head`          | CC BY 4.0                            | Johan Melin             | yes                |

`style` must be one of the names above; anything else fails config validation.

## Directory and URL sources

Two small adapters in the same package, for avatars you already have.

```yaml
integrations:
  avatars:
    adapter: directory
    path: .outstaff/avatars # reads <handle>.png, then <handle>.svg
```

```yaml
integrations:
  avatars:
    adapter: url
    template: https://assets.acme.example/avatars/{seed}.png
```

Both serve the image as it is (PNG or SVG) and ignore `size`. A missing file or a 404 is a `not_found` error. For a single person, set `people[].avatar.url` instead; the host uses it directly and no adapter is involved.

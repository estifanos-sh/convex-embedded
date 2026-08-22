# convex-embedded documentation

This directory owns the content for
[estifanos.sh/convex-embedded](https://estifanos.sh/convex-embedded/).

- `docs.json` defines product metadata, home-page links, and sidebar navigation.
- `content/**/*.md` contains the documentation pages. For example,
  `content/concepts/replication.md` serves `/concepts/replication`.
- Each page uses YAML frontmatter for its `title` and `description`. Do not
  repeat that title as a leading Markdown H1.
- Content must be clean, framework-independent Markdown. Do not add Svelte,
  Astro, React, `<svelte:head>`, `<script>` preludes, components, or other
  framework markup.

The shared renderer, Markdown compiler, Pagefind integration, `llms.txt` generation, and production
deployment belong to `estifanos-sh/estifanos-sh`. This repository contains no documentation
application or hosting credentials.

## Documentation content

- `docs.json` is the declarative site and navigation configuration.
- `content/**/*.md` is the canonical documentation source. A page at
  `content/concepts/replication.md` has the slug `/concepts/replication`.
- Every page starts with YAML frontmatter containing its `title` and
  `description`. Frontmatter is the only source for a page title and
  description; do not add a duplicate leading Markdown H1.
- Write framework-independent Markdown only. Do not add Svelte, Astro, React,
  HTML head blocks, script preludes, components, or framework-specific syntax.
- Keep every content page in the configured sidebar.
- Documentation framework code, generated files, search indexing, and deployment live in
  `estifanos-sh/estifanos-sh`.
- Do not add a package manifest, application code, generated output, or deployment credentials here.

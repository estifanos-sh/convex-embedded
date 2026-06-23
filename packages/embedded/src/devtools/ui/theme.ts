/// <reference lib="dom" />

/**
 * Convex-dashboard inspired token shim for the embedded devtools.
 *
 * The real dashboard pulls these values from the shared design-system package.
 * Embedded keeps a small local shim so devtools stay dependency-light and work
 * inside package consumers without importing the full dashboard stack.
 *
 * @internal
 */
export const themeText = `
.ce-root{
  --ce-font-sans:"GT America","Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --ce-font-mono:"Berkeley Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --ce-background-primary:#111111;
  --ce-background-secondary:#171717;
  --ce-background-tertiary:#202020;
  --ce-background-raised:#262626;
  --ce-background-overlay:#0b0b0c;
  --ce-background-accent:#5b5bd6;
  --ce-background-accent-secondary:#25254a;
  --ce-background-success-secondary:#132818;
  --ce-background-warning-secondary:#332611;
  --ce-background-error-secondary:#351718;
  --ce-foreground-primary:#f5f5f5;
  --ce-foreground-secondary:#c8c8c8;
  --ce-foreground-muted:#8f8f8f;
  --ce-foreground-disabled:#676767;
  --ce-foreground-accent:#8b8cff;
  --ce-foreground-success:#4ade80;
  --ce-foreground-warning:#fbbf24;
  --ce-foreground-error:#ff6b6b;
  --ce-border-primary:#303030;
  --ce-border-secondary:#242424;
  --ce-border-selected:#7474ff;
  --ce-border-error:#ef4444;
  --ce-row-hover:#1d1d1d;
  --ce-row-selected:#292943;
  --ce-input-background:#121212;
  --ce-shadow:0 18px 46px rgba(0,0,0,.35);
}
`;

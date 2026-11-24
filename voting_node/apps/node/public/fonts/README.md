# Voter UI fonts

Self-hosted so the voter pages make no request to a font CDN (the CSP is `font-src 'self'`).
Latin subsets only; other scripts fall back to the system UI font in `--font-sans`.

- DM Sans (variable weight, normal and italic) — Copyright 2014 The DM Sans Project Authors
  (https://github.com/googlefonts/dm-fonts)
- Source Code Pro (variable weight) — Copyright 2010, 2012 Adobe Systems Incorporated
  (http://www.adobe.com/), with Reserved Font Name 'Source'

Both are licensed under the SIL Open Font License 1.1 (`OFL.txt`). A fork can swap faces by
replacing these files and the `@font-face` rules at the top of `voter-theme.css`.

# Vendored OpenCC JavaScript

This directory includes the unchanged `dist/esm/cn2t.js` browser module from
**opencc-js 1.4.2**, published by The nk2028 Project. Only this module is shipped;
there is no runtime package download, CDN request or additional dependency.

- Official repository: https://github.com/nk2028/opencc-js
- Package: https://www.npmjs.com/package/opencc-js/v/1.4.2
- Source archive: https://registry.npmjs.org/opencc-js/-/opencc-js-1.4.2.tgz
- Verified npm archive integrity (SHA-512):
  `sha512-EdcspgdROiCCZDM+jZR6Pa670xW+EW2QhctPBQ8gRjg6lrx4IHEl+2s+kt5izk/TkxVRgdWuFgaGkaEdIUfdaw==`

`taiwan-text.js` uses `Converter({ from: 'cn', to: 'twp' })` to normalize Simplified
Chinese spelling and dictionary phrases to Taiwan Traditional Chinese. For
already-Traditional clauses it uses `Converter({ from: 't', to: 'twp' })` to avoid
reapplying Simplified ambiguity rules. Its wrapper preserves code, URLs, email
addresses and common technical literals. Dictionary
conversion cannot resolve every semantic distinction (for example physical mass
versus service quality); the translation prompt must supply that context.

The upstream MIT license, Apache-2.0 license and third-party notices are included
unchanged in `LICENSE`, `LICENSES/Apache-2.0.txt` and `THIRD_PARTY_LICENSES.md`.

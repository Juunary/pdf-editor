# Chrome Web Store listing material (draft)

Scope: `docs/m5-contract.md` D2. This folder covers the listing material drafts only. Developer account registration, payment, submission and review handling are done by the user.

| Document | Contents |
| --- | --- |
| [listing.md](listing.md) | Name, summary (132 characters or fewer), detailed description (Korean and English), category |
| [practices.md](practices.md) | Single purpose, justification for each permission (D7 Web Store build), remote code, data use certification |
| [privacy-policy.md](privacy-policy.md) | Privacy policy (no data collection, local processing) |
| [assets.md](assets.md) | Shot list for 1280×800 screenshots and the 440×280 promo tile, icons, wording that needs user confirmation |

Baseline: the Web Store build requires Chrome 151 or later and omits the DNR permission, host permissions and `<all_urls>` web-accessible resources (D7 (a), user decision 2026-10-21). Manifest values are checked against the S3 build output right before submission.

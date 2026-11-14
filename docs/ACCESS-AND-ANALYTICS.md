# Visitor access and analytics (CH-20, CH-21)

## Passcode gate (CH-20)

The hosted demo opens on a four-digit passcode page. It is a convenience gate for a portfolio demo, not strong authentication: four digits are only 10,000 combinations. It is separate from the demo identity switch in the header, which is not authentication either.

| Setting | Where | Notes |
|---|---|---|
| `ACCESS_PIN` | panel secret | Exactly four digits. Never a `VITE_` variable; the browser never receives it. |
| `ACCESS_SESSION_SECRET` | panel secret | At least 32 random characters. Changing it ends every visitor session. |
| `ACCESS_SESSION_MINUTES` | panel variable | Default 120 (allowed 5 to 1440). |
| `TRUST_PROXY` | panel variable | Set to `1` only when exactly one reverse proxy (the panel's) sits in front. Unset trusts no forwarded headers. |
| `ACCESS_GATE=on` | local only | Turns the gate on outside production for trying it locally. In production the gate is always on; `ACCESS_GATE=off` or `ACCESS_COOKIE_SECURE=false` stops the start. |

Coolify aliases (same meaning): `SOC_ACCESS_PIN`, `SOC_ACCESS_SESSION_SECRET` (also `SOC_SESSION_SECRET`), `SOC_SESSION_MINUTES`, `SOC_TRUST_PROXY` (`true` means one proxy), `SOC_ACCESS_GATE=true`, `SOC_ALLOW_DEMO_RESET`. `SOC_ALLOW_DEMO_RESET=false` keeps `POST /api/lab/reset` disabled in production. The Clarity ID can come from `SOC_CLARITY_PROJECT_ID` or `VITE_CLARITY_PROJECT_ID` (read server-side via `/api/session`, never via Vite injection).

How it works:

- The server checks the PIN (constant-time compare) and sets a cookie signed with HMAC-SHA256: `HttpOnly`, `SameSite=Lax`, `Secure` in production, expiring after the session length.
- Without a valid cookie, every page returns the passcode page (status 401), every `/api` route returns `401 ACCESS_REQUIRED`, and `/assets/*` returns 401, so the app bundle is not served. Open without a cookie: `/api/health`, `/api/ready`, `/api/access/status`, `/api/access/login`, `/api/access/logout`. `/sim/*` is not covered by the cookie; those routes need the per-process service tokens, and only the server itself holds them.
- Deep links: the passcode page is served at the address the visitor asked for, and a successful entry reloads that address. The app has no path routes, so any address opens the app shell.
- Wrong or malformed passcodes all get the same message. After three failures from one address the next attempt waits 2 seconds, then 4, 8 and so on, up to 15 minutes. Across all addresses, 30 failures in 10 minutes pause logins for everyone for the rest of that window. That global pause can be used to lock visitors out for a while; for a demo that is acceptable and safer than unlimited guessing. The counters are in memory and reset on restart.
- When the session ends, the next API call reloads the page and the passcode page appears. "Leave demo" in the header ends the session at once.
- The PIN and the cookie value are never logged.

Not covered: the passcode page itself is public HTML with no project data. Anyone with the PIN can see everything in the demo, which is all synthetic.

## Analytics (CH-21)

Status: **CONFIGURED**. No Clarity project ID was provided, so analytics is off and the app works as before. The loading rules were tested locally with a made-up ID and a stand-in for clarity.ms; nothing was sent to Microsoft.

To turn it on: copy the project ID from your existing Clarity dashboard (Settings, Overview) and set `CLARITY_PROJECT_ID` in the panel. It is a public identifier, not a secret. Do not create a new project or share account passwords. Outside production it also needs `ANALYTICS_ENABLED=true`, so local runs and tests stay clean.

Rules the code follows:

- The passcode page is plain server HTML with no app bundle, so it cannot load analytics. The ID is only sent inside `/api/session`, which needs a passcode session.
- Inside the app, a short notice asks first. Nothing loads until the visitor selects Allow. "No thanks" is remembered in this browser (local storage); the footer lets the visitor change the choice. Turning it off calls Clarity's consent API with storage denied, then `clarity('consent', false)` (TO_VERIFY: Microsoft marks the v1 call for deprecation and documents no v2 equivalent for erasing cookies), and reloads so the tag is gone.
- On Allow, the tag is added once per page and Clarity is told `ad_Storage: denied, analytics_Storage: granted`.
- Identify: the Clarity session is tagged with the synthetic demo identity (`clarity('identify', userId)`, e.g. which demo role is acting) so sessions can be segmented in the dashboard. Only the opaque demo user ID is sent — never display names, record IDs, or free text. Switching identities re-tags the session.
- Events, with no data attached: `project_entered`, `record_opened`, `scenario_started`, `scenario_completed`, `audit_export_clicked`. No record IDs, names, roles, free text, passcodes, errors or tokens. The app does not change URLs per screen, so no page-view events are added.
- Masking: `data-clarity-mask="true"` on the whole main content and on the identity selector, so recordings show layout and clicks, not text. Clarity also masks inputs by default.
- The notice is the minimum for a demo. If you expect visitors from places with stricter consent rules, check the requirements that apply to you and Clarity's consent guidance before turning it on.

Sources: [Clarity Consent API v2](https://learn.microsoft.com/en-ca/clarity/clarity-consent-api-v2), [Clarity client API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api).

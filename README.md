# ProXP — PRONOTE alternative PWA

ProXP is the full progressive web app built on top of `PronoteXP-api`.

It keeps the visual language of the original PronoteXP exporter—dark glass, blue mesh, soft borders, compact Manrope typography—but extends it into a complete application shell.

## Current application areas

- Accueil / dashboard
- Emploi du temps
- Notes et moyennes
- Devoirs
- Vie scolaire: absences + retards
- Actualités
- Cantine / menus
- Paramètres / local session management

The navigation is deliberately modular: each section is rendered independently in `app.js`, and all PRONOTE communication is isolated behind the API client.

## Authentication model

### First connection

```text
PRONOTE QR Code + PIN
        ↓
ProXP decodes QR in the browser
        ↓
PronoteXP-api
        ↓
PRONOTE
        ↓
reusable session token
        ↓
IndexedDB on this device
```

The API does not receive a long-term password from subsequent ProXP sessions. ProXP sends the locally stored session object to `POST /v1/data`.

The token is reusable but not guaranteed permanent; PRONOTE/ENT controls its validity.

### Local storage

The session is stored in an IndexedDB object store named `secrets`. It is not put in `localStorage` and it is never uploaded anywhere except when the user explicitly requests PRONOTE data through the API.

For a stronger threat model, a future version can encrypt the local value with a user-derived Web Crypto key.

## API contract

The app uses:

```text
POST /v1/auth/qr-and-export
POST /v1/auth/token
POST /v1/auth/credentials
POST /v1/data
```

The `resources` field of `/v1/data` makes adding future screens straightforward:

```json
{
  "session": {"url":"...","username":"...","token":"...","uuid":"..."},
  "resources": ["profile", "timetable", "homework"]
}
```

## PWA

Included:

- `manifest.webmanifest`
- service worker (`sw.js`)
- install prompt
- cached application shell
- responsive mobile navigation

The PRONOTE API is intentionally not cached.

## Local development

Serve the folder over HTTP because service workers and IndexedDB behavior are origin-bound:

```bash
python -m http.server 5500
```

Then open `http://localhost:5500`.

Edit `config.js` to point at a local API:

```js
window.PROXP_CONFIG = {
  API_URL: "http://127.0.0.1:8000",
  DEBUG: true,
};
```

## GitHub Pages

The repository includes a Pages workflow. Set the production API URL in `config.js` before deploying.

## Scope

ProXP is a frontend application. PRONOTE-specific protocol work belongs exclusively in `PronoteXP-api`.

## License

MIT — Copyright (c) 2026 Pyronixus.

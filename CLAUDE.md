# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` then `npm start` runs `node --env-file-if-exists=.env server.js` and serves on `PORT` (default 3000).
- There is no build, lint, or test tooling. The app needs Node 22+ for built-in `node:sqlite` and `--env-file-if-exists`.
- Quick health check: `curl localhost:3000/session` returns `{"loggedIn":false}`.
- This workspace is an EC2 remote instance, and the checkout at `/opt/smartscan` is the live deployment. `localhost:3000` is served from this directory by the systemd unit, so code changes only take effect after a restart.
- The deployed site is https://smartscan.in (admin at `/admin`). Caddy (`/etc/caddy/Caddyfile`) listens on 80/443 and proxies to the app on port 3000. The instance's public IP is `3.6.206.107` (ap-south-1). To view the app from a laptop while connected remotely, forward port 3000 (VS Code Ports panel or `ssh -L 3000:localhost:3000 <host>`).
- Edits are live, with no separate deploy step: localhost:3000 and smartscan.in are the same process. Changes in `public/` show up immediately (hard-refresh the browser). Changes to `server.js`, `admin/routes.js`, `.env`, or `npm install` need `sudo systemctl restart smartscan`, because the unit runs plain `node server.js` with no watch mode. A syntax error followed by a restart takes the live site down. To test first, run `PORT=3001 node --env-file-if-exists=.env server.js`, and note that this uses the production `data/inventory.db` unless pointed at a copy. Check `sudo journalctl -u smartscan -n 30` after restarting.
- Production runs as the systemd unit `smartscan` (`sudo systemctl restart smartscan`, logs via `sudo journalctl -u smartscan -n 30`). [DEPLOY.md](DEPLOY.md) is a beginner AWS guide covering EC2, HTTPS, and nightly `sqlite3 .backup` to S3. It warns never to overwrite the server's `data/` folder when deploying.

### Environment (`.env`, see `.env.example`)

- `ANTHROPIC_API_KEY`: needed only for invoice scanning. Without it, `/api/scan` returns 400 and items can still be entered by hand. `CLAUDE_MODEL` overrides the default model (`claude-sonnet-5-5`).
- `SESSION_SECRET`: optional. If unset, a random secret is generated once and stored in table `app_meta`.
- `ADMIN_USER` / `ADMIN_PASSWORD`: log in to the `/admin` dashboard. The dashboard is disabled (503) when `ADMIN_PASSWORD` is empty.
- `APP_USER` / `APP_PASSWORD` (and optional `APP_EMAIL`): used only once, by the accounts migration (see Accounts below).

## Architecture

Smartscan is a household grocery and inventory tracker. A user scans a purchase invoice (image or PDF) with Claude, reviews it, and saves it. The app then keeps inventory and consumption stats up to date. It is multi-tenant: each household is a separate user account. There is no framework or bundler.

- [server.js](server.js) holds the whole backend (ESM): schema and migrations, auth, helpers, and all routes.
- [admin/routes.js](admin/routes.js) + [admin/index.html](admin/index.html) form the `/admin` dashboard, mounted via `mountAdmin(app, db)`. It has its own login and `ss_admin` cookie. Features: a generic table browser with row CRUD; user status and password reset; full account deletion that cascades across all owned tables; and a `VACUUM INTO` backup download.
- [public/](public/) is the static site served by `express.static`. It needs no login. [index.html](public/index.html) is both the public landing page and the SPA. [app.js](public/app.js) shows login and signup as modals, checks `/session`, and makes plain `fetch` calls. Charts (pie/cylinder) are hand-built SVG, and pagination and print helpers are hand-written too.
- `data/inventory.db` is the SQLite file (gitignored). Other `.db` files in `data/` are backups, such as the automatic `inventory.migration-<timestamp>.db`.

### Accounts and multi-tenancy

- Accounts live in the `users` table (`userid`, `family_name`, `email`, scrypt `password_hash`, `status`). Signup (`POST /signup`) creates an active account straight away and seeds it with `DEFAULT_CATEGORIES`. Email activation is planned but not built; the `activation_token` column is reserved for it.
- The session cookie `ss_session` has the form `base64url(userid).expiry.hmac`. The HMAC also covers a tag derived from the password hash, so changing the password signs out every device.
- Only these routes are public: `/login`, `/logout`, `/session`, `/signup*`, `/feedback` (rate-limited per IP), and the static files. Middleware on `/api` returns 401 without a valid session; otherwise it sets `req.uid`.
- **Every data query must be scoped to `req.uid`.** `buyers`, `categories`, `inventory`, `invoices`, `households`, and `user_settings` each have an `owner` column. `invoice_items` and `consumption_log` are scoped through a join to their parent. Helpers such as `findMatch(uid, ...)` and `getSettings(uid)` take the uid explicitly.
- `migrateToAccounts()` is a one-time upgrade from the old single-household schema. It skips itself if `inventory.owner` exists. Otherwise it writes a `VACUUM INTO` backup, rebuilds the tables with `owner`, and gives the existing data to the user whose ID matches the old household code. If there is no such user, it uses the `APP_USER` account, which needs `APP_PASSWORD`; if that isn't set, startup throws.

### Things that need reading across the code

- **Migrations are inline and idempotent.** The schema is `CREATE TABLE IF NOT EXISTS` statements plus lists of `ALTER TABLE ... ADD COLUMN` statements, each wrapped in `try {} catch {}`. Add new columns to those lists. New per-account tables need an `owner` column. One-time data migrations (`avg_rate`, `used_qty`) rely on `ADD COLUMN` throwing when the column already exists, so they run only once.
- **Inventory quantity semantics:** `quantity` is the total purchased, `used_qty` is the amount consumed, and the balance is `quantity - used_qty`. Valuation uses the weighted-average rate `avg_rate`, which is re-weighted on each purchase (`addStock` in `POST /api/invoices`). Consumption can be recorded in three ways, and all three write to `consumption_log`, which the overstock, usage, and next-month-order reports read:
  - manual edits to `inventory.used_qty`
  - `POST /api/inventory/:id/consume`
  - per invoice line, via `PATCH /api/invoice-items/:id`. This sets `invoice_items.used_qty`/`used_date`, updates the matched inventory item, and logs the change with `invoice_item_id`. The applied amount is clamped so balances never go negative.
- **Invoice items are matched to inventory by fuzzy name, not by foreign key.** `findMatch(uid, description, uom)` tokenizes names (lowercase, strips plurals and punctuation) and looks for Jaccard similarity ≥ 0.8 within the same UOM and owner. It is used in four places:
  - saving invoices (merge into an existing item vs. create a new one)
  - `/api/check` (duplicate preview in the review UI)
  - `PATCH /api/invoice-items/:id`
  - all stats and order endpoints, to map historical `invoice_items` back to inventory (e.g. for `consumption_type`)

  Changing its logic changes report results retroactively.
- **Scan flow:** `POST /api/scan` (multer, in memory, 20 MB limit) sends three things to Claude: the file, `PROMPT` + `USED_BY_PROMPT`, and a category list built from the user's `categories`. It takes the first balanced JSON object from the reply (`firstJsonObject`) and returns it without saving. The user edits it in the frontend, then `POST /api/invoices` validates and saves everything in one transaction. Validation rules:
  - A buyer is required.
  - Every line needs a `consumption_type`, either supplied or inherited from a matched item.
  - `action: 'update'` overwrites stock instead of adding to it.
- **Settings affect math:** `user_settings.rate_includes_tax` changes how line amounts are computed on save (`rate × qty` vs. adding `tax_pct`). `language` and `currency` are stored there too and applied on the client.
- **Household constraints:** each account has one `households` row. It must satisfy children + adults = males + females = sum of age groups = persons. Buyers cannot exceed persons. Buyers who have invoices can't be deleted. Category `budget_pct` totals cannot exceed 100.
- **Stats and order endpoints** are computed locally with SQL and rules, with no model call:
  - `/api/stats/composition|pattern|overstock|usage|channels`: month-based reports share `monthPurchases`.
  - `usage` derives a status (Out of stock / Restock soon / Overstocked / Buying too often) from `CYCLE_DAYS` per consumption type.
  - `channels` breaks spend and effective discount down by online/offline channel and vendor.
  - `/api/orders/nextmonth` builds a suggested monthly order. It bases need on the consumption log, or on the average monthly stock-in when no consumption is logged, and can project stock forward for later months.

# First launch

**NOT FOR PROFIT** — civic public good. Not a commercial product.

On the very first boot, with an empty `node-data` volume, the Node prepares itself. There is no setup wizard to click through and no SQL to run.

## What happens on an empty volume

1. The Node creates `$DATA_DIR/zk-voting.json` (the data store) and writes a random node id.
2. It seeds **one platform administrator** with the handle from `ADMIN_HANDLE` (default `admin`). That account has no passkey yet. A later boot never creates a second administrator.
3. If `SUPER_ADMIN_EMAIL` is set, it is stored as that administrator's contact address. `/feedback` messages go there.
4. It seeds a **Demo jurisdiction** so the officer pages have something to show.
5. If `RECEIPT_PDF_SECRET` is empty, it creates `$DATA_DIR/receipt-pdf.secret`.

## Claim the administrator account

Do this right after the first deploy, before you share the address:

1. Open the site and go to **Register** (`/register`).
2. Enter the `ADMIN_HANDLE` value (default `admin`) as your handle.
3. Create a passkey on your device and complete the email code if SES is configured.
4. Sign in. **Officials → platform admin** (`/admin`) is now available.

Until that account is claimed, anyone who can reach the site could try to claim it. Keep the Node private while you claim it: use the [Tailscale sidecar](./tailscale.md), a firewall, or your PaaS's basic-auth option. Then open it to the public.

## Make it yours

- **Name and text.** As an officer, open `/office/site` to edit the public home page and contract pins. Environment variables win over values saved there. A full branding configuration (name, logo, colors, emails) is planned; until then the default name is "zk-voting".
- **Voting hostname.** Set `VOTE_FQDN` before voters register passkeys. Passkeys are bound to that hostname; changing it later means voters must register again.
- **Email.** Set `SES_FROM_ADDRESS` and `AWS_REGION` so sign-in codes and Terms PDFs are delivered.
- **Jurisdictions and officers.** Add your real jurisdiction and officers from `/admin`, then create your first election from the admin hub (`/office`).

## Check it

```bash
curl -fsS https://vote.example.org/health
curl -fsS https://vote.example.org/api/config
```

`/health` must show `"ok": true` and your `voteFqdn`. `/api/config` shows the passkey relying party and contract pins. See [Health checks](./health-checks.md).

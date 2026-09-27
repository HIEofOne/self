# trustee.ai: a group-only demonstration host

trustee.ai runs MAIA as a **group-only host** (`MAIA_HOST_ROLE=group-only`). It hosts demonstration groups and nothing else: no patient accounts, no private AIs, no health records. People try MAIA by joining its groups from their own MAIA host (maia.agropper.xyz, or test.agropper.xyz while testing) and using made-up records.

Its welcome page lists the public groups, with "Join with ‹member host›", "Copy the join link" and "Ask this group" (the group request page), plus the two diagrams. The group admin signs in at `/admin`.

## Before you start: don't break trustee.ai's email

trustee.ai's DNS is at Namecheap (nameservers `dns1/dns2.registrar-servers.com`). Its email uses **Namecheap Email Forwarding**:

- MX records `eforward1…5.registrar-servers.com`
- the SPF record `v=spf1 include:spf.efwd.registrar-servers.com ~all`

To keep email working:

1. **Keep Namecheap's nameservers.** Don't move the domain's DNS to DigitalOcean: the forwarding records would vanish.
2. **Don't touch the MX records, the Mail Settings / Email Forwarding section, or the SPF TXT record.**
3. **Never put a CNAME on `@`** (the bare trustee.ai): it would take the MX records with it.
4. **Don't set up trustee.ai as a sending domain** for MAIA's email. MAIA keeps sending from its existing address (`RESEND_FROM_EMAIL` stays unset), so no new SPF or DKIM records are needed on trustee.ai.
5. **Before editing, take a screenshot of Advanced DNS → Host Records and Mail Settings.** After every change, send a test email to a trustee.ai address and confirm it arrives.

The safest address for the app is **www.trustee.ai**: it needs only a CNAME on `www`, which today points at Namecheap's parking page, and nothing on `@`.

## 1. Create the app in DigitalOcean

In the DigitalOcean account that runs the other MAIA apps:

1. **Apps → Create App → GitHub**, repository `HIEofOne/self`, branch `main`. Take the build and run commands from the test app (claude-self). The smallest instance size is enough.
2. **Environment variables** (as encrypted where marked):

| Variable | Value |
|---|---|
| `PUBLIC_APP_URL` | `https://www.trustee.ai` |
| `DIGITALOCEAN_TOKEN` (encrypted) | the same token the other MAIA apps use |
| `SPACES_AWS_ACCESS_KEY_ID` (encrypted) | the same as the other apps |
| `SPACES_AWS_SECRET_ACCESS_KEY` (encrypted) | the same as the other apps |
| `MAIA_EDITION` | `personal-as` |
| `MAIA_HOST_ROLE` | `group-only` |
| `MAIA_MEMBER_HOSTS` | `https://test.agropper.xyz` while testing; later `https://maia.agropper.xyz` (both, comma-separated, if you like) |
| `COUCHDB_DB_PREFIX` | `trustee_` |
| `SPACES_BUCKET` | `maia-trustee` |
| `RESEND_API_KEY` (encrypted) | copy it from the test app, if it is set there: the group request page emails requesters a code |

**Leave these unset:**

- `MAIA_EMAIL_VERIFY_BYPASS`, which is for test apps only;
- `RESEND_FROM_EMAIL`, so email keeps its current sender.

With the same token, the app uses the same CouchDB droplet as the others; its databases start with `trustee_`. It also uses the same Spaces subscription, in its own bucket. It creates no search cluster and no AI agents.

3. **Deploy**, and wait for the build to finish.

## 2. Point www.trustee.ai at the app

1. In the DigitalOcean app: **Settings → Domains → Add Domain** → `www.trustee.ai`. Choose **"You manage your domain"**, not DigitalOcean nameservers. DigitalOcean shows a CNAME target like `‹app›.ondigitalocean.app`.
2. In Namecheap: **Domain List → trustee.ai → Manage → Advanced DNS → Host Records**. Edit the existing `www` CNAME record (now `parkingpage.namecheap.com`) so its value is the DigitalOcean target. Leave every other record as it is.
3. Wait for DigitalOcean to show the domain as active, with its certificate. This takes minutes, sometimes up to an hour.
4. Send a test email to a trustee.ai address and confirm it still arrives.

**Optional, later: the bare trustee.ai.** Either:

- keep Namecheap's URL redirect on `@` and point it at `https://www.trustee.ai`; or
- add a Namecheap **ALIAS** record on `@` to the DigitalOcean target, and add `trustee.ai` as a second domain in the app.

An ALIAS record doesn't disturb the MX records, but test email again afterwards. `PUBLIC_APP_URL` stays `https://www.trustee.ai`, because join links and the admin's passkey belong to one address.

## 3. Set up the demonstration groups

1. Open `https://www.trustee.ai/admin`. The first time, sign in as `admin` with the DigitalOcean token as the passphrase, then create the admin passkey.
2. **Patient Groups → New group**, twice:
   - **Demo Patients**: peer support. Join mode *open*, publicly listed. Description, for example: "A demonstration group for trying MAIA. Use made-up records only."
   - **Demo Clinic**: a practice asking its patients. Join mode *open* or *link approval*, publicly listed, with a matching description.
3. Add suggested rules to each group, the cards members receive (unconfirmed) when they join.
4. For each group, **download the recovery kit** (the key icon). Make sure droplet snapshots are on for the CouchDB droplet: a group's signing key exists only there and in the kit.

## 4. Try it

1. Open `https://www.trustee.ai`. It should list both groups, and offer no sign-up.
2. On a member host (test.agropper.xyz), create a MAIA, or use one you have. Then, from trustee.ai, click **Join with test.agropper.xyz**, or paste the join link into Workbook → Groups.
3. From a clean browser, open **Ask this group** on trustee.ai and send a request. The member's MAIA picks it up within the hour, and their rules decide.

Requests between a group and its members need the Personal AS edition on both hosts: a full-edition host doesn't read GNAP requests. maia.agropper.xyz can be a member host once it runs `MAIA_EDITION=personal-as`.

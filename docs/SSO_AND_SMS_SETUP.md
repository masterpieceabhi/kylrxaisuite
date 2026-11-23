# Text-message codes (Twilio) and company single sign-on (SSO)

Both are built. Each needs an outside account and a few settings. Do them on **staging first**, then repeat for production.

## 1. Text-message sign-in codes (Twilio)

What the code does: after a wrong or missing PIN, a person can choose to get the sign-in code **by text** instead of
email. The text goes only to the mobile number already on their record (`routes/pin-signin.js`, `sendText`).

### Testing on staging with a free Twilio trial
1. Sign up at twilio.com. The trial gives a small credit and one trial phone number.
2. In the Twilio console, copy the **Account SID** and **Auth Token**, and the trial **phone number** (+1...).
3. A trial account can text **only numbers you have verified** in the console (Phone Numbers > Verified Caller IDs).
   Verify the phones of the people testing (Jay, Vandana, Sachin). Each text starts with "Sent from your Twilio trial account".
4. On the server, in `/etc/onnhr/onnhr.env`:
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM=+1XXXXXXXXXX
   ```
   then `sudo systemctl restart onnhr`. The names BizCRM uses (`TWILIO_SID`, `TWILIO_TOKEN`) work too, so its lines
   can be pasted as they are; only `TWILIO_FROM` must be a number that is on the Twilio account.
5. Each tester needs a **mobile number on their record** (My profile, or HR on the person's profile).
6. Test: sign in with a wrong PIN, choose "Text me a code", type the code.

### For production (real customers)
- Upgrade the Twilio account (pay as you go) and buy a number.
- US carriers require registration before an app may text people: either **A2P 10DLC** (brand plus campaign
  registration for a local number) or **toll-free verification** (for a toll-free number). Registration takes days to
  weeks, so start it early. Use case to describe: "one-time sign-in codes (2FA) for employees of our customers".
- Check Twilio's current prices before choosing; both routes have small one-time and monthly fees plus a per-text price.

## 2. Company single sign-on (SSO)

What the code does:
- Company details > Security (`admin-us-security.html`): the company enters its provider id (for example
  `oidc.entra`), its email domains, and whether SSO is **required**. Required keeps at least one break-glass email.
- Sign-in page: after the email is typed, a company with SSO gets a "Sign in with your company (SSO)" button.
- Since 2026-11-22 the server finishes the sign-in (`POST /api/sso/complete`, `services/sso-complete.js`): it checks
  the provider's token, that the domain belongs to that company and that provider, finds the active person by email
  inside that company, and signs them into their own Onn HR account. Before this, an SSO sign-in could never find the
  person (the browser may not read other records), so SSO did not work for US companies.
- When SSO is **required**, PIN, code and QR sign-in are refused too (break-glass emails excepted). Password sign-in
  already was.

### Setting it up on staging (Prompt AI uses Microsoft 365, so Microsoft Entra ID)
1. **Firebase console** (the staging project) > Authentication > Settings:
   - Upgrade to **Firebase Authentication with Identity Platform** (needed for OIDC and SAML providers). It has a free
     monthly allowance; OIDC and SAML sign-ins are billed per monthly active user above that.
   - **User account linking: "Create multiple accounts for each identity provider".** Without this, Firebase refuses an
     SSO sign-in for an email that already has a PIN account ("account exists with different credential").
   - Authorized domains: make sure `app-staging.onnhr.com` is listed.
2. **Microsoft Entra admin center** (entra.microsoft.com) > App registrations > New registration:
   - Name: Onn HR Staging. Supported accounts: this organization only.
   - Redirect URI (Web): `https://<firebase-project-id>.firebaseapp.com/__/auth/handler` (the exact address is shown
     in the Firebase provider form in step 3).
   - Certificates & secrets > New client secret: copy the value.
   - Copy the Application (client) ID and the Directory (tenant) ID.
   - Token configuration: add the optional claim **email** to the ID token.
3. **Firebase** > Authentication > Sign-in method > Add new provider > **OpenID Connect**:
   - Name `entra` (the provider id becomes `oidc.entra`), Client ID, Issuer
     `https://login.microsoftonline.com/<tenant-id>/v2.0`, Client secret, Code flow.
4. **Onn HR** (as the owner) > Security > Single sign-on:
   - Provider id `oidc.entra`, domains `promptaiusa.com` (and `promptaius.com` if Vandana's mailbox is in the same
     Microsoft 365 tenant), switched on, **not required yet**. Break-glass: your own email.
5. Test: on the sign-in page type `jay@promptaiusa.com`, press "Sign in with your company (SSO)", sign in at Microsoft,
   and you should land on Home as Jay. Then try a Microsoft account whose email has no Onn HR person: it must be refused.
6. Only after that works for everyone: switch **Required** on. Keep the break-glass email.

### Other identity providers
Okta, Google Workspace, OneLogin and others work the same way: OIDC (preferred) or SAML in Firebase, then the provider
id (`oidc.<name>` or `saml.<name>`) and domains in Onn HR. Each customer sets up their own provider for their own
domain; a domain can belong to only one company.

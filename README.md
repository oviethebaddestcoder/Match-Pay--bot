# MatchPay

Order reconciliation for chat-based sellers. A seller creates an order over WhatsApp,
gets back a **unique Monnify virtual account** for that one order, and the moment
the buyer pays, the bot confirms it — automatically, in the same chat, with the buyer's
name attached. No more scrolling bank alerts trying to guess who sent what.

## Onboarding (new sellers)

MatchPay is now multi-tenant — any WhatsApp number that messages the bot is
automatically onboarded as its own seller account. First-contact flow:

1. Welcome message.
2. Business name.
3. Email (used on Monnify records).
4. Bank selection — seller types their bank's name (e.g. "opay", "gtbank",
   "kuda") and the bot searches Monnify's **live bank list**
   (`GET /api/v1/banks`) for matches, not a fixed menu. This is deliberate:
   bank "codes" aren't standardized across payment providers - a hardcoded
   list risks silently using the wrong provider's code convention for a
   fintech wallet. Pulling from Monnify's own list guarantees the code used
   is the one that actually works with Monnify's transfer and verification
   APIs, and covers OPay, PalmPay, Kuda, Moniepoint, and every traditional
   bank Monnify supports - automatically, with no list to maintain.
5. Account number → **verified live against Monnify's name-enquiry API**
   → seller must explicitly confirm the returned account name before it's
   trusted. This is the one and only path by which a settlement account
   gets registered — there is no separate "update my account" shortcut,
   which closes the most common social-engineering angle (tricking someone
   into silently redirecting their own payout account).
6. Withdrawal PIN — entered twice (set, then confirm) so a typo on day one
   doesn't lock the seller out of their own money.

Progress is persisted on the `Seller` record (`onboardingStep`), not just in
memory, so a server restart mid-onboarding doesn't force a seller to start
over — they resume exactly where they left off.

## Withdrawals — security model

1. Seller sends `withdraw <amount>`.
2. Bot shows the destination account and asks for the 4-digit PIN.
3. PIN is checked against a **bcrypt hash** (never stored or logged in
   plaintext). **3 wrong attempts locks the account** — lockout requires
   manual clearance (a support/admin action), not a timed cooldown, since
   this guards money movement rather than a login screen.
4. On a correct PIN: the wallet balance is **debited via a single atomic
   conditional `UPDATE`** (`SET balance = balance - :amount WHERE balance >=
   :amount`), not a read-then-write pattern. This is what prevents two
   withdrawal requests racing each other from both succeeding against the
   same balance — verified directly by `npm run test:concurrency` (see
   Testing below), which fires concurrent debit attempts and confirms the
   database never over-withdraws.
5. Only then is Monnify's disbursement API called. If that call fails, the
   debited amount is **immediately refunded** — a seller's balance can never
   silently vanish because of a network error.
6. Funds only ever go to the **single verified settlement account** set at
   onboarding. There's no "send to a new account" option in the withdrawal
   flow at all — reducing what an attacker can do even if they get hold of
   the seller's WhatsApp session.
7. Final status is confirmed asynchronously via Monnify's disbursement
   webhook (`SUCCESSFUL_DISBURSEMENT` / `FAILED_DISBURSEMENT`), same
   signature verification as the payment webhook. A failed disbursement
   refunds the wallet a second and final time if it wasn't already refunded
   at the initiation step.


## Monetization

Every order carries a computed platform fee (see `src/orders/fee.util.ts`):
**1% of the order amount, floored at ₦10, capped at ₦500.** It's stored on the
order (`platformFee`, `netAmount`) at creation time and shown transparently to
the seller in WhatsApp, both when the order is created and when it's confirmed
paid — no surprise deductions.

This is deliberately just the fee *calculation and disclosure* layer, not an
actual payout split — for the hackathon demo, showing the fee live in the chat
is enough to prove the business model works. Actually routing the net amount
to the seller's own account vs. the platform's account is a real next step
(Monnify supports split/sub-account payouts) but isn't required to demo the
monetization story convincingly.

## How it works

1. Seller texts the bot: `new order Ada | 15000 | 2348012345678`
2. Backend calls Monnify's **dynamic virtual account** flow (Initialize
   Transaction → Pay with Bank Transfer) to generate a **one-time account
   number tied to that single order**, valid for up to 40 minutes. Unlike a
   persistent Reserved Account, nothing is left behind to accumulate —
   the account simply expires if unused, and no KYC step is required since
   the buyer isn't opening a standing account with you.
3. Bot replies with the account number to forward to the buyer, plus the
   expiry window.
4. Buyer pays into that specific account before it expires.
5. Monnify fires a webhook the instant the payment lands, echoing back the
   exact `paymentReference` we generated at step 2.
6. Backend verifies the webhook signature, looks up the order by that
   reference, and marks it PAID — no manual matching, and no ambiguity even
   if ten different buyers are paying for ten different orders at once.
7. Seller's wallet is credited (net of platform fee), and the bot pushes a
   live confirmation into WhatsApp.

If a buyer doesn't pay within the window, the seller can send
`renew <order id>` to get a fresh account for the same order without losing
any of the order's history.

### Why not just reuse one persistent account per order?

Monnify's Reserved Account API creates a permanent account object meant for
recurring billing relationships — the kind of thing that makes sense for one
account per *seller*, not one per *order*. Doing that per order at any real
volume means thousands of dormant account objects piling up forever, and
that product line is generally paired with KYC data (BVN/NIN) in Monnify's
docs, which is unnecessary friction for a one-time buyer. The dynamic
one-time-payment flow used here is what Monnify's own docs describe as built
for exactly this shape of transaction.

## Testing

**Without any Monnify credentials at all** — two real test suites, run in
seconds:

```bash
npm install
npm test
```

This runs:
- `test:fees` — verifies the fee floor/cap/percentage math.
- `test:concurrency` — boots a real (throwaway) SQLite database and fires 20
  concurrent withdrawal-debit attempts against a balance that can only cover
  10 of them, then checks that exactly 10 succeed and the final balance is
  exactly zero. This is the actual proof that the wallet balance logic can't
  be double-spent by a race condition, not just a claim about it.

**Full end-to-end test against Monnify's sandbox:**

```bash
npm install
cp .env.example .env   # fill in your Monnify sandbox credentials
npm run start:dev
```

Scan the WhatsApp QR code on first run. Then, in a separate terminal:

```bash
ngrok http 3000
```

Paste the resulting `https://xxxx.ngrok.app/webhooks/monnify` URL into your
Monnify sandbox dashboard's webhook settings. From there:

1. Message the bot to onboard as a seller (business name → email → bank →
   account verification → PIN).
2. Send `new order Test | 500`.
3. Use Monnify's sandbox payment simulator (linked from their dashboard) to
   simulate a transfer to the account number the bot gives you.
4. Confirm the bot pushes a payment confirmation within a couple of seconds.
5. Send `withdraw 400` and confirm with your PIN — this exercises the real
   disbursement flow against the sandbox as well.

## Troubleshooting

**WhatsApp loops "connected to WA" → "not logged in" → "Connection Failure"
forever, and no QR code ever prints.** This happens when the socket
connects using a stale WhatsApp Web protocol version baked into the
library at release time, which WhatsApp's servers silently reject right
after the handshake. Fixed by fetching the current version at connect time
(`fetchLatestBaileysVersion()` in `whatsapp.service.ts`) rather than
relying on Baileys' built-in default. If you still hit this after pulling
the fix: delete `./whatsapp-auth` and restart (forces a completely fresh
pairing), and confirm your network isn't blocking outbound WebSocket
connections to WhatsApp's servers (some corporate/campus networks do).

## Project structure

```
src/
  main.ts                  - bootstrap, raw-body capture for webhook signature verification
  app.module.ts             - wires everything together
  sellers/                  - Seller entity, onboarding steps, PIN handling, transactional wallet balance
  orders/                   - Order entity, service (create + mark paid + credit seller wallet), REST controller
  withdrawals/               - Withdrawal entity, PIN-gated payout flow with balance locking
  monnify/                  - Monnify auth, reserved accounts, bank verification, disbursements, webhook signature verification
  webhooks/                 - Monnify webhook receiver -> routes to payment or disbursement handling
  events/                   - WebSocket gateway for the optional live dashboard
  whatsapp/                 - Baileys bot: onboarding conversation, order commands, withdrawal PIN flow
```

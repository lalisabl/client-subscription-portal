# Manvic Catalyst Datastore Schema

Create these tables **manually** in Zoho Catalyst Datastore (Console → Data Store → Tables).  
Column names must match exactly (case-sensitive where Catalyst requires it).

> Catalyst always adds system columns: `ROWID`, `CREATORID`, `CREATEDTIME`, `MODIFIEDTIME`.

### Type guide (Catalyst)

| Type | Max | When to use |
|---|---|---|
| **Var Char** | 255 (set Max Length) | Short values: names, emails, status — supports Search Index + Default |
| **Text** | 10,000 | Long content: descriptions, addresses, JSON — **no** Search Index / Default |
| **Encrypted text** | 10,000 | Secrets: `password_hash` |
| **Foreign Key** | — | Link to another table’s `ROWID`. Set **Parent Table** + **On Delete** |
| **Boolean** | — | flags |
| **Int** | 10 digits | small integers (frequency, cycles, qty, vat_rate) |
| **BigInt** | 19 digits | money in cents |
| **Date** | — | `YYYY-MM-DD` |
| **DateTime** | — | `YYYY-MM-DD HH:MM:SS` |

**Foreign Key → On Delete (Catalyst only has these two):**

| On Delete | Behaviour |
|---|---|
| **Null** | Parent deleted → this FK cell becomes empty (row kept) |
| **Cascade** | Parent deleted → this child row is deleted too |

**Rule:** Var Char for short fields · Text for long/JSON · Foreign Key for table links · Encrypted text for passwords.

### Create tables in this order (parents first)

1. `clients`
2. `products`
3. `users` (FK → clients)
4. `plans` (FK → products)
5. `subscriptions` (FK → clients, plans)
6. `invoices` (FK → clients, subscriptions)
7. `invoice_line_items` (FK → invoices)
8. `payments` (FK → invoices, subscriptions, clients)
9. `payfast_webhook_events`
10. `activity_log`
11. `settings`
12. `notification_logs`

---

## 1. `clients` _(create first — no FKs)_

| Column | Type | Max / options | Notes |
|---|---|---|---|
| name | Var Char | 150 · Search Index | company / client name |
| contact_person | Var Char | 120 | |
| email | Var Char | 120 · Search Index | |
| phone | Var Char | 40 | |
| vat_number | Var Char | 40 | |
| billing_address | Text | — | long address |
| status | Var Char | 20 · Default `active` | `active` \| `paused` \| `cancelled` |
| created_at | DateTime | — | |

---

## 2. `products` _(no FKs)_

| Column | Type | Max / options | Notes |
|---|---|---|---|
| name | Var Char | 150 · Search Index | |
| description | Text | — | long description |
| active | Boolean | Default `true` | |
| created_at | DateTime | — | |

---

## 3. `users`

| Column | Type | Max / options | Parent table | On Delete | Notes |
|---|---|---|---|---|---|
| email | Var Char | 120 · **IsUnique** · Search Index | — | — | lowercase login email |
| password_hash | Encrypted text | — | — | — | bcrypt hash |
| role | Var Char | 20 | — | — | `admin` \| `staff` \| `client` |
| name | Var Char | 120 | — | — | display name |
| client_rowid | **Foreign Key** | — | **`clients`** | **Null** | only for `role=client`; unlink if client removed |
| status | Var Char | 20 · Default `active` | — | — | `active` \| `disabled` |
| last_login | DateTime | — | — | — | |
| created_at | DateTime | — | — | — | |

**Seed (after create):** insert one admin user. To hash a password locally:

```bash
cd backend && node scripts/hash-password.js 'YourPassword'
```

---

## 4. `plans`

| Column | Type | Max / options | Parent table | On Delete | Notes |
|---|---|---|---|---|---|
| product_rowid | **Foreign Key** | — | **`products`** | **Cascade** | delete plans when product is deleted |
| name | Var Char | 150 · Search Index | — | — | |
| amount_cents | BigInt | — | — | — | price in cents (ZAR) |
| currency | Var Char | 10 · Default `ZAR` | — | — | |
| frequency | Int | — | — | — | PayFast: `3` monthly … `6` annual |
| cycles | Int | Default `0` | — | — | `0` = indefinite |
| vat_inclusive | Boolean | Default `true` | — | — | |
| features_json | Text | — | — | — | JSON |
| active | Boolean | Default `true` | — | — | |
| created_at | DateTime | — | — | — | |

---

## 5. `subscriptions`

| Column | Type | Max / options | Parent table | On Delete | Notes |
|---|---|---|---|---|---|
| client_rowid | **Foreign Key** | Search Index | **`clients`** | **Cascade** | remove subs when client is deleted |
| plan_rowid | **Foreign Key** | — | **`plans`** | **Null** | keep sub history if plan is removed |
| status | Var Char | 20 · Search Index | — | — | `pending` \| `active` \| `paused` \| `cancelled` \| `failed` \| `trial` |
| payfast_token | Var Char | 80 | — | — | from ITN after first payment |
| amount_cents | BigInt | — | — | — | |
| frequency | Int | — | — | — | |
| cycles | Int | Default `0` | — | — | |
| start_date | Date | — | — | — | |
| next_run_date | Date | — | — | — | |
| created_by | Var Char | 120 | — | — | staff email |
| created_at | DateTime | — | — | — | |
| updated_at | DateTime | — | — | — | |

---

## 6. `invoices`

| Column | Type | Max / options | Parent table | On Delete | Notes |
|---|---|---|---|---|---|
| invoice_number | Var Char | 40 · **IsUnique** · Search Index | — | — | e.g. `INV-2026-00001` |
| client_rowid | **Foreign Key** | Search Index | **`clients`** | **Null** | keep financial record if client removed |
| subscription_rowid | **Foreign Key** | — | **`subscriptions`** | **Null** | keep invoice if subscription removed |
| issue_date | Date | — | — | — | |
| due_date | Date | — | — | — | |
| status | Var Char | 20 · Search Index | — | — | `draft` \| `sent` \| `paid` \| `overdue` \| `failed` |
| subtotal_cents | BigInt | — | — | — | |
| vat_cents | BigInt | — | — | — | |
| total_cents | BigInt | — | — | — | |
| currency | Var Char | 10 · Default `ZAR` | — | — | |
| pdf_file_id | Var Char | 80 | — | — | optional File Store id |
| payfast_payment_id | Var Char | 80 | — | — | `pf_payment_id` |
| m_payment_id | Var Char | 80 · Search Index | — | — | merchant reference for PayFast |
| paid_at | DateTime | — | — | — | |
| created_at | DateTime | — | — | — | |

---

## 7. `invoice_line_items`

| Column | Type | Max / options | Parent table | On Delete | Notes |
|---|---|---|---|---|---|
| invoice_rowid | **Foreign Key** | Search Index | **`invoices`** | **Cascade** | lines die with invoice |
| description | Text | — | — | — | |
| qty | Int | Default `1` | — | — | |
| unit_amount_cents | BigInt | — | — | — | ex-VAT unit |
| vat_rate | Int | Default `15` | — | — | Catalyst has no Decimal |
| line_total_cents | BigInt | — | — | — | ex-VAT line total |

---

## 8. `payments`

| Column | Type | Max / options | Parent table | On Delete | Notes |
|---|---|---|---|---|---|
| invoice_rowid | **Foreign Key** | Search Index | **`invoices`** | **Cascade** | payments die with invoice |
| subscription_rowid | **Foreign Key** | — | **`subscriptions`** | **Null** | keep payment if sub removed |
| client_rowid | **Foreign Key** | Search Index | **`clients`** | **Null** | keep payment history |
| payfast_payment_id | Var Char | 80 | — | — | |
| m_payment_id | Var Char | 80 · Search Index | — | — | |
| amount_cents | BigInt | — | — | — | |
| status | Var Char | 20 | — | — | `complete` \| `failed` |
| method | Var Char | 20 | — | — | e.g. `cc` |
| raw_json | Text | — | — | — | full ITN payload |
| created_at | DateTime | — | — | — | |

---

## 9. `payfast_webhook_events` _(no FKs)_

| Column | Type | Max / options | Notes |
|---|---|---|---|
| m_payment_id | Var Char | 80 · Search Index | |
| pf_payment_id | Var Char | 80 · Search Index | idempotency |
| payment_status | Var Char | 20 | COMPLETE / FAILED / CANCELLED |
| token | Var Char | 80 | subscription token |
| signature_valid | Boolean | — | |
| payload_json | Text | — | full webhook body |
| received_at | DateTime | — | |
| processed | Boolean | Default `false` | |
| process_error | Text | — | |

---

## 10. `activity_log` _(no FKs — soft references)_

| Column | Type | Max / options | Notes |
|---|---|---|---|
| actor_type | Var Char | 20 | admin/staff/client/payfast/system |
| actor_email | Var Char | 120 · Search Index | |
| action | Var Char | 60 · Search Index | e.g. `client.create` |
| entity_type | Var Char | 40 | |
| entity_rowid | Var Char | 50 | soft ref (not FK — keep audit if entity deleted) |
| summary | Var Char | 255 | |
| meta_json | Text | — | |
| created_at | DateTime | — | |

---

## 11. `settings` _(no FKs)_

| Column | Type | Max / options | Notes |
|---|---|---|---|
| key_name | Var Char | 60 · **IsUnique** | `company`, `vat_rate`, `invoice_prefix` |
| value_json | Text | — | JSON string or plain value |

**Suggested seed rows:**

| key_name | value_json |
|---|---|
| vat_rate | `15` |
| invoice_prefix | `"INV-"` |
| company | `{"name":"Manvic Distributors","address":"","vat_number":"","email":"","phone":""}` |

---

## 12. `notification_logs` _(no FKs)_

| Column | Type | Max / options | Notes |
|---|---|---|---|
| template | Var Char | 80 | |
| recipient_email | Var Char | 120 · Search Index | |
| subject | Var Char | 200 | |
| status | Var Char | 20 | SENT / FAILED / SKIPPED |
| provider_message_id | Var Char | 120 | |
| error_message | Text | — | |
| related_type | Var Char | 40 | |
| related_id | Var Char | 50 | soft ref |
| sent_at | DateTime | — | |

---

## Foreign keys summary

| Child table | Column | Parent table | On Delete | Why |
|---|---|---|---|---|
| `users` | `client_rowid` | `clients` | **Null** | Unlink login; don’t delete user |
| `plans` | `product_rowid` | `products` | **Cascade** | Plans belong to product |
| `subscriptions` | `client_rowid` | `clients` | **Cascade** | Subs belong to client |
| `subscriptions` | `plan_rowid` | `plans` | **Null** | Keep billing history |
| `invoices` | `client_rowid` | `clients` | **Null** | Keep tax invoices |
| `invoices` | `subscription_rowid` | `subscriptions` | **Null** | Keep tax invoices |
| `invoice_line_items` | `invoice_rowid` | `invoices` | **Cascade** | Lines belong to invoice |
| `payments` | `invoice_rowid` | `invoices` | **Cascade** | Payments belong to invoice |
| `payments` | `subscription_rowid` | `subscriptions` | **Null** | Keep payment history |
| `payments` | `client_rowid` | `clients` | **Null** | Keep payment history |

```
products ──Cascade──► plans
clients ──Cascade──► subscriptions ──Null──► plans
clients ──Null──► invoices ──Null──► subscriptions
invoices ──Cascade──► invoice_line_items
invoices ──Cascade──► payments
clients ──Null──► users.client_rowid
clients ──Null──► payments.client_rowid
```

## After creating tables

1. Deploy AppSail (`manvic-api`).
2. Set env vars from `.env.example`.
3. Create admin user (insert into `users` with bcrypt hash).
4. Point PayFast ITN `notify_url` to `https://<appsail-host>/api/payfast/itn`.

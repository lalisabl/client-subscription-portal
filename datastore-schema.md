# Manvic Catalyst Datastore Schema

Create these tables **manually** in Zoho Catalyst Datastore (Console → Data Store → Tables).  
Column names must match exactly (case-sensitive where Catalyst requires it).

> Catalyst always adds system columns: `ROWID`, `CREATORID`, `CREATEDTIME`, `MODIFIEDTIME`.

### Type guide (Catalyst)

| Type | Max | When to use |
|---|---|---|
| **Var Char** | 255 (set Max Length) | Short values: names, emails, status, IDs — supports Search Index + Default |
| **Text** | 10,000 | Long content: descriptions, addresses, JSON payloads — **no** Search Index / Default |
| **Encrypted text** | 10,000 | Secrets: `password_hash` |
| **Boolean** | — | flags |
| **Int** | 10 digits | small integers (frequency, cycles, qty, vat_rate) |
| **BigInt** | 19 digits | money in cents |
| **Date** | — | `YYYY-MM-DD` |
| **DateTime** | — | `YYYY-MM-DD HH:MM:SS` |

**Rule:** Var Char for short fields · Text for long / JSON · Encrypted text for passwords.

---

## 1. `users`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| email | Var Char | 120 · **IsUnique** · Search Index | lowercase login email |
| password_hash | Encrypted text | — | bcrypt hash |
| role | Var Char | 20 | `admin` \| `staff` \| `client` |
| name | Var Char | 120 | display name |
| client_rowid | Var Char | 50 | links client users to `clients.ROWID` |
| status | Var Char | 20 · Default `active` | `active` \| `disabled` |
| last_login | DateTime | — | |
| created_at | DateTime | — | |

**Seed (after create):** insert one admin user via API or console. To hash a password locally:

```bash
cd backend && node scripts/hash-password.js 'YourPassword'
```

---

## 2. `clients`

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

## 3. `products`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| name | Var Char | 150 · Search Index | |
| description | Text | — | long description |
| active | Boolean | Default `true` | |
| created_at | DateTime | — | |

---

## 4. `plans`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| product_rowid | Var Char | 50 | FK → `products.ROWID` |
| name | Var Char | 150 · Search Index | |
| amount_cents | BigInt | — | price in cents (ZAR) |
| currency | Var Char | 10 · Default `ZAR` | |
| frequency | Int | — | PayFast: `3` monthly, `4` quarterly, `5` biannual, `6` annual |
| cycles | Int | Default `0` | `0` = indefinite |
| vat_inclusive | Boolean | Default `true` | if true, amount includes VAT |
| features_json | Text | — | JSON array/string |
| active | Boolean | Default `true` | |
| created_at | DateTime | — | |

---

## 5. `subscriptions`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| client_rowid | Var Char | 50 · Search Index | FK → clients |
| plan_rowid | Var Char | 50 | FK → plans |
| status | Var Char | 20 · Search Index | `pending` \| `active` \| `paused` \| `cancelled` \| `failed` \| `trial` |
| payfast_token | Var Char | 80 | from ITN after first payment |
| amount_cents | BigInt | — | |
| frequency | Int | — | same as plans |
| cycles | Int | Default `0` | |
| start_date | Date | — | `YYYY-MM-DD` |
| next_run_date | Date | — | |
| created_by | Var Char | 120 | staff email |
| created_at | DateTime | — | |
| updated_at | DateTime | — | |

---

## 6. `invoices`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| invoice_number | Var Char | 40 · **IsUnique** · Search Index | e.g. `INV-2026-00001` |
| client_rowid | Var Char | 50 · Search Index | |
| subscription_rowid | Var Char | 50 | |
| issue_date | Date | — | |
| due_date | Date | — | |
| status | Var Char | 20 · Search Index | `draft` \| `sent` \| `paid` \| `overdue` \| `failed` |
| subtotal_cents | BigInt | — | |
| vat_cents | BigInt | — | |
| total_cents | BigInt | — | |
| currency | Var Char | 10 · Default `ZAR` | |
| pdf_file_id | Var Char | 80 | optional Catalyst File Store id |
| payfast_payment_id | Var Char | 80 | `pf_payment_id` |
| m_payment_id | Var Char | 80 · Search Index | merchant reference sent to PayFast |
| paid_at | DateTime | — | |
| created_at | DateTime | — | |

---

## 7. `invoice_line_items`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| invoice_rowid | Var Char | 50 · Search Index | FK → invoices |
| description | Text | — | line description can be long |
| qty | Int | Default `1` | |
| unit_amount_cents | BigInt | — | ex-VAT unit |
| vat_rate | Int | Default `15` | e.g. 15 (Catalyst has no Decimal) |
| line_total_cents | BigInt | — | ex-VAT line total |

---

## 8. `payments`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| invoice_rowid | Var Char | 50 · Search Index | |
| subscription_rowid | Var Char | 50 | |
| client_rowid | Var Char | 50 · Search Index | |
| payfast_payment_id | Var Char | 80 | |
| m_payment_id | Var Char | 80 · Search Index | |
| amount_cents | BigInt | — | |
| status | Var Char | 20 | `complete` \| `failed` |
| method | Var Char | 20 | e.g. `cc` |
| raw_json | Text | — | full ITN payload |
| created_at | DateTime | — | |

---

## 9. `payfast_webhook_events`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| m_payment_id | Var Char | 80 · Search Index | |
| pf_payment_id | Var Char | 80 · Search Index | for idempotency |
| payment_status | Var Char | 20 | COMPLETE / FAILED / CANCELLED |
| token | Var Char | 80 | subscription token |
| signature_valid | Boolean | — | |
| payload_json | Text | — | full webhook body |
| received_at | DateTime | — | |
| processed | Boolean | Default `false` | |
| process_error | Text | — | error details if any |

---

## 10. `activity_log`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| actor_type | Var Char | 20 | admin/staff/client/payfast/system |
| actor_email | Var Char | 120 · Search Index | |
| action | Var Char | 60 · Search Index | e.g. `client.create` |
| entity_type | Var Char | 40 | |
| entity_rowid | Var Char | 50 | |
| summary | Var Char | 255 | human readable (keep ≤255) |
| meta_json | Text | — | optional JSON |
| created_at | DateTime | — | |

---

## 11. `settings`

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

## 12. `notification_logs`

| Column | Type | Max / options | Notes |
|---|---|---|---|
| template | Var Char | 80 | |
| recipient_email | Var Char | 120 · Search Index | |
| subject | Var Char | 200 | |
| status | Var Char | 20 | SENT / FAILED / SKIPPED |
| provider_message_id | Var Char | 120 | |
| error_message | Text | — | can be long |
| related_type | Var Char | 40 | |
| related_id | Var Char | 50 | |
| sent_at | DateTime | — | |

---

## Relations (logical)

```
products 1──* plans
clients 1──* subscriptions *──1 plans
clients 1──* invoices *──1 subscriptions
invoices 1──* invoice_line_items
invoices 1──* payments
users (role=client) *──1 clients
```

## After creating tables

1. Deploy AppSail (`manvic-api`).
2. Set env vars from `.env.example`.
3. Create admin user (insert into `users` with bcrypt hash).
4. Point PayFast ITN `notify_url` to `https://<appsail-host>/api/payfast/itn`.

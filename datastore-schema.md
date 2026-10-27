# Manvic Catalyst Datastore Schema

Create these tables **manually** in Zoho Catalyst Datastore (Console → Data Store → Tables).  
Column names must match exactly (case-sensitive where Catalyst requires it).

> Catalyst always adds system columns: `ROWID`, `CREATORID`, `CREATEDTIME`, `MODIFIEDTIME`.  
> Use **Text** unless noted. Prefer **Encrypt** for `password_hash`.

---

## 1. `users`

| Column | Type | Notes |
|---|---|---|
| email | Text (unique) | lowercase login email |
| password_hash | Encrypt / Text | bcrypt hash |
| role | Text | `admin` \| `staff` \| `client` |
| name | Text | display name |
| client_rowid | Text | links client users to `clients.ROWID` |
| status | Text | `active` \| `disabled` |
| last_login | Text / DateTime | UTC `YYYY-MM-DD HH:mm:ss` |
| created_at | Text / DateTime | |

**Seed (after create):** insert one admin user via API or console. To hash a password locally:

```bash
node -e "console.log(require('bcryptjs').hashSync('YourPassword', 10))"
```

---

## 2. `clients`

| Column | Type | Notes |
|---|---|---|
| name | Text | company / client name |
| contact_person | Text | |
| email | Text | |
| phone | Text | |
| vat_number | Text | |
| billing_address | Text | |
| status | Text | `active` \| `paused` \| `cancelled` |
| created_at | Text / DateTime | |

---

## 3. `products`

| Column | Type | Notes |
|---|---|---|
| name | Text | |
| description | Text | |
| active | Boolean | default true |
| created_at | Text / DateTime | |

---

## 4. `plans`

| Column | Type | Notes |
|---|---|---|
| product_rowid | Text | FK → `products.ROWID` |
| name | Text | |
| amount_cents | BigInt / Int | price in cents (ZAR) |
| currency | Text | default `ZAR` |
| frequency | Int | PayFast: `3` monthly, `4` quarterly, `5` biannual, `6` annual |
| cycles | Int | `0` = indefinite |
| vat_inclusive | Boolean | if true, amount includes VAT |
| features_json | Text | JSON array/string |
| active | Boolean | |
| created_at | Text / DateTime | |

---

## 5. `subscriptions`

| Column | Type | Notes |
|---|---|---|
| client_rowid | Text | FK → clients |
| plan_rowid | Text | FK → plans |
| status | Text | `pending` \| `active` \| `paused` \| `cancelled` \| `failed` \| `trial` |
| payfast_token | Text | from ITN after first payment |
| amount_cents | BigInt / Int | |
| frequency | Int | same as plans |
| cycles | Int | |
| start_date | Text / Date | `YYYY-MM-DD` |
| next_run_date | Text / Date | |
| created_by | Text | staff email |
| created_at | Text / DateTime | |
| updated_at | Text / DateTime | |

---

## 6. `invoices`

| Column | Type | Notes |
|---|---|---|
| invoice_number | Text | e.g. `INV-2026-00001` |
| client_rowid | Text | |
| subscription_rowid | Text | |
| issue_date | Text / Date | |
| due_date | Text / Date | |
| status | Text | `draft` \| `sent` \| `paid` \| `overdue` \| `failed` |
| subtotal_cents | BigInt / Int | |
| vat_cents | BigInt / Int | |
| total_cents | BigInt / Int | |
| currency | Text | `ZAR` |
| pdf_file_id | Text | optional Catalyst File Store id |
| payfast_payment_id | Text | `pf_payment_id` |
| m_payment_id | Text | merchant reference sent to PayFast |
| paid_at | Text / DateTime | |
| created_at | Text / DateTime | |

---

## 7. `invoice_line_items`

| Column | Type | Notes |
|---|---|---|
| invoice_rowid | Text | FK → invoices |
| description | Text | |
| qty | Int | |
| unit_amount_cents | BigInt / Int | ex-VAT unit |
| vat_rate | Decimal / Int | e.g. 15 |
| line_total_cents | BigInt / Int | ex-VAT line total |

---

## 8. `payments`

| Column | Type | Notes |
|---|---|---|
| invoice_rowid | Text | |
| subscription_rowid | Text | |
| client_rowid | Text | |
| payfast_payment_id | Text | |
| m_payment_id | Text | |
| amount_cents | BigInt / Int | |
| status | Text | `complete` \| `failed` |
| method | Text | e.g. `cc` |
| raw_json | Text | ITN payload |
| created_at | Text / DateTime | |

---

## 9. `payfast_webhook_events`

| Column | Type | Notes |
|---|---|---|
| m_payment_id | Text | |
| pf_payment_id | Text | unique-ish for idempotency |
| payment_status | Text | COMPLETE / FAILED / CANCELLED |
| token | Text | subscription token |
| signature_valid | Boolean | |
| payload_json | Text | |
| received_at | Text / DateTime | |
| processed | Boolean | |
| process_error | Text | |

---

## 10. `activity_log`

| Column | Type | Notes |
|---|---|---|
| actor_type | Text | admin/staff/client/payfast/system |
| actor_email | Text | |
| action | Text | e.g. `client.create` |
| entity_type | Text | |
| entity_rowid | Text | |
| summary | Text | human readable |
| meta_json | Text | |
| created_at | Text / DateTime | |

---

## 11. `settings`

| Column | Type | Notes |
|---|---|---|
| key_name | Text | unique key: `company`, `vat_rate`, `invoice_prefix` |
| value_json | Text | JSON string or plain value |

**Suggested seed rows:**

| key_name | value_json |
|---|---|
| vat_rate | `15` |
| invoice_prefix | `"INV-"` |
| company | `{"name":"Manvic Distributors","address":"","vat_number":"","email":"","phone":""}` |

---

## 12. `notification_logs`

| Column | Type | Notes |
|---|---|---|
| template | Text | |
| recipient_email | Text | |
| subject | Text | |
| status | Text | SENT / FAILED / SKIPPED |
| provider_message_id | Text | |
| error_message | Text | |
| related_type | Text | |
| related_id | Text | |
| sent_at | Text / DateTime | |

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

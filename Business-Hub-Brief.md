# Business Hub — Critical Considerations & Sprint Plan

**Status:** Phase 1 scaffolding in progress (Apr 24, 2026)  
**Next gate:** Warehouse + manager live testing (May 1–31, 2026)

---

## 10 Critical Considerations

### 1. OAuth token expiry & refresh cycles
**Problem:** Xero OAuth tokens expire (typically 30–60 days). Currently no token refresh logic or handling for revoked access. If auth fails mid-dispatch, there's no graceful fallback.

**Sprint priority:** ✅ **Patch in Week 1** (2–3 hrs)  
**Action:** Add token refresh endpoint, store refresh token in XERO_KV, call refresh before every Xero API call.

---

### 2. Parallel running collision risk
**Problem:** Extension → Make + Extension → Hub (Phases 1–2) run simultaneously for 2–4 weeks. Risk of duplicate Xero invoices if both systems process the same order.

**Sprint priority:** ✅ **Patch in Week 1** (2–3 hrs)  
**Action:** Define unique order ID scheme; add dedup check in `/api/orders` endpoint; document reconciliation process.  
**Note:** Will be validated during 4-week live testing phase (May 1–31).

---

### 3. Chrome Extension is a single point of failure
**Problem:** Scraper only runs on Andrew's machine. If machine/network fails or extension breaks, entire pipeline stops. No manual entry fallback if scraper is down.

**Sprint priority:** ✅ **Patch in Week 1** (2–3 hrs)  
**Action:** Add "Manual Order Entry" form on `/orders` route as safety valve. Warehouse staff can create orders directly if extension is unavailable.

---

### 4. Order schema still undefined
**Problem:** No data model spec. What fields does an order contain? How are multi-branch ship-to addresses stored (e.g., PGG Wrightson → Martinborough)? This ambiguity will surface hard in Phase 1.

**Sprint priority:** ✅ **CRITICAL — Patch in Week 1** (1–2 hrs)  
**Action:** Define order schema as JSON/TypeScript interface. Include: ID, customer, line items, ship-to branch, freight codes, status, timestamps, notes. Write as reference in this brief or a new `ORDER_SCHEMA.md`.

---

### 5. Packing slip format is customer-facing lock-in
**Problem:** Once customers (PGG Wrightson, etc.) receive Hub-generated slips, the format becomes a published interface. Future changes become customer support issues.

**Sprint priority:** ✅ **Patch in Week 1** (1–2 hrs)  
**Action:** Contact major customers, document required slip layout, logo placement, required fields. Lock in the spec before Hub slip design starts.

---

### 6. Warehouse adoption has no plan B
**Problem:** Roadmap flags that the queue "has to be faster than email+sheet habit or it won't stick," but no fallback plan. What if warehouse staff reject it?

**Sprint priority:** ⏳ **Defer to Phase 2 / Live testing (May 1–31)**  
**Action:** Sync with warehouse manager in Week 2. Gather feedback on UX/speed during 4-week live test. Build adoption plan for Phase 2 rollout based on real feedback.

---

### 7. Freight logic migration is underspecified
**Problem:** Carton estimation, city-zone mapping, and rate lookup live in `farmlands.js` today. Moving to Hub API requires rule validation, versioning, and cutover management.

**Sprint priority:** ⏳ **Defer to Phase 2** (Week 4–6, 3–4 hrs)  
**Action:** Document current freight.js rules; map to Hub's `/api/orders` validation logic; test migration path with Extension cutover.

---

### 8. KV is append-only; no edit/delete story
**Problem:** Cloudflare KV has no transactions. If an order needs to be edited or cancelled, you need versioning and audit trails. Roadmap doesn't address order rollback scenarios.

**Sprint priority:** ⏳ **Defer to Phase 2 (design Phase 1 as immutable)**  
**Action:** Design Phase 1 orders as immutable (create once, status-flag only). Phase 2 can add edit support once workflow is clear from live testing.  
**Note:** Live testing will reveal if immutable design is acceptable or if edits are critical.

---

### 9. Xero data model mismatch
**Problem:** Hub orders can have multiple ship-to branches; Xero invoices are single-destination. Hub packing slips are unique; Xero has no packing slip type. When does an order become an invoice?

**Sprint priority:** ✅ **Patch in Week 1** (2–3 hrs)  
**Action:** Map Hub order model to Xero invoice model; decide: one order → one or many invoices? Document mapping; validate against Xero API docs. This unblocks Phase 1 exit criteria.

---

### 10. No fallback to manual dispatch log if Hub fails
**Problem:** Today, if Make/Render fail, someone grabs a spreadsheet. If Hub fails, no offline mode or graceful degradation for warehouse operations.

**Sprint priority:** 📋 **Document in Week 1, implement in Phase 4**  
**Action:** Write a "manual override" SOP (order entry form, email fallback, reconciliation process). Don't code yet; Phase 4 work (Weeks 9–10).

---

## Sprint 1 Prioritization (Weeks 1–3)

**Can patch in one sprint (12–16 hrs):**

| Item | Effort | Impact | Owner | Status |
|------|--------|--------|-------|--------|
| #4 — Order schema | 1–2 hrs | 🔴 **CRITICAL** | Andrew | — |
| #1 — OAuth refresh | 2–3 hrs | 🔴 **HIGH** | Andrew | — |
| #9 — Xero mapping | 2–3 hrs | 🔴 **HIGH** | Andrew | — |
| #5 — Slip format research | 1–2 hrs | 🟠 **MEDIUM** | Andrew + Customers | — |
| #2 — Dedup logic | 2–3 hrs | 🟠 **MEDIUM** | Andrew | — |
| #3 — Extension fallback | 2–3 hrs | 🟠 **MEDIUM** | Andrew | — |

**Defer to Phase 2 or live testing:**

- #7 — Freight migration (Phase 2, Week 4–6)
- #8 — KV edit/delete (Phase 2, design immutable in Phase 1)
- #6 — Adoption plan (gather feedback during 4-week live test)
- #10 — Manual fallback (Phase 4, document SOP in Week 1)

---

## 4-Week Live Testing Gate (May 1–31)

**Warehouse + manager will test Phase 1 in live environment. This will resolve:**

- Adoption friction (#6) — Is the queue fast enough? Do staff actually use it?
- Immutable design (#8) — Do orders ever need to be edited? If yes, how often?
- Dedup process (#2) — Does the parallel Make + Hub reconciliation work in practice?
- Manual fallback (#3) — Does the extension fallback form get used? Often enough to justify keeping it?
- Schema gaps (#4) — Are there missing order fields that only appear in live use?

**Feedback loop:** Every week May 1–31, gather warehouse feedback. Adjust Phase 2 scope based on real behavior.

---

---

## Planned Features & Integrations (Phase 2+)

**These are new integrations/features requested for upcoming sprints. Mapped to logical phases based on dependency and user impact.**

### Courier label generation (Aramex / Post Haste / ShipStation)
**Phase:** 2–3 (warehouse queue + dispatch)  
**Effort:** Medium (3–4 hrs research + 4–6 hrs implementation)  
**Impact:** Eliminates manual courier label creation; integrates shipping into Hub workflow  
**Dependencies:** Requires order schema (#4) to be finalized; need API credentials for each carrier  
**Note:** One of the top warehouse pain-point wins. Should be prioritized high for Phase 2 once order model is stable.

---

### Email notifications for new Purchase Orders
**Phase:** 2–3 (warehouse queue + Phase 3 closing the loop)  
**Effort:** Low-medium (2–3 hrs, need email service like Resend/SendGrid)  
**Impact:** Alerts Andrew + warehouse staff when stock shipments arrive  
**Dependencies:** Requires `/imports` view (Phase 5) or a simpler "New PO" form; email service setup outside Cloudflare  
**Note:** Could land earlier in Phase 2 as a "notify when status changes" feature for orders generally.

---

### Reduce DocuPipe reliance
**Phase:** 2 or concurrent with Phase 1 (clarify current role)  
**Effort:** Unknown — depends on what DocuPipe currently does  
**Impact:** Cost savings, fewer dependencies, faster PDF processing  
**Dependencies:** Need to audit what DocuPipe handles (Xero PDF extraction? Invoice parsing? Something else?)  
**Action:** Before scoping this, document exactly what DocuPipe does today and what % of the pipeline it powers.

---

### PrintNode integration (auto-print packing slips)
**Phase:** 2–3 (warehouse queue)  
**Effort:** Low (1–2 hrs, PrintNode API is straightforward)  
**Impact:** Warehouse staff print slips with one click; reduces manual print-to-file step  
**Dependencies:** Requires packing slip HTML/PDF rendering (Phase 1) + warehouse printer setup  
**Note:** Nice-to-have for warehouse efficiency. Lower priority than label generation but quick win if Phase 1 slip view is stable.

---

### WooCommerce order ingestion
**Phase:** 2 or post-Phase 2  
**Effort:** Medium (3–4 hrs, depends on existing WooCommerce setup)  
**Impact:** Diversifies order sources beyond Farmlands; expands system to handle online store orders  
**Dependencies:** Requires order schema (#4) to accommodate WooCommerce field mapping; may need webhook receiver in Hub  
**Note:** New business stream? Or just testing? Clarify scope (1 store vs. multiple; single or multi-vendor).

---

### Calendar feature (tax reminders, payment dates, etc.)
**Phase:** 2 or post-Phase 5 (lower priority, administrative)  
**Effort:** Low-medium (2–3 hrs for basic calendar view)  
**Impact:** One-stop shop for business deadlines; currently probably in separate calendar/email  
**Dependencies:** None; could use config.json events or a simple KV-backed event list  
**Note:** Could land in Phase 2 as a "quick wins" feature if bandwidth exists. Low complexity but not business-critical to the ERP goal.

---

## Feature Prioritization Matrix

| Feature | Phase | Effort | Warehouse Impact | Strategic Fit | Must-Have? |
|---------|-------|--------|------------------|---------------|-----------|
| Courier labels | 2–3 | Med | 🔴 **HIGH** | Core dispatch | **YES** |
| Email notifications | 2–3 | Low–Med | 🟠 **MED** | Operational | Maybe |
| Reduce DocuPipe | 2 | Unknown | 🟠 **MED** | Cost/simplicity | Depends |
| PrintNode auto-print | 2–3 | Low | 🟠 **MED** | Warehouse UX | Nice-to-have |
| WooCommerce intake | 2+ | Med | 🟡 **VARIES** | New channel | Depends on scope |
| Calendar reminders | 2–5 | Low–Med | 🟡 **LOW** | Administrative | Nice-to-have |

---

## Notes

- **Bonus risk:** 36-hour Phase 1 budget is tight. OAuth, schema, and Xero mapping are critical path. If any of these slip, Phase 1 extends and later phases slide.
- **Live testing feedback:** May 1–31, warehouse will reveal which of these features matter most. Use that feedback to re-prioritize Phase 2.
- **Courier labels are a big win:** If you can integrate one carrier (Aramex or Post Haste) in Phase 2, that alone will make the warehouse much happier.
- **DocuPipe audit needed:** Before adding this to the backlog, understand exactly what it does. Is it PDF extraction? Xero invoice generation? Something else?
- **WooCommerce scope:** Clarify: are you adding one test store, or is this a full multi-channel expansion? Scope affects Phase 2 planning.

---

---

## Database Synchronization Strategy (KV Namespace Design)

**Critical Phase 1 architectural decision.** Three distinct KV namespaces, each with different access patterns:

### ORDERS_KV — Hot, write-heavy
**Access pattern:** Create on every order entry; read frequently during dispatch  
**Characteristics:** High write frequency, moderate read frequency, mutable (status flagging)  
**Retention:** Permanent (audit trail; never delete)  
**Seeding:** Created by Extension (Farmlands scrape), manual entry form, WooCommerce webhook  
**Schema:** Must be finalized in Week 1 (see consideration #4)  
**Sync concerns:**
- Dedup logic ensures no duplicate orders from parallel Make + Hub (Phase 1)
- Extension must POST to Hub with a unique order ID that Make can recognize for dedup (Phase 2)

---

### STORES_KV — Cold, reference data, semi-stable
**Access pattern:** Read on order creation (ship-to dropdown); read rarely (manual reference)  
**Characteristics:** Low write frequency (added/updated as new customers request multi-branch support), read-heavy  
**Retention:** Keep history for audit purposes (don't delete old stores, mark inactive)  
**Seeding:** Export from existing Google Sheet (store code, name, address, city, zone); manual updates as new branches open  
**Schema:** 
```json
{
  "stores": {
    "STORE_CODE": {
      "name": "Store Name",
      "address": "Street, City",
      "city": "City",
      "zone": "Freight zone code (FR-01, etc.)",
      "active": true,
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp"
    }
  }
}
```
**Sync concerns:**
- Extension reads from Hub `/api/locations` (Phase 2) instead of fetching Google Sheet directly
- Manual store updates (add a new branch) should trigger a re-export or API update
- Changes are infrequent enough that eventual consistency is acceptable (not real-time sync)

---

### ITEMS_KV — Cold, reference data, highly stable
**Access pattern:** Read on order line-item creation (product lookup, freight class, supplier, reorder lead-time)  
**Characteristics:** Very low write frequency (annual changes, seasonal variants), read-heavy  
**Retention:** Keep full history (SKU definitions change annually; need to trace which SKU definition was used for an order)  
**Seeding:** Export from existing Xero item list or supplier CSV; manual updates once/year at season change  
**Schema:**
```json
{
  "items": {
    "SKU_CODE": {
      "name": "Product Name",
      "supplier": "Supplier name",
      "freightClass": "Carton type (e.g., STANDARD, FRAGILE)",
      "reorderLeadDays": 42,
      "discontinued": false,
      "seasonalVariants": ["oct-mar", "apr-sep"],
      "lastUpdated": "ISO timestamp",
      "validFrom": "ISO timestamp",
      "validUntil": "ISO timestamp (null = current)"
    }
  }
}
```
**Sync concerns:**
- If a SKU is discontinued (e.g., old product), keep the record but mark `discontinued: true` and set an end date
- When an order is created, capture the item version as of that date (don't rely on live item lookup for historical accuracy)
- Annual season changes (e.g., new seasonal variant) should trigger a versioned update, not an overwrite

---

## KV Synchronization Rules & Concerns

### Write patterns
- **ORDERS_KV:** Write every time order created (Extension, manual form, WooCommerce webhook). Read on dispatch, status changes, log queries. **→ Expect 10–100+ writes/day**
- **STORES_KV:** Write 0–2 times/month (new branch, address update). Read 10–50 times/day (ship-to lookup). **→ Expect 0–2 writes/month, 10–50 reads/day**
- **ITEMS_KV:** Write 0–1 times/year (season change, new product). Read 5–50 times/day (line-item creation). **→ Expect 0–1 writes/year, 5–50 reads/day**

### Caching strategy
- **ORDERS_KV:** No caching; always fetch fresh from KV (orders are live operational data)
- **STORES_KV:** Cache in memory on Worker startup + refresh on manual update (data changes rarely, safe to cache)
- **ITEMS_KV:** Cache in memory on Worker startup + refresh on annual update (data is stable)

**Rationale:** Stores + Items are reference data. Caching reduces KV read operations (cost + latency) without sacrificing accuracy. Orders are operational; fresh reads are necessary.

### Seeding & versioning
- **Phase 1 immediate action:** Export current stores + items from Google Sheets/Xero and seed into KV as a one-time operation before live test (May 1)
- **Phase 2 automation:** Build an admin UI (or API endpoint) to update stores/items without direct KV access
- **Versioning for Items:** If an item changes (e.g., discontinued, new season), create a new versioned entry with `validFrom`/`validUntil` dates. Historical orders always link to the version active at order creation time.

### Sync between systems
- **Extension → Hub orders:** Extension must POST to `/api/orders` with the same unique order ID that Make webhook uses (dedup logic in Phase 1)
- **Extension → Hub stores:** Extension reads from Hub `/api/locations` (Phase 2), not from Google Sheet directly
- **Extension → Hub items:** Extension reads from Hub `/api/items` (Phase 2), not from farmlands.js CSV directly
- **Manual store/item updates:** Document the manual process (e.g., "export Google Sheet, POST to `/admin/stores`, KV is updated")

### Failure modes
- **STORES_KV unavailable:** Ship-to dropdown fails; warehouse can't create new orders. **Mitigation:** Cache stores in memory + fallback to free-text ship-to field
- **ITEMS_KV unavailable:** Item lookup fails; freight calculation fails. **Mitigation:** Cache items in memory + log warning, allow manual freight entry
- **ORDERS_KV unavailable:** System can't write orders at all. **Mitigation:** This is critical. No fallback; must have high availability (Cloudflare KV redundancy is automatic)

---

## Sprint 1 Action Items (Data layer)

| Task | Effort | Owner | Blocking |
|------|--------|-------|----------|
| Finalize ORDERS schema (consideration #4) | 1–2 hrs | Andrew | Everything |
| Design STORES schema + seeding process | 1–2 hrs | Andrew | Phase 2 location lookup |
| Design ITEMS schema + versioning logic | 1–2 hrs | Andrew | Phase 2 item lookup + freight logic |
| Export current stores from Google Sheet + seed into KV | 1 hr | Andrew | Phase 1 live testing (May 1) |
| Export current items from Xero/supplier CSV + seed into KV | 1 hr | Andrew | Phase 1 live testing (May 1) |
| **Total data layer setup:** | **5–6 hrs** | — | — |

---

## Notes

- **Caching is key:** Stores + Items are reference data; keeping them in Worker memory (with a refresh mechanism) will reduce latency and KV costs significantly.
- **Versioning matters:** If items change annually and orders are permanent records, you need to preserve which item version was used for each order. Don't overwrite; version.
- **Seeding is a one-time lift:** Getting stores + items into KV before May 1 live test is critical. After that, updates are rare enough to be manual.
- **Cost optimization:** Reference data caching will keep KV costs low (only writes matter for billing). Heavy write load (orders) is expected and acceptable.

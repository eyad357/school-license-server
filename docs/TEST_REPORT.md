# تقرير الاختبارات — نتائج فعلية

**البيئة:** Node v22.22.2 · PostgreSQL 16.15 محلية (قاعدة `license_test`) · لم يُتصل بأي قاعدة أو خدمة إنتاج.
**الحصيلة:** `npm test` = 24 ناجح / 0 فاشل · `npm run test:db` = 42 ناجح / 0 فاشل · **المجموع 66 ناجح، 0 فاشل، 0 متخطّى.**
(نفس الأمر يمكنك إعادة تشغيله: انظر `docs/LOCAL_RUN.md`.)

## مطابقة الاختبارات الخمسة عشر المطلوبة

| # | المطلوب | الاختبار الذي نفّذه |
|---|---|---|
| 1 | التفعيل/التحقق بنفس العقد الحالي | `activation-contract` #1 (يثبّت الجسم والرسائل حرفيًا، بما فيها شذوذ HTTP 400) + `migration` M4 على بيانات قديمة |
| 2 | رفض الترخيص الملغى | `activation-contract` #2 |
| 3 | إلغاء ترخيص لا يؤثر على مستقل | `activation-contract` #3 (مقارنة صف الترخيص والتفعيلات قبل/بعد) |
| 4 | سلامة إعادة التفعيل | `activation-contract` #4 |
| 5 | احترام حدود الأجهزة | `activation-contract` #5 (+ سباق 5 أجهزة على خانة واحدة: ينجح واحد فقط) |
| 6 | 100 ترخيص: تفرد المفاتيح والأرقام | `customer-numbers` #6 |
| 7 | 1000 ترخيص | `customer-numbers` #7 (عبر HTTP، جسم >50KB؛ ورفض 0 و1001 وقيم غير صالحة) |
| 8 | أسماء مسبقة / بلا أسماء | `customer-numbers` #8 |
| 9 | ثبات الرقم بعد التعديل | `customer-numbers` #9 (+ المشغّل في قاعدة البيانات يرفض تغييره) |
| 10 | عدم إعادة استخدام الأرقام | `customer-numbers` #10 (أرشفة **وحذف فعلي** لصف العميل) |
| 11 | أرقام فريدة تحت التزامن | `customer-numbers` #11 (10 دفعات متوازية + 20 إنشاءً بالمسار القديم: 320 رقمًا متصلة 1..320) |
| 12 | تعديل الاسم والسعر دون تغيير الترخيص/الأجهزة | `admin-api` #12 و12b (مقارنة بايت-ببايت لـ licenses/devices/activations) |
| 13 | بحث/ترتيب/تصدير XLSX وCSV | `admin-api` #13a–13d + `admin-ui` |
| 14 | فشل القاعدة، انقطاع، تكرار الطلبات | `bulk-reliability` #14a–14i |
| 15 | منع غير المصرح | `admin-api` #15 و15b (8 مسارات × 4 حالات رمز: لا رمز/تالف/منتهٍ/دور غير مدير) |

إضافة: `migration` M1–M9 (الترحيل على بنية الإنتاج الحالية) و`admin-ui` (4 اختبارات لكود اللوحة الحقيقي داخل jsdom).

## ما لم يُنفَّذ أو نُفِّذ بشكل مُحاكى (بصراحة)
- لا يوجد اختبار تعذّر تشغيله من الخمسة عشر.
- بند 14 «انقطاع الاتصال» **مُحاكى** بحقن أخطاء في اتصال الـ pool (بما فيها فشل `ROLLBACK` وعودة `ECONNREFUSED`)، لا بقطع شبكة فعلي.
- اختبارات الواجهة تتحقق من الربط بالـ API والتصدير والتأكيدات وتهريب HTML، وليس من الشكل البصري/RTL في متصفح حقيقي.
- لم تُفتح ملفات التصدير في Microsoft Excel نفسه (فُحصت بنيتها وأنواع خلاياها برمجيًا).
- لم يُجرَّ أي اختبار على Railway.

## المخرجات الخام لآخر تشغيل كامل
```
### npm test  (no database needed)
✔ sale price parsing is exact and strict (1.060915ms)
✔ price requires a currency; currency and date formats are checked (0.791295ms)
✔ names are normalised and bidi-spoofing characters are stripped (0.327669ms)
✔ formula neutralisation (0.159425ms)
✔ CSV output: BOM, CRLF, quoted text, exact money, empty cells (0.348335ms)
✔ search filters are parameterised and wildcards are escaped (0.301851ms)
✔ bulk request normalisation enforces the 1..1000 rules (0.763361ms)
✔ verifyWebhookSignature accepts a correctly signed body (1.740485ms)
✔ verifyWebhookSignature rejects a tampered body (0.271936ms)
✔ verifyWebhookSignature rejects wrong secret (0.154619ms)
✔ verifyWebhookSignature rejects malformed / missing header (0.087372ms)
✔ createTransaction always sends the configured price id and quantity 1, regardless of what is passed in (0.82792ms)
✔ createTransaction throws if Paddle omits checkout.url (no default payment link configured) (0.5663ms)
✔ getTransactionStatus reports price ids, quantity, status and order reference from Paddle, not the caller (0.872329ms)
✔ createOrder always uses the fixed lifetime/pro/1-device product regardless of caller input (1.255797ms)
✔ a completed transaction matching the configured price+quantity creates exactly one license (1.201045ms)
✔ an uncompleted transaction (ready) creates no license and leaves the order pending (0.862979ms)
✔ a canceled transaction marks the order failed, no license (0.333339ms)
✔ a completed transaction for the wrong price id is rejected, no license (0.284454ms)
✔ a completed transaction with quantity != 1 is rejected, no license (0.209218ms)
✔ duplicate webhook delivery for the same transaction creates only one license (0.454023ms)
✔ concurrent duplicate webhook deliveries for the same transaction still create only one license (0.480834ms)
✔ order-status only returns a license key once the order is paid, and never leaks secrets (0.566528ms)
✔ findOrderForCallback never creates a license and only reflects the DB status (0.368288ms)
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 331.589773

### npm run test:db  (real PostgreSQL 16, database license_test)
✔ 1. activate / validate / deactivate keep the exact existing response contract (219.486152ms)
✔ 2. a REVOKED license is rejected by activate and validate (59.227625ms)
✔ 3. revoking one license does not affect an independent license (61.905028ms)
✔ 4. reactivation works and keeps the registered devices (71.021639ms)
✔ 5. device limits are respected (also under concurrent activations) (88.429799ms)
✔ existing expiry behaviour is unchanged (expired status is stored on first use) (35.373144ms)
✔ 12. editing name / price / currency / notes never changes the license, devices or activations (280.04595ms)
✔ 12b. validation: bad prices / currencies / dates / names are refused and change nothing (115.986014ms)
✔ 13a. search by number / name / key (partial), sorting and pagination (175.36391ms)
✔ 13b. CSV export: Arabic is intact, quoting is right, formulas are neutralised, no secrets (70.846377ms)
✔ 13c. XLSX export opens correctly; numbers are numbers, text never becomes a formula (189.338237ms)
✔ 13d. export scopes: search results and a selection of rows (86.117635ms)
✔ 15. authorization: every new admin endpoint refuses missing / invalid / expired / non-admin tokens (103.201108ms)
✔ 15b. body-size handling: big bodies are checked for auth FIRST; other routes keep the 50kb limit (62.458436ms)
✔ UI: login, then create customers with names through the screen, see them in the table (372.106757ms)
✔ UI: clicking Create twice quickly sends one operation (same idempotency key) (194.313282ms)
✔ UI: search by number and Arabic partial name, sort, edit customer, export (1377.957303ms)
✔ UI: revoke asks for confirmation and really revokes; XSS in names is escaped (215.650068ms)
✔ 14a. the same request twice (double click / retry) creates the licenses only once (128.624058ms)
✔ 14b. six simultaneous identical requests create exactly one batch (78.63158ms)
✔ 14c. the same key with a different payload is rejected (409) and creates nothing (119.734306ms)
✔ 14d. a missing or malformed idempotency key is refused before anything is written (91.535078ms)
✔ 14e. a failure in the middle of creation leaves NOTHING behind and wastes no number (51.637362ms)
✔ 14f. a failure at COMMIT time saves nothing (48.409786ms)
✔ 14g. a dropped connection (even ROLLBACK fails) leaves no data and no stuck lock (54.03556ms)
✔ 14h. HTTP: database outage returns a generic error, leaks nothing, creates nothing, then recovers (64.917901ms)
✔ 14i. HTTP: two simultaneous identical POSTs (double click) create one batch (61.425148ms)
✔ 6. 100 licenses: keys and customer numbers are unique, numbers run 1..100 in order (137.997594ms)
# 1000 licenses created over HTTP in 172 ms
✔ 7. 1000 licenses via the HTTP API (large body) complete; 0 / 1001 are rejected (269.656984ms)
✔ 8. customers with pre-entered names and without names (92.007528ms)
✔ 9. the customer number never changes when name / price / notes are edited (74.648306ms)
✔ 10. numbers of archived or deleted customers are never reused (85.945601ms)
✔ 11. concurrent creation produces unique, gap-free numbers and unique keys (174.208651ms)
✔ M1. dry run (--plan) shows the numbering and saves NOTHING (101.052532ms)
✔ M2. apply: existing licenses, devices, activations are byte-identical; customers numbered by created_at (70.510519ms)
✔ M3. re-running the migration is a no-op (no renumbering) (13.472508ms)
✔ M4. the existing client contract still works on migrated legacy data (73.533057ms)
✔ M5. legacy license without a customer is visible, flagged incomplete, and can be completed explicitly (57.045751ms)
✔ M6. old code paths (single license creation / payment flow) keep working and get a number (6.761129ms)
✔ M7. a failing migration rolls back completely and leaves the database as it was (107.559437ms)
✔ M8. the runner refuses destructive SQL; migration 004 itself is clean (0.44785ms)
✔ M9. a brand-new database (schema.sql + 002 + 003 + 004) builds cleanly (62.603639ms)
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7835.217432
```

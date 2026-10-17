# خطة الرجوع للإصدار السابق

## لماذا الرجوع بسيط؟
الترحيل 004 **إضافي فقط** (أعمدة وجداول جديدة)، والكود القديم يعمل عليه كما هو. لذلك **الرجوع للكود لا يحتاج رجوعًا في قاعدة البيانات.**

## السيناريو أ — مشكلة في الكود الجديد بعد النشر (الأشيع)
1. Railway → Deployments → اختر النشر السابق (القديم) → إعادة نشره (Redeploy/Rollback حسب واجهة Railway الحالية).
   أو من Git: `git revert <commit>` أو إعادة النشر من الوسم `pre-customer-mgmt`.
2. لا تلمس قاعدة البيانات. الأعمدة الجديدة تُترك كما هي؛ العملاء الجدد في النظام القديم سيحصلون على رقم تلقائيًا.
3. تحقق: `/health` ثم برنامج Windows الخاص بك.

## السيناريو ب — فشل الترحيل أثناء التشغيل
لا شيء تفعله: كل شيء يتراجع تلقائيًا (معاملة واحدة). أصلح السبب وأعد `migrate:plan` ثم `migrate:apply`.

## السيناريو ج — تلف أو فقدان بيانات (نادر جدًا)
**لا تكتب فوق قاعدة الإنتاج الحالية.**
1. أنشئ خدمة Postgres جديدة: `pg_restore --no-owner -d <جديدة> prod-before-004.dump`.
2. تحقق من الأعداد كما في دليل النشر (الخطوة 2).
3. غيّر `DATABASE_URL` في الخدمة إلى القاعدة الجديدة وأعد النشر.
4. أبقِ القاعدة القديمة للفحص.
تنبيه: ما أُنشئ بعد أخذ النسخة (تفعيلات، تراخيص جديدة) لن يكون فيها. لذلك خذ نسخة جديدة مباشرة قبل أي إجراء، وراجع فرق البيانات.

## السيناريو د — إزالة الأعمدة الجديدة نهائيًا (غير موصى به)
لا حاجة له تقنيًا. إن أردته: افعله **على نسخة** أولًا. سيحذف أرقام العملاء وبيانات البيع المُدخلة بعد الترحيل (حذف حقيقي)، لذا خذ نسخة قبله:
```sql
BEGIN;
DROP TRIGGER IF EXISTS trg_customers_protect_customer_number ON customers;
ALTER TABLE customers ALTER COLUMN customer_number DROP DEFAULT;
ALTER TABLE customers DROP COLUMN customer_number, DROP COLUMN sale_price, DROP COLUMN currency,
  DROP COLUMN sold_at, DROP COLUMN notes, DROP COLUMN archived_at;
DROP FUNCTION IF EXISTS next_customer_number(), allocate_customer_numbers(integer), customers_protect_customer_number();
DROP TABLE IF EXISTS license_batches, customer_number_counter;
COMMIT;
```
(مقصود أن هذا النص **غير** مضمّن في ملف الترحيل: مشغّل الترحيل يرفض أي `DROP`.)

## ما لا يحتاج رجوعًا أبدًا
مفاتيح التفعيل، التراخيص، الأجهزة، حالات التفعيل، `payment_orders`: لا يلمسها الترحيل ولا الكود الجديد (يتحقق منها المشغّل ببصمة قبل/بعد، ويثبتها اختبار M2).

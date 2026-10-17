# إنشاء المفاتيح أولًا ثم تسجيل البيع لاحقًا

## سير العمل
1. **إنشاء دفعة**: اختر البرنامج، أدخل العدد (1–1000)، نوع/مدة الترخيص، والحد الأقصى للأجهزة، ثم «إنشاء الدفعة».
   لا توجد أسماء ولا أسعار ولا تواريخ عند الإنشاء. تظهر المفاتيح في جدول مع زر نسخ لكل مفتاح، ونسخ الكل، وتصدير الدفعة CSV/Excel.
2. **التوزيع والبيع**: توزّع المفاتيح بنفسك.
3. **تسجيل البيع**: افتح سجل المفتاح (اضغط رقم السجل أو الاسم) وسجّل: الاسم، الهاتف/البريد، السعر الفعلي، العملة، تاريخ البيع، حالة الدفع، الملاحظات.
   إدخال اسم/سعر/تاريخ يحوّل حالة البيع تلقائيًا إلى «مباع» (ويمكن تغييرها يدويًا).

## الحالات (منفصلة تمامًا)
| الحالة | القيم | أين تُخزَّن |
|---|---|---|
| البيع | غير مباع / مباع | `customers.sale_status` |
| الدفع | غير مدفوع / مدفوع / جزئي / غير محدد | `customers.payment_status` (لا يمكن «مدفوع/جزئي» لمفتاح غير مباع) |
| الترخيص | ACTIVE / REVOKED / EXPIRED | `licenses.status` (كما كان) |
| التفعيل | مفعّل / غير مفعّل (من الأجهزة النشطة) | محسوبة من `activations` |

تعديل بيانات البيع يكتب في جدول `customers` فقط؛ لا يلمس `licenses` ولا `devices` ولا `activations` (مثبت باختبار).

## API
* `POST /api/v1/admin/licenses/bulk` — الجسم: `productId, quantity, maxDevices, duration, plan`. الترويسة `Idempotency-Key` إلزامية.
  إرسال `customers` أو `defaults` يُرفض بـ 400 (لم يعد مدعومًا).
* `PATCH /api/v1/admin/customers/:idOrNumber` — الحقول: `name, email, phone, salePrice, currency, soldAt, notes, saleStatus, paymentStatus`.
* `GET /api/v1/admin/license-records` — فلاتر جديدة: `saleStatus, paymentStatus, activation (activated|not_activated), batchId`.
* `POST /api/v1/admin/export` — `scope`: `all | search | selected | unsold | sold`؛ الصيغة `csv | xlsx`.

## قاعدة البيانات
Migration `src/db/007_sale_status.sql` (إضافية فقط): أعمدة `sale_status`, `payment_status`, `phone` + قيود CHECK + فهرس.
التعبئة الأولية للسجلات القديمة: لديه اسم أو سعر أو تاريخ بيع ⇒ «مباع»، وإلا «غير مباع». حالة الدفع تبقى فارغة (لا تُخترع).
**شغّل 007 قبل نشر الكود الجديد** (الكود الجديد يقرأ الأعمدة الجديدة).

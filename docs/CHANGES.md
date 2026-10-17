# تقرير الملفات المتغيرة

الأسطر المذكورة تتجاهل فروق نهايات الأسطر (CRLF/LF) الموجودة أصلًا في عمل نسختك.

## جديد
| الملف | الغرض |
|---|---|
| `src/db/004_customer_management.sql` | ترحيل إضافي: رقم العميل الدائم، أعمدة البيع، عدّاد بلا فجوات، حماية الرقم من التعديل، جدول منع التكرار |
| `scripts/migrate.js` | مشغّل الترحيل: `--plan` (تجربة جافة) / `--apply`، معاملة واحدة، بصمة قبل/بعد، يرفض SQL المدمّر |
| `src/services/bulkLicenseService.js` | إنشاء 1–1000 ترخيص ذريًا مع idempotency |
| `src/services/customerService.js` | تعديل العميل/السعر، الأرشفة، استكمال بيانات ترخيص قديم |
| `src/services/licenseRecordService.js` | بحث/ترتيب/ترقيم صفحات (يخدم الجدول والتصدير بنفس الاستعلام) |
| `src/services/exportService.js` | XLSX وCSV مع تعطيل الصيغ وUTF-8 BOM |
| `src/routes/adminCustomerRoutes.js` | واجهات API الإدارية الجديدة (كلها خلف `requireAdmin`) |
| `src/lib/validation.js`, `src/lib/errors.js` | تحقق المدخلات وأخطاء HTTP |
| `test/db/*.test.js` (6 ملفات) + `test/db/helpers/setup.js` | 42 اختبارًا على PostgreSQL حقيقية مع حارس يمنع تشغيلها على غير قاعدة اختبار محلية |
| `test/customerManagement.unit.test.js` | 7 اختبارات وحدة بلا قاعدة |
| `docs/*`, `.env.example` | هذه الوثائق |

## معدّل
| الملف | التغيير |
|---|---|
| `src/index.js` | +31/−6: تركيب المسارات الجديدة؛ `module.exports = app` والاستماع فقط عند التشغيل المباشر؛ محلل JSON أكبر (1MB) **لمسارين إداريين فقط وبعد التحقق من المصادقة**؛ حد الطلبات قابل للضبط بالمتغير `API_RATE_LIMIT_MAX` (الافتراضي 100 كما كان) |
| `src/admin/public/index.html`, `app.js`, `style.css` | تطوير اللوحة الحالية (نفس الصفحة والمسارات): جدول جديد، بحث، فرز، ترقيم صفحات، إنشاء بالجملة، نافذة العميل، التصدير. محفوظ كما هو: الدخول، تعديل الترخيص، الأجهزة، الإلغاء/التفعيل/الحذف |
| `src/db/schema.sql` | −1 فاصلة زائدة (تصحيح خطأ صياغة، تغيير معزول) |
| `package.json` | سكربتات: `start`, `test:db`, `test:all`, `migrate:plan`, `migrate:apply`؛ اعتمادية `exceljs`؛ اعتمادية تطوير `jsdom` |
| `package-lock.json` | +211 حزمة؛ **لم يتغير إصدار أي حزمة موجودة** (فُحص بالمقارنة) |

## لم يُمسّ إطلاقًا (0 أسطر متغيرة، مُتحقَّق منه)
`licenseService.js`, `licenseRoutes.js` (التفعيل/التحقق/إلغاء التفعيل) · `adminLicenseService.js`, `adminRoutes.js` · `adminAuth.js` · `pool.js` · `002_customers.sql`, `003_payment_orders.sql` · كل ملفات الدفع · `scripts/create-license.js`.

## واجهات API الجديدة (`/api/v1/admin`، كلها تتطلب `Authorization: Bearer`)
| الطريقة | المسار | الوظيفة |
|---|---|---|
| GET | `/license-records?q&status&archived&incomplete&sort&dir&page&pageSize` | الجدول مع الملخص |
| GET | `/customers/:uuid-or-number` | تفاصيل العميل وتراخيصه |
| PATCH | `/customers/:ref` | الاسم، البريد، السعر، العملة، تاريخ البيع، الملاحظات |
| POST | `/customers/:ref/archive` · `/unarchive` | أرشفة/استعادة |
| POST | `/licenses/:id/assign-customer` | استكمال ترخيص بلا عميل |
| POST | `/licenses/bulk` (+ ترويسة `Idempotency-Key`) | إنشاء 1–1000 ترخيص |
| POST | `/export` | `{format: xlsx|csv, scope: all|search|selected}` |

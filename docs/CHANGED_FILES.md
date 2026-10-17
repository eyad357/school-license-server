# الملفات المعدّلة/المضافة في هذه المرحلة وأسبابها

## السيرفر
| الملف | التغيير | السبب |
|---|---|---|
| `src/db/005_products_platform.sql` (جديد) | وصف/حالة/تاريخ للبرنامج + حارس ثبات `product_id` | إدارة البرامج بترحيل إضافي |
| `src/services/productService.js` (جديد) | CRUD البرامج، التحقق، سياسة التعطيل | إدارة البرامج |
| `src/services/signingService.js` (جديد) | توقيع Ed25519 اختياري | استمرار العمل دون اتصال |
| `scripts/generate-signing-key.js` (جديد) | توليد زوج المفاتيح | تشغيل التوقيع |
| `src/routes/adminCustomerRoutes.js` | مسارات `/products` وفلتر الملخص | واجهة الإدارة |
| `src/services/adminLicenseService.js` | `productId` إلزامي، لا افتراضي؛ `fromPayment` | منع ترخيص بلا برنامج؛ الدفع يُصدر حتى لو عُطّل |
| `src/services/bulkLicenseService.js` | `productId` إلزامي والتحقق عبر `assertProductUsableForNewLicenses` | نفسه |
| `src/services/paymentService.js` | تمرير `fromPayment: true` | عميل دفع فعلًا |
| `src/services/licenseService.js` | منع تفعيل جهاز جديد على برنامج معطّل؛ إضافة `signedLicense` | سياسة التعطيل + التوقيع (حقل إضافي فقط) |
| `src/services/licenseRecordService.js`, `exportService.js` | فلتر `productId`، اسم البرنامج، عمود تصدير | فلترة/تقارير |
| `src/admin/public/{index.html,app.js,style.css}` | تبويب البرامج، قائمة اختيار إلزامية، فلتر وعمود | لوحة واحدة لعدة برامج |
| `scripts/migrate.js`, `package.json`, `.gitignore` | توثيق/أوامر 005، تجاهل `*.pem` | تشغيل آمن |
| `test/**` | اختبارات جديدة وتحديث القديمة (انظر التقرير) | |
| `docs/*` | أدلة جديدة (MULTI_PRODUCT, API_CONTRACT, HYBRID_LICENSING, DEPLOY_V2_RAILWAY, RISKS_V2, TEST_REPORT_V2) | |

## Windows (راجع أيضًا `COMPAT_REPORT.md` في مشروع Windows)
| الملف | التغيير |
|---|---|
| `package.json` | `productName` الأعلى = `school systme` (مسار userData المباع) |
| `electron/license/config.js` | `resolveLicenseDir` (هجرة قراءة فقط) و`getPublicKeys` |
| `electron/license/store.js` | كتابة ذرية + `.bak` + تقليل الكتابة |
| `electron/license/{signature,signedStore,publicKeys}.js` (جديد) | التحقق من التوقيع/تخزينه/المفتاح العام (فارغ) |
| `electron/license/service.js` | استرجاع من الترخيص الموقّع، انتهاء محلي للمؤقت، ساعة رتيبة، إصلاح `deactivated` |
| `electron/license/deviceId.js` | كتابة ذرية |
| `electron/main/main.js` | يتفاعل مع `local-expiry` |
| `build/installer.nsh` | حماية مجلد الشواهد أثناء الترقية |
| `compat-tests/` | أداة اختبار التوافق ونتائجها |

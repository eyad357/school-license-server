# عقد الـAPI بين السيرفر وعميل Windows (قديم / جديد)

لم يتغير أي مسار أو اسم حقل أو قيمة `status` أو كود HTTP في مسارات العميل. التغيير الوحيد: حقل اختياري جديد `signedLicense` يُضاف فقط حين يُضبط مفتاح التوقيع على السيرفر.

| المسار (POST /api/v1/licenses/…) | الطلب | النجاح | الفشل |
|---|---|---|---|
| `/activate` | `{licenseKey, deviceId, productId?}` (`productId` الافتراضي `school-accreditation`) | **HTTP 200** + `{status:"active", message, expiresAt, activationRef, signedLicense?}` | HTTP 400 + `status`: `invalid` / `revoked` / `expired` / `device_limit_reached` |
| `/validate` | نفسه | **HTTP 200** + `{status:"active", …}` | `invalid` (غير مفعّل على هذا الجهاز / مفتاح غير موجود / برنامج مختلف) · `revoked` · `expired` |
| `/deactivate` | نفسه | **HTTP 200** + `{status:"deactivated", activationRef}` | `invalid` |
| أي مسار | خطأ داخلي | HTTP 500 + `{status:"SERVER_ERROR"}` | |
| تجاوز الحد (100/دقيقة/IP) | | | HTTP 429 نص عادي (ليس JSON) |

## كود HTTP عند النجاح
- مطابق لآخر commit في الريبو القديم ("Fix license API success HTTP status"): النجاح = **200** للثلاثة، والفشل = 400. العملاء v3/v4 يقرؤون `status` من الجسم أولًا فيقبلون 200 كما كانوا يقبلون 400 سابقًا (مُختبر بـ e2e).

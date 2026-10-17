# التحديث إلى v4.2 داخل هذا الريبو — خطوات وتراجع

## قبل الرفع (إلزامي)
1. نسخة احتياطية من قاعدة الإنتاج: `pg_dump -Fc "$DATABASE_URL" -f prod-before.dump` (من جهازك، واحفظها خارج الريبو؛ `*.dump` مُتجاهَل في git).
2. تأكد من Railway: Settings → Service: الفرع المراقب (غالبًا `main`)، Start Command (الريبو القديم لم يكن فيه `start`؛ الآن أضفنا `"start": "node src/index.js"`)، Root Directory = جذر الريبو.
3. متغيرات مطلوبة (لا تغيّر القائمة الحالية، فقط تأكد): `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`. اختيارية: `TRUST_PROXY`, مفاتيح التوقيع (اختياري).

## الترتيب الآمن
أ) **الهجرات أولًا (الكود القديم يعمل معها لأنها إضافية):** من جهازك على قاعدة الإنتاج
```
$env:DATABASE_URL = "<رابط القاعدة العام>"
node scripts/migrate.js --plan src/db/004_customer_management.sql
node scripts/migrate.js --apply src/db/004_customer_management.sql
... كرر plan ثم apply لـ 005 ثم 006 ثم 007، وراجع «Protected tables identical»
```
ب) ثم `git add -A; git commit; git push origin main` → Railway ينشر تلقائيًا.
ج) تحقق: `GET /health` = 200، دخول لوحة الإدارة، تفعيل/تحقق بمفتاح اختبار، وتجربة عميل Windows مثبّت واحد.

## الرجوع
- الكود: `git revert <commit>` ثم push (أو Redeploy للنشر السابق من Railway).
- القاعدة: لا تُلغى الهجرات (أعمدة/جداول إضافية؛ اختُبر أن كود القديم يعمل عليها). الاستعادة من الـ dump فقط كحل أخير.

## ما اختُبر محليًا (لا Railway ولا الإنتاج)
انظر `TEST-RESULTS.md`.

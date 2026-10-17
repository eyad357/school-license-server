# دليل التشغيل المحلي (خطوة بخطوة)

> كل ما يلي على جهازك فقط. لا يلمس Railway ولا قاعدة الإنتاج.

## 1) المتطلبات
- Node.js 20 أو أحدث (اختُبر على 22).
- PostgreSQL 14 أو أحدث (اختُبر على 16). أسهل طريقة بدون تثبيت:
  ```
  docker run --name lic-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 -d postgres:16
  ```

## 2) قاعدتان منفصلتان (تطوير + اختبار)
```
psql -h 127.0.0.1 -p 5433 -U postgres -c "CREATE DATABASE school_license_dev"
psql -h 127.0.0.1 -p 5433 -U postgres -c "CREATE DATABASE school_license_test"
```

## 3) التثبيت والإعداد
```
npm ci
copy .env.example .env        # (PowerShell/cmd)   أو: cp .env.example .env
```
عدّل `.env`:
- `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/school_license_dev`
- `ADMIN_PASSWORD_HASH`: `node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "كلمة-مرور-قوية"`
- `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## 4) بناء قاعدة التطوير (بنية الإنتاج الحالية ثم الترحيل الجديد)
```
psql "postgres://postgres:postgres@127.0.0.1:5433/school_license_dev" -v ON_ERROR_STOP=1 -f src/db/schema.sql -f src/db/002_customers.sql -f src/db/003_payment_orders.sql
npm run migrate:plan      # تجربة جافة: تعرض الترقيم ثم تتراجع، لا تحفظ شيئًا
npm run migrate:apply     # التطبيق الفعلي
# ثم بالترتيب: 005 و006 و007 (حالة البيع/الدفع) — كلٌّ منها plan ثم apply:
npm run migrate:plan:005 && npm run migrate:apply:005
npm run migrate:plan:006 && npm run migrate:apply:006
node scripts/migrate.js --plan  src/db/007_sale_status.sql
node scripts/migrate.js --apply src/db/007_sale_status.sql
```
> `schema.sql` كان فيه خطأ صياغة (فاصلة زائدة) صُحّح بحرف واحد، فصار قابلًا للتشغيل على قاعدة فارغة.

## 5) التشغيل
```
npm start                 # = node src/index.js
```
افتح `http://localhost:3100/admin` وسجّل الدخول.

## 6) الاختبارات
```
npm test                  # 24 اختبارًا بدون قاعدة بيانات
```
PowerShell:
```
$env:TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/school_license_test"
npm run test:db           # 42 اختبارًا على PostgreSQL حقيقية
```
bash:
```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/school_license_test npm run test:db
```
الاختبارات تحذف وتعيد بناء مخطط `public` في قاعدة الاختبار، وترفض العمل على أي قاعدة غير محلية أو لا يحتوي اسمها على `test`.

## 7) تجربة الترحيل على نسخة من بياناتك الحقيقية (موصى به)
استعد نسخة احتياطية في قاعدة محلية مؤقتة ثم جرّب:
```
psql ... -c "CREATE DATABASE restore_check"
pg_restore --no-owner -d "postgres://postgres:postgres@127.0.0.1:5433/restore_check" backup.dump
# PowerShell: $env:DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5433/restore_check"
npm run migrate:plan
```
راجع الأرقام المقترحة لكل عميل قبل اعتماد أي شيء على الإنتاج.

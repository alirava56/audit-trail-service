# راهنمای فارسی اجرای Audit Trail API در ویندوز

## پیش‌نیاز

Node.js نسخه **24.22.3 یا نسخه امنیتی جدیدتر از شاخه 24 LTS** پیشنهاد می‌شود. حداقل نسخهٔ پشتیبانی‌شده 22.16.0 است که در آن SQLite داخلی هنوز آزمایشی است.

در PowerShell از داخل پوشه پروژه:

```powershell
node -v
npm -v
Copy-Item .env.example .env
```

## ساخت دو کلید امن

دستور زیر را **دو بار** اجرا کن و هر خروجی را در یکی از فیلدهای `AUDIT_WRITE_KEY` و `AUDIT_READ_KEY` داخل `.env` قرار بده:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

این دو کلید نباید یکسان باشند. مقادیر نمونه `REPLACE_WITH...` معتبر نیستند. فایل `.env` را در GitHub قرار نده.

## اجرا

```powershell
npm ci
node --env-file=.env src/server.js
```

سرویس پیش‌فرض: `http://127.0.0.1:3000`

در یک Terminal جدید:

```powershell
# بررسی سلامت (بدون کلید)
Invoke-RestMethod http://127.0.0.1:3000/health/live

# برای ارسال یک رویداد، کلید واقعی موجود در .env را بگذار
$writeKey = 'WRITE_KEY_HERE'
$headers = @{ Authorization = "Bearer $writeKey"; 'Idempotency-Key' = 'demo-event-001' }
$body = @{ eventType='auth.login'; actorId='user_42'; outcome='success'; metadata=@{ method='passkey' } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/v1/events -Headers $headers -ContentType 'application/json' -Body $body

# دریافت فهرست: کلید READ مجزا لازم است
$readKey = 'READ_KEY_HERE'
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/v1/events?limit=10' -Headers @{ Authorization = "Bearer $readKey" }
```

## تست مستقل (بدون تنظیم `.env`)

```powershell
npm test
npm run test:coverage
npm run smoke
npm run e2e:disk
npm run check
```

تست‌های API یک سرور آزمایشی روی پورت تصادفی بالا می‌آورند و دیتابیس را در حافظه ایجاد می‌کنند؛ کلیدها را هم در تست تولید می‌کنند.

## بررسی زنجیره و بکاپ

پس از ثبت رویداد در دیتابیس واقعی:

```powershell
npm run verify -- --db .\data\audit.sqlite
npm run backup -- --db .\data\audit.sqlite --out .\backups\audit-backup.sqlite
npm run verify -- --db .\backups\audit-backup.sqlite

# ایجاد مرجع قابل اعتماد برای تشخیص حذف/بازنویسی تاریخچه
npm run checkpoint -- --db .\data\audit.sqlite --out .\backups\weekly.checkpoint.json
# فایل بالا را در یک محل مستقل، محافظت‌شده و خارج از سرور اصلی نگهداری کن.
# پس از بازگرداندن کپی مورد اعتماد، آن را با دیتابیس بررسی کن:
npm run verify -- --db .\data\audit.sqlite --checkpoint .\backups\weekly.checkpoint.json
```

## انتشار در GitHub

در GitHub یک Repository **Public** با نام `audit-trail-api` بساز. گزینه‌های README، `.gitignore` و License را در صفحه ساخت Repo فعال نکن، چون پروژه این فایل‌ها را دارد.

```powershell
git init
git add .
git commit -m "feat: build append-only audit trail API with integrity verification"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/audit-trail-api.git
git push -u origin main
```

قبل از Push با `git status` و `git ls-files` بررسی کن که `.env`، کلیدها و فایل دیتابیس وارد Git نشده باشند. نشان CI در README را با نام کاربری واقعی خودت جایگزین کن **بعد از** آنکه Workflow در GitHub اجرا شد و نتیجه‌اش مشخص شد.

## محدودیت امنیتی مهم

این سرویس به‌صورت پیش‌فرض فقط روی `127.0.0.1` گوش می‌دهد. اگر از سرور خارجی استفاده می‌کنی، بدون HTTPS و کنترل دسترسی شبکه سرویس را عمومی نکن. تغییر نام پروژه، یا وجود SHA-256 به معنی تضمین غیرقابل‌دست‌کاری بودن داده یا اخذ گواهی امنیتی نیست.

## محدودیت تعداد رویدادها و کنترل سلامت

`AUDIT_MAX_EVENTS` در `.env` به‌صورت پیش‌فرض `100000` است. وقتی ظرفیت پر شود، API برای رویداد جدید `507` و برای `/health/ready` پاسخ `503` می‌دهد؛ پاک‌کردن دستی تاریخچه روش پشتیبانی‌شده‌ای نیست. با برنامه آرشیو و نسخه‌گذاری یک پایگاه داده جدید بساز.

اختیاری: پس از قرار دادن یک Checkpoint **معتبر و محافظت‌شده** در مسیر فقط‌خواندنی، `AUDIT_TRUSTED_CHECKPOINT_PATH` را تنظیم کن تا سرور در زمان راه‌اندازی بر اساس آن بررسی کند. اگر فایل کنار دیتابیس و تحت اختیار همان مهاجم باشد، جلوی جعل تاریخچه را نمی‌گیرد.

ورودی JSON با کلید تکراری یا UTF-8 نامعتبر پذیرفته نمی‌شود. اگر دیتابیس توسط یک اتصال بیرونی دست‌کاری شود، API به‌صورت Fail-Closed خطای `503` می‌دهد؛ پیش از بازیابی سرویس، علت را بررسی و نسخه قابل‌اعتماد را بازیابی کن.

## دقت عددی JSON

شناسه‌های طولانی تراکنش و اعداد مالی دقیق را به شکل **رشته JSON** بفرست (`"9007199254740993"`)، نه Number. عددهای خارج از محدوده صحیح امن جاوااسکریپت از سوی API با 400 رد می‌شوند؛ عددهای اعشاری معمولی همچنان از نوع IEEE-754 هستند و برای Decimal دقیق مناسب نیستند.

## Docker

پس از ساخت `.env` و نصب Docker:

```powershell
docker build -t audit-trail-api .
docker volume create audit-trail-data
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env -e AUDIT_HOST=0.0.0.0 -e AUDIT_DB_PATH=/data/audit.sqlite -v audit-trail-data:/data audit-trail-api
```

**مهم:** دو override فوق ضروری‌اند، چون `.env` مخصوص اجرای محلی است. برای بررسی آماده بودن، `http://127.0.0.1:3000/health/ready` را باز کن. در محیط عمومی بدون TLS و کنترل دسترسی شبکه اجرا نکن.

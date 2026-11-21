# گزارش تاریخی نسخه ۱.۰.۰ — منسوخ

**این گزارش به نسخه قبل از اصلاحات تعلق دارد. برای ارزیابی نهایی به `FINAL-REPORT-FA.md` مراجعه کنید. اعداد ۴۵ تست و GO قدیمی مبنای انتشار نسخه جدید نیستند.**

# گزارش نهایی ممیزی و تحویل — Audit Trail API

**تاریخ:** ۲۱ نوامبر ۲۰۲۶  
**دامنه:** پروژه مستقل Audit Trail API با Node.js و SQLite  
**وضعیت:** آماده انتشار به‌عنوان نمونه‌کار GitHub، با محدودیت‌های مستند؛ آمادگی Production و امنیت مطلق ادعا نمی‌شود.

## ۱. طراحی مهندسی

- قرارداد API با روش‌های `POST /v1/events`، `GET /v1/events` و `GET /v1/events/{id}`.
- کلیدهای جداگانه خواندن/نوشتن؛ `serviceId` از تنظیمات سرور، `actorId` ادعای سرویس احرازشده است.
- SQLite با Transaction و `BEGIN IMMEDIATE`، دو Trigger منع UPDATE/DELETE، WAL و همگام‌سازی FULL.
- زنجیره SHA-256 با Canonical JSON و امکان Offline Verification فقط‌خواندنی.
- توقف راه‌اندازی سرویس در صورت تشخیص مغایرت زنجیره موجود.
- Idempotency مبتنی بر Service + Key + Payload Digest و پاسخ 409 برای تضاد.
- فیلترهای پارامتری و Cursor Pagination؛ محدودیت محتوا و Metadata.
- پشتیبان‌گیری آنلاین از SQLite به‌جای کپی خام فایل فعال WAL.
- خطاهای ساختاریافته، لاگ حداقلی بدون اطلاعات حساس، خاموشی کنترل‌شده و مستندات امنیتی.

## ۲. ساختار پروژه

- `src/`: هسته دامنه، اعتبارسنجی، اتصال SQLite، HTTP و Lifecycle.
- `tests/`: تست Unit، Integration روی HTTP واقعی، Transaction، Tamper، Backup و CLI.
- `scripts/`: Smoke Test، Offline Verifier، Backup و Benchmark.
- `docs/`: معماری، تهدیدها، ADR و OpenAPI 3.1.
- `Dockerfile`، `package-lock.json` و GitHub Actions.

## ۳. شواهد اجرا در محیط ساخت

**محیط:** Linux؛ Node.js `v22.16.0`، npm `10.9.2`، SQLite داخلی Node (در Node 22 با هشدار Experimental).

| کنترل | نتیجه |
|---|---|
| `npm ci --offline --ignore-scripts` | PASS — بدون وابستگی خارجی |
| `npm run check` | PASS — بررسی Syntax + Test + Smoke |
| `npm test` | PASS — **۴۵ تست موفق، صفر شکست** |
| `npm run smoke` | PASS — نوشتن، خواندن و Verification از طریق HTTP |
| `npm run test:coverage` | PASS — پوشش اندازه‌گیری شد |
| اجرای سرور مستقل با `.env` و فایل SQLite | PASS — درخواست واقعی نوشتن/خواندن و SIGTERM بدون خطا |
| `npm run verify -- --db ...` | PASS — بررسی زنجیره ذخیره‌شده |
| `npm run backup -- --db ... --out ...` | PASS — بکاپ SQLite و تأیید زنجیره بکاپ |
| `npm run benchmark` | PASS — آزمایش صرفاً محلی و در حافظه؛ نه بنچمارک Production |
| اجرای GitHub Actions روی GitHub | **NOT VERIFIED** — نیازمند Push و مشاهده اجرا |
| Docker build و اجرای کانتینر | **NOT VERIFIED** — Docker در محیط ساخت وجود نداشت |
| ممیزی امنیتی مستقل / تست نفوذ | **NOT VERIFIED** — انجام نشده |

### پوشش اندازه‌گیری‌شده در فایل‌های اصلی

| فایل | پوشش خطی | پوشش شاخه |
|---|---:|---:|
| `src/api.js` | 92.36% | 89.09% |
| `src/config.js` | 91.84% | 88.46% |
| `src/domain.js` | 97.44% | 89.47% |
| `src/store.js` | 98.97% | 92.45% |

در این اندازه‌گیری، کل فایل‌های پروژه شامل اسکریپت‌ها و تست‌ها: **97.19% پوشش خطی و 91.78% پوشش شاخه**. عدد پوشش به معنی نبود باگ یا امنیت قطعی نیست.

### Benchmark محلی اجراشده

- ۳۰۰ درخواست POST؛ Concurrency = ۱۰؛ SQLite در حافظه؛ بدون خطا.
- حدود ۱۰۵۳ درخواست/ثانیه در همین اجرای محیط ساخت.
- Latency: p50 حدود 7.86 ms، p95 حدود 14.02 ms و p99 حدود 39.48 ms.
- خروجی می‌تواند بین اجراها و سیستم‌ها متفاوت باشد؛ برای استقرار واقعی و فایل SQLite، این اعداد قابل تعمیم نیستند.

## ۴. ریسک‌ها و محدودیت‌های مهم

1. **عدم وجود TLS داخلی:** استقرار عمومی مستلزم TLS در Reverse Proxy، محدودسازی شبکه و مدیریت کلیدهاست.
2. **هویت کاربر:** `actorId` توسط سرویس نویسنده ارائه می‌شود و به‌صورت مستقل احراز هویت کاربر نهایی نشده است.
3. **دست‌کاری مدیر دیتابیس:** شخص صاحب دسترسی کامل دیتابیس می‌تواند Triggerها و تمام هش‌ها را بازنویسی کند. برای کشف بازنویسی یا حذف بخش انتهایی، Checkpoint بیرونی مورد اعتماد ضروری است.
4. **SQLite همگام:** برای بار کاری کوچک یا متوسط روی یک سرور مناسب‌تر است. Multi-region، High Availability و Rate Limiting توزیع‌شده پیاده نشده‌اند.
5. **مدیریت داده:** Redaction خودکار، سیاست Retention، آرشیو قانونی و حذف مطابق درخواست‌های حریم خصوصی پیاده نشده‌اند؛ درج Metadata حساس توصیه نمی‌شود.
6. **API SQLite در Node 22:** پیام Experimental نمایش می‌دهد؛ استفاده از Node 24.15+ پیشنهاد شده، ولی اجرای مستقل Node 24 و Container در این محیط تأیید نشده است.

## ۵. نتیجه Gateها

| Gate | ارزیابی |
|---|---|
| قرارداد API و صحت ورودی‌ها | PASS (طبق تست‌های محلی) |
| Append-only و SQLite Triggers | PASS (طبق تست‌های محلی) |
| Idempotency، Transaction، Concurrency و Recovery | PASS (طبق تست‌های محلی) |
| ساختار پروژه و مستندات | PASS (بازبینی ایستا) |
| Reproducible npm Install | PASS (در Node 22.16.0) |
| CI GitHub Actions | NOT VERIFIED |
| Docker | NOT VERIFIED |
| امنیت استقرار واقعی و Penetration Test | NOT VERIFIED |

**حکم:** `GO — GITHUB PORTFOLIO READY` با توجه به شواهد تست محلی و محدودیت‌های فوق. `PRODUCTION READY` ادعا نمی‌شود.

## ۶. دستورهای بازبینی بعد از استخراج ZIP

```bash
npm ci
npm run check
npm run test:coverage
npm run benchmark
```

برای راه‌اندازی واقعی، `.env.example` را به `.env` تبدیل کرده و دو کلید تصادفی ۳۲بایتی متفاوت بسازید. سپس `node --env-file=.env src/server.js` را اجرا کنید. فایل `.env` و دیتابیس نباید در Git commit شوند.

# Face Shelf

เครื่องมือจัดการรูปสินค้าจาก Facebook Page Post พร้อมสถานะขายแล้วและ Art-work

ระบบรันบน Cloudflare Workers, เก็บข้อมูลใน D1 และเก็บ Page Access Token แบบเข้ารหัส

## เริ่มใช้งานในเครื่อง

ต้องมี Node.js 18 ขึ้นไป

```bash
npm install
cp .dev.vars.example .dev.vars
```

กรอกค่าใน `.dev.vars`:

```env
FACEBOOK_APP_ID=your_app_id
FACEBOOK_APP_SECRET=your_new_app_secret
FACEBOOK_REDIRECT_URI=http://localhost:4173/auth/facebook/callback
TOKEN_ENCRYPTION_KEY=ใส่ค่าสุ่มที่ยาวและคาดเดาไม่ได้
```

สร้าง encryption key ได้ด้วย:

```bash
openssl rand -base64 32
```

สร้างฐานข้อมูล local และเปิดเว็บ:

```bash
npm run db:local
npm run dev
```

เปิด `http://localhost:4173`

บน macOS สามารถดับเบิลคลิก `Start Face Shelf.command` หลังจากติดตั้งและสร้างฐานข้อมูล local แล้ว

## Deploy ไป Cloudflare Workers

1. Login Cloudflare:

```bash
npx wrangler login
```

2. สร้าง D1:

```bash
npx wrangler d1 create face-shelf-db
```

นำ `database_id` ที่ได้ไปแทน `replace-with-d1-database-id` ใน `wrangler.jsonc`

3. สร้างตารางบน D1:

```bash
npm run db:remote
```

4. ตั้งค่า Secrets โดยใช้ App Secret ใหม่เท่านั้น:

```bash
npx wrangler secret put FACEBOOK_APP_ID
npx wrangler secret put FACEBOOK_APP_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

5. Deploy:

```bash
npm run deploy
```

6. เพิ่ม URL ต่อไปนี้ใน Meta App Dashboard > Facebook Login > Valid OAuth Redirect URIs:

```text
https://face-shelf.<account-subdomain>.workers.dev/auth/facebook/callback
```

หากใช้ Custom Domain ระบบจะสร้าง Redirect URI จาก domain ปัจจุบันอัตโนมัติ

## การย้ายข้อมูลเดิม

หลัง Login Facebook ครั้งแรก หน้าเว็บจะย้ายรายการจาก Local Storage เดิมเข้า D1 อัตโนมัติ แล้วลบสำเนาใน Local Storage เมื่อย้ายสำเร็จ

## Facebook permissions

ระบบใช้:

- `pages_show_list`
- `pages_read_engagement`

Graph API version ตั้งค่าใน `wrangler.jsonc` ผ่าน `FB_GRAPH_VERSION`

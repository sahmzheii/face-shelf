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
MESSENGER_VERIFY_TOKEN=ตั้งค่าเป็นข้อความสุ่มสำหรับยืนยัน webhook
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
npx wrangler secret put MESSENGER_VERIFY_TOKEN
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

## Facebook permissions

ระบบใช้:

- `pages_show_list`
- `pages_read_engagement`
- `pages_messaging`
- `business_management` สำหรับดึง Page ที่อยู่ใน Business Portfolio

## Messenger webhook

ตั้ง Callback URL ใน Meta App เป็น:

```text
https://<domain>/webhooks/messenger
```

ใช้ค่าเดียวกับ `MESSENGER_VERIFY_TOKEN` และ subscribe ฟิลด์ `messaging_referrals`, `messaging_postbacks` กับ Page
ผู้ใช้ใหม่อาจต้องกด **Get Started** ใน Messenger ก่อน ระบบจึงจะได้รับ referral และตอบรูปสินค้าได้

Graph API version ตั้งค่าใน `wrangler.jsonc` ผ่าน `FB_GRAPH_VERSION`

## Event pages

สร้าง Event จากเมนูซ้าย ระบุชื่อและรายละเอียด แล้วเพิ่ม/เอาสินค้าออกผ่านเมนู ⋯ ของสินค้า
เลือก Event ในเมนูซ้ายเพื่อจัดการสินค้า แก้รายละเอียด ลบ Event หรือเปิดหน้าสาธารณะ `/stocks/event/{event_id}`
หน้าสาธารณะแสดงสินค้าใน Event ทั้งพร้อมขายและขายแล้ว การลบ Event ไม่ลบสินค้าในร้าน

ฐานข้อมูลเดิมต้องเพิ่มตารางก่อนใช้งาน (เลือก environment ที่ต้องการ):

```bash
npx wrangler d1 execute face-shelf-db --local --file=./migrations/0001_events.sql
npx wrangler d1 execute face-shelf-db --remote --file=./migrations/0001_events.sql
```

ฐานข้อมูลใหม่ใช้ `schema.sql` ได้ตามปกติ

Event รองรับข้อความ badge (`tag`), สีข้อความ (`tagColor`), สีพื้นหลัง (`tagBackgroundColor`)
และรายละเอียด Markdown พร้อมรูปภาพ `![คำบรรยาย](https://example.com/image.jpg)` และ Preview Markdown ก่อนบันทึก
หน้าสาธารณะ Event เริ่มด้วย Markdown ตรงกลาง และไม่มีตัวกรองแยกโพสต์

ฐานข้อมูลที่มีตาราง Event อยู่แล้วให้รัน migration ต่อไปนี้หนึ่งครั้ง ก่อนใช้เวอร์ชันนี้:

```bash
npx wrangler d1 execute face-shelf-db --local --file=./migrations/0002_event_details.sql
npx wrangler d1 execute face-shelf-db --remote --file=./migrations/0002_event_details.sql
```

## รูปจากเครื่องสำหรับ Event

ปุ่ม **ใส่รูปจากเครื่อง** รองรับ JPEG, PNG และ WebP ขนาดต้นฉบับไม่เกิน 10 MB
รูปที่เกิน 200 KB จะถูกแปลงเป็น WebP และปรับคุณภาพให้ได้ไม่เกิน 200,000 bytes โดยคงความกว้าง–สูงต้นฉบับ
รูปที่เล็กกว่าอยู่แล้วใช้ไฟล์เดิม หากบีบอัดถึงคุณภาพต่ำสุดแล้วยังเกินขนาด ระบบจะแจ้งข้อผิดพลาดและไม่อัปโหลด
การคงความละเอียดหมายถึงจำนวนพิกเซลเท่าเดิม คุณภาพหรือความคมชัดอาจลดลงตามการบีบอัด
รูปจะถูกแทรกเป็น Markdown ที่ตำแหน่งเคอร์เซอร์ และเผยแพร่เมื่อบันทึก Event
พื้นที่สูงสุด 100 MB หรือ 500 รูปต่อร้าน นับรวมรูปที่รอลบ

### การเก็บและลบรูป

- เก็บไฟล์ใน R2 ส่วน D1 เก็บเจ้าของและรายการ Event ที่อ้างอิงรูป
- รูปอัปโหลดใหม่ที่ไม่ได้บันทึกหมดอายุหลัง 24 ชั่วโมง รวมกรณีปิดฟอร์มหรืออัปโหลดขัดข้อง
- เมื่อเอารูปออกจาก Markdown หรือลบ Event จะเริ่มนับ 24 ชั่วโมง หากไม่มี Event อื่นอ้างอิงรูป
- นำรูปกลับมาใช้ภายในระยะพักจะยกเลิกการลบ รองรับการใช้รูปเดียวกันหลาย Event ของร้านเดียวกัน
- Cron ตรวจทุกชั่วโมง ลบครั้งละไม่เกิน 100 รูป เวลาลบจริงขึ้นกับรอบตรวจและจำนวนรูปในคิว
- ก่อนลบจะอ้างสิทธิ์การลบใน D1 และตรวจว่าไม่มี Event ใช้อยู่ ป้องกันชนกับการบันทึก Event
- ลบ object ใน R2 ก่อนลบ metadata ใน D1 หากลบไม่สำเร็จเก็บสถานะไว้ให้รอบถัดไปลองใหม่
- ลบข้อมูล Page จะยังเก็บ metadata รูปไว้ชั่วคราวเพื่อให้ตามไปลบ object ใน R2 ได้ครบ
- รูป draft ดูได้เฉพาะเจ้าของร้าน รูปที่บันทึกใน Event แล้วเปิดดูสาธารณะได้
- ลบเฉพาะรูปที่ระบบนี้อัปโหลดเข้า R2 ไม่แตะรูปบน Facebook หรือลิงก์รูปภายนอก

### เปิดใช้บน production

เปิดใช้ R2 ใน Cloudflare Dashboard ของบัญชีก่อน แล้วสร้าง bucket และเพิ่มตาราง:

```bash
npx wrangler r2 bucket create face-shelf-event-images
npx wrangler d1 execute face-shelf-db --remote --file=./migrations/0003_event_images.sql
npm run deploy
```

`wrangler.jsonc` กำหนด binding `EVENT_IMAGES` และ Cron รายชั่วโมงไว้แล้ว
Local ใช้ `npx wrangler d1 execute face-shelf-db --local --file=./migrations/0003_event_images.sql`
หรือใช้ `schema.sql` สำหรับฐานข้อมูลใหม่ จากนั้น `npm run dev` จะใช้ R2 local

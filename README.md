# Face Shelf

เว็บ local สำหรับดึงรูปสินค้าจาก Facebook Page Post และจัดการสถานะ sold out

## เริ่มใช้งาน

ต้องมี Node.js 18 ขึ้นไป

```bash
cp .env.example .env
set -a && source .env && set +a
npm start
```

เปิด `http://localhost:4173`

บน macOS สามารถดับเบิลคลิก `Start Face Shelf.command` เพื่อเปิด server และหน้าเว็บอัตโนมัติ

สถานะ sold out และรายการที่นำเข้าจะเก็บใน `localStorage` ของ browser

สามารถกด “ตั้งค่า Facebook API” ที่มุมซ้ายล่างของหน้าเว็บแล้วกรอก token ผ่าน GUI ได้ Token แบบนี้จะเก็บเฉพาะในหน่วยความจำและหายเมื่อปิด server

เมื่อกด Mark sold out ระบบจะบันทึกสถานะในเว็บและเปิด Facebook Photo ของสินค้าชิ้นนั้นใน popup เพื่อให้แก้ caption ได้ทันที

## Facebook

ตั้งค่า `FB_ACCESS_TOKEN` เป็น Page Access Token จากนั้นวางลิงก์โพสต์ Facebook หรือ Post ID รูปแบบ `PageID_PostID` ในหน้าต่างนำเข้า

### Login with Facebook

เพิ่มค่าต่อไปนี้ใน `.env`:

```env
FACEBOOK_APP_ID=your_app_id
FACEBOOK_APP_SECRET=your_app_secret
FACEBOOK_REDIRECT_URI=http://localhost:4173/auth/facebook/callback
```

ใน Meta App Dashboard เพิ่ม Redirect URI เดียวกันใน Facebook Login settings จากนั้นแอดมินสามารถกด Login with Facebook และเลือก Page ได้โดยไม่ต้องคัดลอก Token

กำหนด Graph API version ผ่าน `FB_GRAPH_VERSION` ได้ โดยไม่ต้องแก้ source code

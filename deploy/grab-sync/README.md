# GP1 Grab Crane Sync Agent

แพ็กเกจนี้ติดตั้งบน Raspberry Pi ของระบบ Grab Crane เพื่ออ่านข้อมูลจาก
`GreenPower_1.grab_data` ผ่าน PHP PDO และส่งไป GP1 Connect ผ่าน HTTPS ทุก 5 นาที

## สิ่งที่ระบบทำ

- อ่านฐานข้อมูลอย่างเดียว ไม่แก้ไขระบบชั่งเดิม
- ใช้ `grab_data.id` ป้องกันข้อมูลซ้ำ
- เริ่มต้นย้อนหลัง 7 วัน ไม่ดึงประวัติทั้งหมดโดยไม่ตั้งใจ
- จำรายการล่าสุดและลองใหม่อัตโนมัติเมื่ออินเทอร์เน็ตขัดข้อง
- ตรวจย้อนหลังทุกชั่วโมงเพื่อสะท้อนรายการที่แก้ไขหรือลบ
- แยกวันตาม `create_date` ของฐานข้อมูลในเขตเวลา Asia/Bangkok

## เตรียม GP1 Connect

1. สร้าง Token อย่างน้อย 32 ตัวอักษร เช่น `openssl rand -hex 32`
2. เพิ่ม Environment Variable บน Render:
   - `GRAB_SYNC_DEVICE_ID=grab-pi-1`
   - `GRAB_SYNC_TOKEN=<token ที่สร้าง>`
3. Deploy GP1 Connect เวอร์ชันที่มี `/api/device/grab-sync`

ห้ามใส่ Token ลง Git หรือส่งผ่านแชตสาธารณะ

## เตรียม MariaDB

ใช้ `create-readonly-user.sql.example` สร้างบัญชี `gp1sync` ที่อ่านได้เฉพาะ
`GreenPower_1.grab_data` อย่าใช้บัญชีฐานข้อมูลหลักของระบบ Grab

## ติดตั้งบน Raspberry Pi

แตก ZIP แล้วรันจากโฟลเดอร์นี้:

```bash
sudo sh install.sh
sudo nano /etc/gp1-grab-sync.ini
```

กรอก Database Password และ Token จาก Render จากนั้นทดสอบหนึ่งครั้ง:

```bash
sudo systemctl start gp1-grab-sync.service
sudo journalctl -u gp1-grab-sync.service -n 50 --no-pager
```

ถ้าขึ้นว่า Sync สำเร็จ ให้เปิดทำงานอัตโนมัติ:

```bash
sudo systemctl enable --now gp1-grab-sync.timer
systemctl list-timers gp1-grab-sync.timer
```

## ปิดระบบชั่วคราว

```bash
sudo systemctl disable --now gp1-grab-sync.timer
```

การปิด Timer ไม่กระทบเว็บไซต์ Grab Crane หรือฐานข้อมูลเดิม

// ไปรษณีย์ไทย: ขอเลขพัสดุ / preload จ่าหน้า / เช็คสถานะ
// ENV (Vercel): THP_USER, THP_PASS, FIREBASE_SERVICE_ACCOUNT
// พฤติกรรมคงเดิมกับโค้ดที่เคยอยู่ใน App.jsx — ย้ายมาแค่ตำแหน่งที่เก็บ credential
import { adminDb, allowPost, requireUser } from './_lib/auth.js';

const basic = () =>
  'Basic ' + Buffer.from(`${process.env.THP_USER}:${process.env.THP_PASS}`).toString('base64');
const clip = (v, n) => String(v ?? '').slice(0, n);
const TRACKING_RE = /^[A-Za-z0-9]{8,20}$/;

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (!['Owner', 'Admin', 'Staff'].includes(user.role)) {
    return res.status(403).json({ error: 'ไม่มีสิทธิ์ทำรายการนี้' });
  }

  const body = req.body || {};
  try {
    // ---- ขอเลขพัสดุ ----
    if (body.action === 'tracking') {
      const type = ['1', '2'].includes(String(body.type)) ? String(body.type) : '1';
      const r = await fetch(`https://postone.thailandpost.com/api/bc.php?typ=${type}&cnt=1`, {
        headers: { Authorization: basic() },
      });
      if (!r.ok) return res.status(502).json({ error: 'ไปรษณีย์ไทยไม่ตอบสนอง' });
      const text = (await r.text()).trim();
      if (!TRACKING_RE.test(text)) return res.status(502).json({ error: 'รูปแบบเลขพัสดุไม่ถูกต้อง' });
      return res.json({ trackingNumber: text.toUpperCase() });
    }

    // ---- preload ข้อมูลจ่าหน้า ----
    if (body.action === 'preload') {
      const trackingNum = String(body.trackingNum || '');
      if (!TRACKING_RE.test(trackingNum)) return res.status(400).json({ error: 'เลขพัสดุไม่ถูกต้อง' });
      const o = body.order || {};
      const ownerSnap = await adminDb.doc(`users/${user.ownerId}`).get();
      const store = ownerSnap.exists ? ownerSnap.data() : {};

      const tokRes = await fetch('https://pus2.thailandpost.com/redbox/auth/app/token', {
        method: 'POST',
        headers: { Authorization: basic() },
      });
      const tok = await tokRes.json();
      if (tok.detail !== 'ok' || !tok.token) return res.json({ ok: false });

      const payload = {
        data: [{
          tracking: trackingNum,
          serv: 1,
          itm: (Array.isArray(o.items) ? o.items.slice(0, 50).map((i) => clip(i, 200)).join(', ') : '') || 'สินค้าทั่วไป',
          cod_amount: o.isCOD ? String(Number(String(o.codAmount).replace(/,/g, '')) || 0) : '0',
          fr_name: store.storeName || 'SmartLabel Shop',
          fr_tel: store.phone || '0888888888',
          fr_address: store.address || 'กรุงเทพมหานคร',
          fr_district: '-',
          fr_postcode: ((store.address || '').match(/\b\d{5}\b/) || ['10000'])[0],
          fr_country_iso: 'TH',
          det_name: clip(o.customerName, 120),
          det_tel: clip(o.phone, 20),
          det_address: clip(o.address, 500),
          det_district: '-',
          det_postcode: clip(o.zipcode, 5),
          det_country_iso: 'TH',
        }],
      };
      const r = await fetch('https://pus2.thailandpost.com/redbox/items/preload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await r.json();
      return res.json({ ok: result.detail === 'ok' });
    }

    // ---- เช็คสถานะพัสดุ (คงรูปแบบคำขอเดิมไว้ทุกอย่าง) ----
    if (body.action === 'status') {
      const trackingNum = String(body.trackingNum || '');
      if (!TRACKING_RE.test(trackingNum)) return res.status(400).json({ error: 'เลขพัสดุไม่ถูกต้อง' });
      const r = await fetch('https://trackapi.thailandpost.co.th/post/api/v1/track', {
        method: 'POST',
        headers: { Authorization: basic(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackNumber: [trackingNum], language: 'TH' }),
      });
      const result = await r.json();
      const status = result?.response?.items?.[trackingNum]?.[0]?.status_description || null;
      return res.json({ status });
    }

    return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  } catch (e) {
    console.error('thp api error:', e);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
}

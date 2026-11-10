// ตัวช่วยกลางสำหรับ API route: ตรวจ Firebase ID Token และอ่านสิทธิ์ผู้ใช้จาก Firestore
// ขึ้นต้นด้วย _ จึงไม่ถูก Vercel เปิดเป็น endpoint
// ถ้า api/webhook.js ของคุณ init firebase-admin อยู่แล้ว ให้ใช้วิธีเดียวกัน (ตัวแปร env ชื่อเดียวกัน)
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export const adminDb = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;

export function allowPost(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return false;
  }
  return true;
}

// คืน { uid, email, role, ownerId, data } หรือ null (และตอบ error ให้แล้ว)
export async function requireUser(req, res) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    return null;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const snap = await adminDb.doc(`users/${decoded.uid}`).get();
    if (!snap.exists) {
      res.status(403).json({ error: 'ไม่พบบัญชีผู้ใช้ในระบบ' });
      return null;
    }
    const data = snap.data();
    return {
      uid: decoded.uid,
      email: decoded.email || '',
      role: data.role,
      ownerId: data.ownerId || decoded.uid,
      data,
    };
  } catch (e) {
    res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    return null;
  }
}

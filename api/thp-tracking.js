export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { type = '1' } = req.body;
    const username = process.env.THP_USERNAME;
    const password = process.env.THP_PASSWORD;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const response = await fetch(`https://postone.thailandpost.com/api/bc.php?typ=${type}&cnt=1`, {
      method: 'GET',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }
    });

    if (!response.ok) throw new Error('API Blocked or Error');
    const data = await response.text();
    res.status(200).json({ trackingNum: data.trim() });
  } catch (error) {
    console.error("THP Tracking API Error:", error);
    // Fallback แบบเดิมเมื่อ API ล่ม
    const randomNum = Math.floor(100000000 + Math.random() * 900000000);
    let fallbackNum = `TH${randomNum}TH`;
    if (req.body.type === '1') fallbackNum = `ED${randomNum}TH`;
    if (req.body.type === '2') fallbackNum = `RC${randomNum}TH`;
    res.status(200).json({ trackingNum: fallbackNum, fallback: true });
  }
}
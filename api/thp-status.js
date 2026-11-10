export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { trackingNum } = req.body;
    const username = process.env.THP_USERNAME;
    const password = process.env.THP_PASSWORD;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const response = await fetch(`https://trackapi.thailandpost.co.th/post/api/v1/track`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ "trackNumber": [trackingNum], "language": "TH" })
    });

    const result = await response.json();
    const status = result.response.items[trackingNum][0].status_description || 'Preloaded';
    res.status(200).json({ status });
  } catch (error) {
    console.error("THP Status API Error:", error);
    res.status(200).json({ status: 'Preloaded', error: true });
  }
}
import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

// นำเข้า Firebase (ตรวจสอบว่าไฟล์ firebase.js ของพาร์ทเนอร์ export ตัวแปรเหล่านี้ไว้แล้ว)
import { auth, db } from './firebase'; 
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  signOut 
} from "firebase/auth";

// --- ฟังก์ชันสกัดข้อความ (Core Engine เหมือนเดิม) ---
const extractOrderData = (rawText) => {
  if (!rawText) return null;
  const cleanText = rawText.replace(/-/g, '');
  const zipMatch = cleanText.match(/\b\d{5}\b/);
  const zipcode = zipMatch ? zipMatch[0] : '';
  const phoneMatch = cleanText.match(/\b0\d{8,9}\b/);
  const phone = phoneMatch ? phoneMatch[0] : '';

  let isCOD = false;
  let codAmount = '';
  const codRegex = /(?:cod|ปลายทาง|เก็บเงินปลายทาง|ยอด)\s*[:=]?\s*([\d,]+)/i;
  const codMatch = cleanText.match(codRegex);
  if (codMatch) {
    isCOD = true;
    codAmount = codMatch[1];
  }
  
  let remainingText = cleanText;
  if (zipcode) remainingText = remainingText.replace(zipcode, '');
  if (phone) remainingText = remainingText.replace(phone, '');
  if (codMatch) remainingText = remainingText.replace(codMatch[0], ''); 
  
  const lines = remainingText.split('\n').map(line => line.trim()).filter(line => line !== '');
  let customerName = '';
  let addressLines = [];
  let items = [];
  const itemRegex = /(x\s*\d+|\d+\s*(ตัว|ชิ้น|กล่อง|ใบ|คู่|ชุด|แพ็ค|ขวด|ซอง))/i;

  lines.forEach((line, index) => {
    if (itemRegex.test(line)) {
      items.push(line); 
    } else if (index === 0) {
      customerName = line; 
    } else {
      addressLines.push(line); 
    }
  });

  const address = addressLines.join(' ').trim();
  let warnings = [];
  if (!phone) warnings.push(isCOD ? "⚠️ ไม่มีเบอร์โทร (COD บังคับ!)" : "⚠️ ไม่มีเบอร์โทรศัพท์");
  if (!zipcode) warnings.push("⚠️ ไม่มีรหัสไปรษณีย์");
  if (cleanText.trim() !== '') {
    if (!/(ต\.|ตำบล|แขวง)/.test(cleanText)) warnings.push("⚠️ ขาด ตำบล/แขวง");
    if (!/(อ\.|อำเภอ|เขต)/.test(cleanText)) warnings.push("⚠️ ขาด อำเภอ/เขต");
  }

  return { customerName, phone, address, zipcode, items, isCOD, codAmount, warnings };
};

// --- ข้อมูลจำลอง Dashboard ---
const mockWeeklyData = [{ name: '20 เม.ย.', โอนเงิน: 15, COD: 5 }, { name: '21 เม.ย.', โอนเงิน: 20, COD: 10 }, { name: '22 เม.ย.', โอนเงิน: 18, COD: 8 }, { name: '23 เม.ย.', โอนเงิน: 25, COD: 12 }, { name: '24 เม.ย.', โอนเงิน: 30, COD: 15 }, { name: '25 เม.ย.', โอนเงิน: 22, COD: 20 }, { name: '26 เม.ย.', โอนเงิน: 40, COD: 25 }];
const mockPieData = [{ name: 'โอนเงินแล้ว', value: 170 }, { name: 'เก็บเงินปลายทาง', value: 95 }];
const COLORS = ['#22c55e', '#f97316'];

export default function App() {
  // --- States หลัก ---
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState('Owner'); // จำลองว่าเป็น Owner ไว้ก่อน
  const [loading, setLoading] = useState(true);
  
  const [activeTab, setActiveTab] = useState('maker'); 
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({ name: 'ToppySmart Logistics', phone: '087-448-4448', address: '123/48 ม.5 ต.หอรัตนไชย อ.พระนครศรีอยุธยา' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  // --- 1. ติดตามสถานะการล็อกอิน ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
      // ในอนาคตเราจะดึง Role จาก Firestore ที่นี่ครับ
    });
    return () => unsubscribe();
  }, []);

  // --- 2. ฟังก์ชัน Login / Logout ---
  const handleLogin = async (e) => {
    e.preventDefault();
    const email = e.target.email.value;
    const password = e.target.password.value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      alert("อีเมลหรือรหัสผ่านไม่ถูกต้องครับพาร์ทเนอร์");
    }
  };

  const handleLogout = () => {
    signOut(auth);
  };

  // --- ฟังก์ชันจัดการออเดอร์ (เหมือนเดิม) ---
  const handleTextChange = (id, newText) => {
    let updatedOrders = orders.map(order => {
      if (order.id === id) {
        const parsed = newText.trim() !== '' ? extractOrderData(newText) : null;
        return { ...order, rawText: newText, parsedData: parsed };
      }
      return order;
    });
    const lastOrder = updatedOrders[updatedOrders.length - 1];
    if (lastOrder.rawText.trim() !== '') {
      updatedOrders.push({ id: Date.now(), rawText: '', parsedData: null });
    }
    setOrders(updatedOrders);
  };

  const handleDeleteOrder = (id) => {
    const remainingOrders = orders.filter(order => order.id !== id);
    setOrders(remainingOrders.length === 0 ? [{ id: Date.now(), rawText: '', parsedData: null }] : remainingOrders);
  };

  const handleFocus = (id) => {
    if (labelRefs.current[id]) {
      labelRefs.current[id].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleSaveProfile = () => {
    setStoreProfile(tempProfile);
    localStorage.setItem('smartlabel_profile', JSON.stringify(tempProfile));
    setIsSettingsOpen(false);
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center">กำลังโหลดระบบ...</div>;

  // --- 3. หน้าจอ Login (แสดงถ้ายังไม่ล็อกอิน) ---
  if (!user) {
    return (
      <div className="min-h-screen bg-blue-900 flex items-center justify-center p-6 font-sans">
        <div className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-extrabold text-blue-800 mb-2">📦 SmartLabel</h1>
            <p className="text-gray-500 italic">"จ่าหน้าอัจฉริยะ เพื่อมืออาชีพเช่นคุณ"</p>
          </div>
          <form onSubmit={handleLogin}>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-2">อีเมลผู้ใช้งาน</label>
              <input name="email" type="email" required className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none" placeholder="admin@toppysmart.com" />
            </div>
            <div className="mb-6">
              <label className="block text-sm font-bold text-gray-700 mb-2">รหัสผ่าน</label>
              <input name="password" type="password" required className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none" placeholder="••••••••" />
            </div>
            <button type="submit" className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded-lg transition-all shadow-lg transform hover:scale-[1.02]">
              เข้าสู่ระบบบริหารจัดการ
            </button>
          </form>
          <div className="mt-8 text-center text-xs text-gray-400">
            SmartLabel V1.0 - พัฒนาโดยพาร์ทเนอร์ & CTO
          </div>
        </div>
      </div>
    );
  }

  // --- 4. หน้าจอหลัก (แสดงเมื่อล็อกอินแล้ว) ---
  return (
    <div className="min-h-screen bg-gray-100 p-6 font-sans print:bg-white print:p-0 relative">
      
      {/* Modal ตั้งค่าร้านค้า */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
            <h2 className="text-2xl font-bold mb-4 text-gray-800">⚙️ ตั้งค่าข้อมูลร้านค้า</h2>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-1">ชื่อร้านค้า (ผู้ส่ง)</label>
              <input type="text" className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400 focus:outline-none" value={tempProfile.name} onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})} />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-1">เบอร์โทรศัพท์</label>
              <input type="text" className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400 focus:outline-none" value={tempProfile.phone} onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})} />
            </div>
            <div className="mb-6">
              <label className="block text-sm font-bold text-gray-700 mb-1">ที่อยู่ร้านค้า</label>
              <textarea className="w-full border border-gray-300 p-2 rounded h-24 resize-none focus:ring-2 focus:ring-blue-400 focus:outline-none" value={tempProfile.address} onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})} />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setIsSettingsOpen(false)} className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition font-bold">ยกเลิก</button>
              <button onClick={handleSaveProfile} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition font-bold">💾 บันทึกข้อมูล</button>
            </div>
          </div>
        </div>
      )}

      {/* Header พร้อมปุ่ม Logout */}
      <header className="mb-6 bg-white p-4 rounded-lg shadow-sm print:hidden">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-3xl font-bold text-blue-800 flex items-center gap-2">
              📦 SmartLabel <span className="text-sm bg-blue-100 text-blue-600 px-2 py-1 rounded-full">{userRole}</span>
            </h1>
            <p className="text-gray-600 text-sm">แอดมิน: {user.email}</p>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex bg-gray-100 p-1 rounded-lg">
              <button onClick={() => setActiveTab('maker')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'maker' ? 'bg-white text-blue-600 shadow' : 'text-gray-500'}`}>✍️ สร้างจ่าหน้า</button>
              {userRole === 'Owner' && (
                <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow' : 'text-gray-500'}`}>📊 สถิติ</button>
              )}
            </div>
            <button onClick={handleLogout} className="bg-red-50 hover:bg-red-100 text-red-600 px-4 py-2 rounded-lg font-bold text-sm transition-all">ออกจากระบบ 🚪</button>
          </div>
        </div>

        <div className="flex justify-between items-center bg-blue-50 p-3 rounded border border-blue-100">
          <div className="text-sm text-blue-800">
            <span className="font-bold italic text-blue-600">Wallet: ฿2,540</span> | <span className="font-bold">ร้าน:</span> {storeProfile.name}
          </div>
          <button onClick={() => setIsSettingsOpen(true)} className="text-xs bg-white border border-blue-200 text-blue-600 px-3 py-1 rounded hover:bg-blue-100 font-bold">⚙️ ตั้งค่าร้านค้า</button>
        </div>
      </header>

      {/* แสดงเนื้อหาตาม Tab */}
      {activeTab === 'maker' ? (
        <div className="flex flex-col md:flex-row gap-6 print:block">
           {/* ... โค้ดส่วน Label Maker เหมือนเดิมทุกประการ ... */}
           <div className="flex-1 bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500 max-h-[70vh] overflow-y-auto print:hidden">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">1. วางข้อความแชต</h2>
            {orders.map((order, index) => (
              <div key={order.id} className="mb-6 relative group border-b pb-4 border-gray-100">
                <div className="flex justify-between items-end mb-1">
                  <label className="block text-sm font-bold text-gray-500">ออเดอร์ที่ {index + 1}</label>
                  {(order.rawText !== '' || orders.length > 1) && (
                    <button onClick={() => handleDeleteOrder(order.id)} className="text-red-400 hover:text-red-600 text-sm font-bold transition flex items-center gap-1">🗑️ ลบ</button>
                  )}
                </div>
                <textarea className={`w-full h-32 p-4 border rounded-md focus:outline-none focus:ring-2 resize-none transition-all ${order.parsedData ? (order.parsedData.warnings.length > 0 ? 'border-red-400 bg-red-50 focus:ring-red-500' : 'border-green-400 bg-green-50 focus:ring-green-500') : 'border-gray-300 focus:ring-blue-400'}`} placeholder="วางชื่อ ที่อยู่..." value={order.rawText} onChange={(e) => handleTextChange(order.id, e.target.value)} onFocus={() => handleFocus(order.id)} />
              </div>
            ))}
          </div>
          <div className="flex-1 bg-gray-50 p-6 rounded-lg shadow-inner border-2 border-dashed border-gray-300 max-h-[70vh] overflow-y-auto print:bg-white print:border-none print:block">
             {/* Preview ด้านขวา เหมือนเดิม */}
             <div className="flex justify-between items-center mb-4 print:hidden">
               <h2 className="text-xl font-semibold text-gray-800">2. ตรวจสอบและสั่งพิมพ์</h2>
               <button onClick={() => window.print()} className="bg-green-500 hover:bg-green-600 text-white font-bold py-1 px-4 rounded-md shadow-md flex items-center gap-2">🖨️ สั่งพิมพ์</button>
            </div>
            {orders.filter(o => o.parsedData).map((order) => (
              <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm mx-auto mb-8 bg-white border-2 border-black p-4 print:break-after-page">
                 {/* ... รายละเอียดจ่าหน้า ... */}
                 <div className="flex justify-between border-b pb-2 mb-2 font-bold"><span>SmartLabel ✅</span><span>Admin: {user.email.split('@')[0]}</span></div>
                 <div className="mb-4">
                   <p className="text-xs text-gray-500">ผู้ส่ง:</p>
                   <p className="font-bold text-sm">{storeProfile.name}</p>
                 </div>
                 {order.parsedData.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold">COD: {order.parsedData.codAmount}</div>}
                 <div className="bg-gray-100 p-2 mb-2">
                   <p className="text-xs text-blue-600 font-bold">ผู้รับ:</p>
                   <p className="text-xl font-bold">{order.parsedData.customerName}</p>
                   <p className="text-lg">{order.parsedData.phone}</p>
                   <p className="text-sm">{order.parsedData.address}</p>
                 </div>
                 <div className="text-center text-4xl font-black mb-4">{order.parsedData.zipcode}</div>
                 <div className="flex flex-col items-center border-t pt-4">
                   <QRCodeSVG value={JSON.stringify({ id: order.id, cod: order.parsedData.codAmount, admin: user.email })} size={100} />
                 </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-purple-500">
           <h2 className="text-2xl font-bold mb-6">ภาพรวมธุรกิจ (Owner Dashboard)</h2>
           <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
             <div className="bg-green-50 p-6 rounded-xl border border-green-100">
               <h3 className="text-green-600 font-bold">ยอดเงินคงเหลือ (Wallet)</h3>
               <p className="text-4xl font-black text-green-900">฿2,540.00</p>
               <button className="mt-4 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-bold">➕ เติมเงิน</button>
             </div>
             {/* กราฟสถิติ เหมือนเดิม */}
             <div className="md:col-span-2 h-64 border p-4 rounded-xl">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={mockWeeklyData}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="name"/><YAxis/><Tooltip/><Bar dataKey="โอนเงิน" fill="#22c55e"/><Bar dataKey="COD" fill="#f97316"/></BarChart>
                </ResponsiveContainer>
             </div>
           </div>
        </div>
      )}
    </div>
  );
}
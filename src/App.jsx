import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

// --- ฟังก์ชันสกัดข้อความ (อัปเกรดเรดาร์ทะลวงพิกัด ทนทานต่อการพิมพ์บรรทัดเดียว) ---
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
  
  // --- ระบบตรวจจับและสร้างคำเตือน (เวอร์ชัน 2.0 ทนทานกว่าเดิม) ---
  let warnings = [];
  if (!phone) warnings.push(isCOD ? "⚠️ ไม่มีเบอร์โทร (COD บังคับ!)" : "⚠️ ไม่มีเบอร์โทรศัพท์");
  if (!zipcode) warnings.push("⚠️ ไม่มีรหัสไปรษณีย์");
  
  // ตรวจสอบจาก cleanText ทั้งก้อน ป้องกันการพิมพ์ติดกันบรรทัดเดียว
  if (cleanText.trim() !== '') {
    if (!/(ต\.|ตำบล|แขวง)/.test(cleanText)) warnings.push("⚠️ ขาด ตำบล/แขวง");
    if (!/(อ\.|อำเภอ|เขต)/.test(cleanText)) warnings.push("⚠️ ขาด อำเภอ/เขต");
    // แจ้งเตือนเพิ่มถ้าพิมพ์ติดกันหมดจนไม่มีการแยกบรรทัด
    if (address === '') warnings.push("⚠️ ควรเคาะ Enter แยกชื่อ กับ ที่อยู่");
  }

  return { customerName, phone, address, zipcode, items, isCOD, codAmount, warnings };
};

// --- ข้อมูลจำลองสำหรับ Dashboard ---
const mockWeeklyData = [
  { name: '20 เม.ย.', โอนเงิน: 15, COD: 5 },
  { name: '21 เม.ย.', โอนเงิน: 20, COD: 10 },
  { name: '22 เม.ย.', โอนเงิน: 18, COD: 8 },
  { name: '23 เม.ย.', โอนเงิน: 25, COD: 12 },
  { name: '24 เม.ย.', โอนเงิน: 30, COD: 15 },
  { name: '25 เม.ย.', โอนเงิน: 22, COD: 20 },
  { name: '26 เม.ย.', โอนเงิน: 40, COD: 25 },
];
const mockPieData = [
  { name: 'โอนเงินแล้ว', value: 170 },
  { name: 'เก็บเงินปลายทาง', value: 95 },
];
const COLORS = ['#22c55e', '#f97316'];

export default function App() {
  const [activeTab, setActiveTab] = useState('maker'); 
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({
    name: 'ระบุชื่อร้านค้าของคุณ',
    phone: '08X-XXX-XXXX',
    address: 'ระบุที่อยู่ร้านค้า...'
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  useEffect(() => {
    const savedProfile = localStorage.getItem('smartlabel_profile');
    if (savedProfile) {
      setStoreProfile(JSON.parse(savedProfile));
    }
  }, []);

  const handleSaveProfile = () => {
    setStoreProfile(tempProfile);
    localStorage.setItem('smartlabel_profile', JSON.stringify(tempProfile));
    setIsSettingsOpen(false);
  };

  const handleOpenSettings = () => {
    setTempProfile({ ...storeProfile });
    setIsSettingsOpen(true);
  };

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

  const handlePrint = () => window.print();

  return (
    <div className="min-h-screen bg-gray-100 p-6 font-sans print:bg-white print:p-0 relative">
      
      {/* Modal ตั้งค่าร้านค้า */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
            <h2 className="text-2xl font-bold mb-4 text-gray-800">⚙️ ตั้งค่าข้อมูลร้านค้า</h2>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-1">ชื่อร้านค้า (ผู้ส่ง)</label>
              <input 
                type="text" 
                className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400 focus:outline-none"
                value={tempProfile.name}
                onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})}
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-1">เบอร์โทรศัพท์</label>
              <input 
                type="text" 
                className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400 focus:outline-none"
                value={tempProfile.phone}
                onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})}
              />
            </div>
            <div className="mb-6">
              <label className="block text-sm font-bold text-gray-700 mb-1">ที่อยู่ร้านค้า</label>
              <textarea 
                className="w-full border border-gray-300 p-2 rounded h-24 resize-none focus:ring-2 focus:ring-blue-400 focus:outline-none"
                value={tempProfile.address}
                onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})}
              />
            </div>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition font-bold"
              >
                ยกเลิก
              </button>
              <button 
                onClick={handleSaveProfile}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition font-bold"
              >
                💾 บันทึกข้อมูล
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header & Tabs */}
      <header className="mb-6 bg-white p-4 rounded-lg shadow-sm print:hidden">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-3xl font-bold text-blue-800 flex items-center gap-2">
              📦 SmartLabel <span className="text-sm bg-blue-100 text-blue-600 px-2 py-1 rounded-full">PRO</span>
            </h1>
            <p className="text-gray-600">ระบบจัดการออเดอร์และพิมพ์จ่าหน้าอัจฉริยะ</p>
          </div>
          
          <div className="flex bg-gray-100 p-1 rounded-lg">
            <button 
              onClick={() => setActiveTab('maker')}
              className={`px-6 py-2 rounded-md font-bold transition-all ${activeTab === 'maker' ? 'bg-white text-blue-600 shadow' : 'text-gray-500 hover:text-gray-700'}`}
            >
              ✍️ สร้างจ่าหน้า
            </button>
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`px-6 py-2 rounded-md font-bold transition-all ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow' : 'text-gray-500 hover:text-gray-700'}`}
            >
              📊 สถิติร้านค้า
            </button>
          </div>
        </div>

        <div className="flex justify-between items-center bg-blue-50 p-3 rounded border border-blue-100">
          <div className="text-sm text-blue-800">
            <span className="font-bold">ร้านปัจจุบัน:</span> {storeProfile.name} | 📞 {storeProfile.phone}
          </div>
          <button 
            onClick={handleOpenSettings}
            className="text-sm bg-white border border-blue-200 text-blue-600 px-3 py-1 rounded hover:bg-blue-100 transition font-bold shadow-sm"
          >
            ⚙️ ตั้งค่าร้านค้า
          </button>
        </div>
      </header>

      {/* หน้าต่าง: สร้างจ่าหน้า */}
      {activeTab === 'maker' && (
        <div className="flex flex-col md:flex-row gap-6 print:block">
          
          <div className="flex-1 bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500 max-h-[70vh] overflow-y-auto print:hidden">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-800">1. วางข้อความแชตต่อเนื่อง</h2>
            </div>
            
            {orders.map((order, index) => {
              let boxColorClass = 'border-gray-300 focus:ring-blue-400';
              let hasWarnings = false;
              if (order.parsedData) {
                hasWarnings = order.parsedData.warnings.length > 0;
                if (hasWarnings) boxColorClass = 'border-red-400 bg-red-50 focus:ring-red-500';
                else if (order.parsedData.isCOD) boxColorClass = 'border-orange-400 bg-orange-50 focus:ring-orange-500';
                else boxColorClass = 'border-green-400 bg-green-50 focus:ring-green-500';
              }

              return (
                <div key={order.id} className="mb-6 relative group border-b pb-4 border-gray-100">
                  <div className="flex justify-between items-end mb-1">
                    <label className="block text-sm font-bold text-gray-500">ออเดอร์ที่ {index + 1}</label>
                    {(order.rawText !== '' || orders.length > 1) && (
                      <button onClick={() => handleDeleteOrder(order.id)} className="text-red-400 hover:text-red-600 text-sm font-bold transition flex items-center gap-1">
                        🗑️ ลบ
                      </button>
                    )}
                  </div>
                  <textarea
                    className={`w-full h-32 p-4 border rounded-md focus:outline-none focus:ring-2 resize-none transition-all ${boxColorClass}`}
                    placeholder="วางข้อความแชตที่มี ชื่อ ที่อยู่ เบอร์โทร รายการสินค้า..."
                    value={order.rawText}
                    onChange={(e) => handleTextChange(order.id, e.target.value)}
                    onFocus={() => handleFocus(order.id)}
                  />
                  {hasWarnings && (
                    <div className="mt-2 text-sm font-bold text-red-500 flex flex-col gap-1">
                      {order.parsedData.warnings.map((warning, wIndex) => <span key={wIndex}>{warning}</span>)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex-1 bg-gray-50 p-6 rounded-lg shadow-inner border-2 border-dashed border-gray-300 max-h-[70vh] overflow-y-auto print:bg-white print:border-none print:shadow-none print:p-0 print:max-h-none print:overflow-visible print:block">
            <div className="flex justify-between items-center mb-4 print:hidden">
               <h2 className="text-xl font-semibold text-gray-800">2. ตรวจสอบและสั่งพิมพ์</h2>
               <div className="flex gap-3">
                  <div className="bg-blue-100 text-blue-800 px-3 py-1 rounded-md font-bold flex items-center">
                    พร้อม: {orders.filter(o => o.parsedData && o.parsedData.warnings.length === 0).length} สมบูรณ์
                  </div>
                  <button onClick={handlePrint} className="bg-green-500 hover:bg-green-600 text-white font-bold py-1 px-4 rounded-md transition shadow-md flex items-center gap-2">
                    🖨️ สั่งพิมพ์
                  </button>
               </div>
            </div>
            
            <div className="flex flex-col items-center gap-8 pb-10 print:block print:pb-0">
              {orders.filter(o => o.parsedData).length === 0 && (
                <div className="w-full h-64 flex items-center justify-center text-gray-400 print:hidden">
                  รอข้อความเพื่อสร้างจ่าหน้าอัตโนมัติ...
                </div>
              )}

              {orders.filter(o => o.parsedData).map((order) => (
                <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm flex flex-col items-center relative transition-transform duration-300 hover:scale-[1.02] print:max-w-none print:block print:break-after-page print:hover:scale-100 print:mb-0">
                  <div className="w-full border-2 border-gray-800 p-4 bg-white shadow-md relative print:shadow-none print:border-[1px] print:border-gray-300 print:p-2">
                    <div className="flex justify-between items-center border-b pb-2 mb-2">
                      <span className="font-bold text-lg">SmartLabel ✅</span>
                      <span className="text-xs text-gray-500">Date: {new Date().toLocaleDateString()}</span>
                    </div>
                    
                    <div className="mb-3">
                      <p className="text-xs font-bold text-gray-600">ผู้ส่ง (Sender):</p>
                      <p className="text-sm font-bold">{storeProfile.name} ({storeProfile.phone})</p>
                      <p className="text-xs">{storeProfile.address}</p>
                    </div>

                    {order.parsedData.isCOD && (
                      <div className="bg-black text-white text-center py-2 mb-3 border-2 border-dashed border-white outline outline-4 outline-black print:bg-black print:text-white print:border-white">
                        <p className="text-xs font-bold tracking-widest">เก็บเงินปลายทาง (COD)</p>
                        <p className="text-3xl font-extrabold">{order.parsedData.codAmount} บาท</p>
                      </div>
                    )}
                    <div className="mb-4 bg-gray-50 p-2 border rounded print:bg-white print:border-gray-300">
                      <p className="text-xs font-bold text-blue-600 mb-1">ผู้รับ (Receiver):</p>
                      <p className="text-xl font-bold">{order.parsedData.customerName || 'ไม่ระบุชื่อ'}</p>
                      <p className="text-lg font-bold mt-1">☎ {order.parsedData.phone || 'ไม่ระบุเบอร์โทร'}</p>
                      <p className="text-md mt-1 leading-tight">{order.parsedData.address || 'ไม่ระบุที่อยู่'}</p>
                    </div>
                    <div className="text-center mb-4">
                      <p className="text-4xl font-extrabold tracking-widest">{order.parsedData.zipcode || '00000'}</p>
                    </div>
                    <div className="flex flex-col items-center justify-center border-t border-b py-3 mb-3">
                      <div className="flex items-center justify-center p-1 bg-white border border-gray-300 rounded mb-1">
                        <QRCodeSVG value={JSON.stringify({ orderId: `TH-SMART-${order.id}`, name: order.parsedData.customerName, phone: order.parsedData.phone, zip: order.parsedData.zipcode, cod: order.parsedData.isCOD ? order.parsedData.codAmount : 0 })} size={96} />
                      </div>
                      <p className="font-bold text-sm">TH-SMART-{order.id}</p>
                    </div>
                    <div>
                      <p className="text-xs font-bold">รายการสินค้า (Items):</p>
                      {order.parsedData.items.length > 0 ? (
                        <ul className="text-xs list-disc pl-4 mt-1">
                          {order.parsedData.items.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-500 italic mt-1">- ไม่ระบุรายการ -</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* หน้าต่าง: สถิติร้านค้า */}
      {activeTab === 'dashboard' && (
        <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-purple-500">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">ภาพรวมธุรกิจ (Business Analytics)</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-blue-50 border border-blue-100 p-6 rounded-xl">
              <h3 className="text-blue-600 font-bold mb-2">ยอดจัดส่งรวม (สัปดาห์นี้)</h3>
              <p className="text-4xl font-extrabold text-blue-900">265 <span className="text-lg font-normal">ชิ้น</span></p>
            </div>
            <div className="bg-orange-50 border border-orange-100 p-6 rounded-xl">
              <h3 className="text-orange-600 font-bold mb-2">ออเดอร์ COD</h3>
              <p className="text-4xl font-extrabold text-orange-900">95 <span className="text-lg font-normal">ชิ้น</span></p>
            </div>
            <div className="bg-green-50 border border-green-100 p-6 rounded-xl">
              <h3 className="text-green-600 font-bold mb-2">คาดการณ์เงินโอนเข้า (COD)</h3>
              <p className="text-4xl font-extrabold text-green-900">฿45,200</p>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 border border-gray-200 p-4 rounded-xl shadow-sm">
              <h3 className="font-bold text-gray-700 mb-4 text-center">สถิติการส่งพัสดุรายวัน (Daily Volume)</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={mockWeeklyData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip cursor={{fill: '#f3f4f6'}} />
                    <Legend />
                    <Bar dataKey="โอนเงิน" stackId="a" fill="#22c55e" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="COD" stackId="a" fill="#f97316" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="border border-gray-200 p-4 rounded-xl shadow-sm flex flex-col items-center">
              <h3 className="font-bold text-gray-700 mb-4">สัดส่วนประเภทออเดอร์</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={mockPieData} innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                      {mockPieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend verticalAlign="bottom" height={36}/>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

import { auth, db } from './firebase'; 
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { initializeApp, getApps } from "firebase/app";
import { collection, addDoc, getDocs, query, serverTimestamp, doc, getDoc, setDoc, where, updateDoc, increment, deleteDoc } from "firebase/firestore";

// 🔥 สมองกล Advanced Parser ตัวเทพ
const extractOrderData = (rawText) => {
  if (!rawText) return null;
  let cleanText = rawText.replace(/-/g, ''); 

  const phoneMatch = cleanText.match(/\b0\d{8,9}\b/);
  const phone = phoneMatch ? phoneMatch[0] : '';
  const zipMatch = cleanText.match(/\b\d{5}\b/);
  const zipcode = zipMatch ? zipMatch[0] : '';

  let isCOD = false;
  let codAmount = '';
  const codRegex = /(?:cod|ปลายทาง|เก็บเงินปลายทาง|ยอด)\s*[:=]?\s*([\d,]+)/i;

  let addressPart = cleanText;
  let itemsPart = '';

  let lastIndex = -1;
  if (phoneMatch) lastIndex = Math.max(lastIndex, cleanText.indexOf(phoneMatch[0]) + phoneMatch[0].length);
  if (zipMatch) lastIndex = Math.max(lastIndex, cleanText.indexOf(zipMatch[0]) + zipMatch[0].length);

  if (lastIndex > -1 && lastIndex < cleanText.length) {
    itemsPart = cleanText.substring(lastIndex);
    addressPart = cleanText.substring(0, lastIndex);
  }

  const codMatchItems = itemsPart.match(codRegex) || addressPart.match(codRegex);
  if (codMatchItems) {
    isCOD = true;
    codAmount = codMatchItems[1];
    itemsPart = itemsPart.replace(codMatchItems[0], '');
    addressPart = addressPart.replace(codMatchItems[0], '');
  }

  if (phone) addressPart = addressPart.replace(phone, '');
  if (zipcode) addressPart = addressPart.replace(zipcode, '');
  addressPart = addressPart.replace(/\b(โทร\.?|เบอร์โทรศัพท์|เบอร์ติดต่อ|tel\.?)\b/gi, '');

  let lines = addressPart.split('\n').map(l => l.trim()).filter(l => l !== '');
  let customerName = '';
  let addressLines = [];

  if (lines.length === 1) {
    const splitRegex = /\s(\d+\/|\d+\s|บ้านเลขที่|หมู่|ม\.|ซอย|ซ\.|ถนน|ถ\.|ตำบล|ต\.)/;
    const match = lines[0].match(splitRegex);
    
    if (match) {
      customerName = lines[0].substring(0, match.index).trim();
      addressLines.push(lines[0].substring(match.index).trim());
    } else {
      const firstSpace = lines[0].indexOf(' ');
      if (firstSpace > -1) {
        customerName = lines[0].substring(0, firstSpace).trim();
        addressLines.push(lines[0].substring(firstSpace).trim());
      } else {
        customerName = lines[0];
      }
    }
  } else if (lines.length > 1) {
    customerName = lines[0];
    addressLines = lines.slice(1);
  }

  let items = [];
  const cleanedItemsPart = itemsPart.trim();
  if (cleanedItemsPart) {
    const itemSplitRegex = /(.+?(?:x\s*\d+|\d+\s*(?:ตัว|ชิ้น|กล่อง|ใบ|คู่|ชุด|แพ็ค|ขวด|ซอง)))(?:\s+|$)/gi;
    let match;
    let foundItems = [];
    while ((match = itemSplitRegex.exec(cleanedItemsPart)) !== null) {
        foundItems.push(match[1].trim());
    }
    items = foundItems.length > 0 ? foundItems : [cleanedItemsPart];
  }

  const address = addressLines.join(' ').trim();
  
  let warnings = [];
  if (!phone) warnings.push(isCOD ? "⚠️ ไม่มีเบอร์โทร (COD บังคับ!)" : "⚠️ ไม่มีเบอร์โทรศัพท์");
  if (!zipcode) warnings.push("⚠️ ไม่มีรหัสไปรษณีย์");
  if (addressPart.trim() !== '') {
    if (!/(ต\.|ตำบล|แขวง)/.test(addressPart)) warnings.push("⚠️ ขาด ตำบล/แขวง");
    if (!/(อ\.|อำเภอ|เขต)/.test(addressPart)) warnings.push("⚠️ ขาด อำเภอ/เขต");
  }

  return { customerName, phone, address, zipcode, items, isCOD, codAmount, warnings };
};

const COLORS = ['#22c55e', '#f97316'];

export default function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(''); 
  const [quota, setQuota] = useState(0); 
  const [userOwnerId, setUserOwnerId] = useState(null);

  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState(100); 
  
  const [isAuthView, setIsAuthView] = useState(false); 
  const [authMode, setAuthMode] = useState('login'); 
  
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('maker'); 
  
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({ name: 'ToppySmart Logistics', phone: '087-448-4448', address: '123/48 ม.5 ต.หอรัตนไชย อ.พระนครศรีอยุธยา' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  const [historyOrders, setHistoryOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [reprintOrder, setReprintOrder] = useState(null);

  const [dashboardStats, setDashboardStats] = useState({ totalOrders: 0, codOrders: 0, totalCodAmount: 0, pieData: [], barData: [] });
  const [billingRequests, setBillingRequests] = useState([]);
  
  const [staffList, setStaffList] = useState([]);
  const [newStaff, setNewStaff] = useState({ name: '', phone: '', role: 'Staff' });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const userRef = doc(db, "users", currentUser.uid);
          const userSnap = await getDoc(userRef);
          if (userSnap.exists()) {
            const data = userSnap.data();
            setUserRole(data.role);
            setQuota(data.quota || 0);
            setUserOwnerId(data.ownerId || currentUser.uid);
          } else {
            await setDoc(userRef, { email: currentUser.email, role: 'Owner', quota: 20, ownerId: currentUser.uid, createdAt: serverTimestamp() });
            setUserRole('Owner');
            setQuota(20);
            setUserOwnerId(currentUser.uid); 
          }
        } catch (error) { console.error("Error:", error); }
      } else {
        setUser(null); setUserRole(''); setQuota(0); setUserOwnerId(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const savedProfile = localStorage.getItem('smartlabel_profile');
    if (savedProfile) setStoreProfile(JSON.parse(savedProfile));
  }, []);

  const loadDashboardData = async () => {
    if (!userOwnerId) return; 
    try {
      const q = query(collection(db, "orders"), where("ownerId", "==", userOwnerId));
      const querySnapshot = await getDocs(q);
      
      let total = 0, codCount = 0, codSum = 0, transferCount = 0;
      const dateMap = {}; const ordersList = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data(); ordersList.push({ id: doc.id, ...data });
        total++;
        if (data.isCOD) { codCount++; codSum += data.codAmount || 0; } else { transferCount++; }
        if (data.createdAt) {
           const dateStr = data.createdAt.toDate().toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
           if (!dateMap[dateStr]) dateMap[dateStr] = { name: dateStr, โอนเงิน: 0, COD: 0 };
           if (data.isCOD) dateMap[dateStr].COD += 1; else dateMap[dateStr].โอนเงิน += 1;
        }
      });
      ordersList.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      setHistoryOrders(ordersList);
      setDashboardStats({
        totalOrders: total, codOrders: codCount, totalCodAmount: codSum,
        pieData: [{ name: 'โอนเงินแล้ว', value: transferCount }, { name: 'เก็บเงินปลายทาง', value: codCount }],
        barData: Object.values(dateMap).sort((a, b) => new Date(a.name) - new Date(b.name)) || [{ name: 'รอข้อมูลใหม่', โอนเงิน: 0, COD: 0 }]
      });
    } catch (error) { console.error(error); }
  };

  const loadBillingRequests = async () => {
    try {
      const q = query(collection(db, "topups"), where("status", "==", "pending"));
      const querySnapshot = await getDocs(q);
      const requests = [];
      querySnapshot.forEach((doc) => { requests.push({ id: doc.id, data: doc.data() }); });
      setBillingRequests(requests.sort((a, b) => (b.data.createdAt?.toMillis() || 0) - (a.data.createdAt?.toMillis() || 0)));
    } catch (error) { console.error("Error loading bills:", error); }
  };

  const loadStaffData = async () => {
    try {
      const q = query(collection(db, "users"), where("ownerId", "==", user.uid));
      const querySnapshot = await getDocs(q);
      const staffs = [];
      querySnapshot.forEach((doc) => { staffs.push({ id: doc.id, ...doc.data() }); });
      setStaffList(staffs);
    } catch (error) { console.error("Error loading staff:", error); }
  };

  useEffect(() => { 
    if (activeTab === 'dashboard') loadDashboardData(); 
    if (activeTab === 'billing' && userRole === 'SuperAdmin') loadBillingRequests();
    if (activeTab === 'team' && (userRole === 'Owner' || userRole === 'SuperAdmin')) loadStaffData();
  }, [activeTab, userRole, userOwnerId]); 

  const handleAuth = async (e) => {
    e.preventDefault();
    const email = e.target.email.value;
    const password = e.target.password.value;
    const formattedEmail = email.includes('@') ? email : `${email}@smartlabel.com`;

    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, formattedEmail, password);
      } else {
        const storeName = e.target.storeName.value;
        const userCredential = await createUserWithEmailAndPassword(auth, formattedEmail, password);
        await setDoc(doc(db, "users", userCredential.user.uid), { 
            email: formattedEmail, role: 'Owner', quota: 20, ownerId: userCredential.user.uid, createdAt: serverTimestamp() 
        });
        const initialProfile = { name: storeName, phone: '', address: '' };
        setStoreProfile(initialProfile);
        localStorage.setItem('smartlabel_profile', JSON.stringify(initialProfile));
        alert("🎉 สมัครสมาชิกสำเร็จ! รับโควต้าทดลองใช้ฟรี 20 จ่าหน้าครับ");
      }
    } catch (error) { 
      alert(authMode === 'login' ? "ข้อมูลเข้าสู่ระบบไม่ถูกต้องครับ" : "เกิดข้อผิดพลาด หรืออีเมลนี้มีในระบบแล้วครับ"); 
    }
  };

  const handleLogout = () => { setActiveTab('maker'); signOut(auth); };

  const handleAddStaff = async (e) => {
    e.preventDefault();
    if (newStaff.phone.length !== 10) return alert("กรุณากรอกเบอร์โทรศัพท์ 10 หลักครับ");
    try {
      let secondaryApp;
      const appName = "SecondaryApp";
      if (getApps().find(a => a.name === appName)) { secondaryApp = getApps().find(a => a.name === appName); } 
      else { secondaryApp = initializeApp(auth.app.options, appName); }
      const secondaryAuth = getAuth(secondaryApp);
      
      const staffEmail = `${newStaff.phone}@smartlabel.com`;
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, staffEmail, '123456');
      const newUid = userCredential.user.uid;

      await setDoc(doc(db, "users", newUid), { email: staffEmail, name: newStaff.name, phone: newStaff.phone, role: newStaff.role, ownerId: user.uid, createdAt: serverTimestamp() });
      await signOut(secondaryAuth);
      
      alert(`เพิ่มพนักงานสำเร็จ! รหัสผ่านเริ่มต้นคือ: 123456`);
      setNewStaff({ name: '', phone: '', role: 'Staff' });
      loadStaffData();
    } catch (error) { alert("เกิดข้อผิดพลาด หรือเบอร์โทรนี้ถูกใช้งานไปแล้วครับ"); }
  };

  const handleDeleteStaff = async (staffId) => {
    if(window.confirm("ต้องการลบพนักงานคนนี้ออกจากระบบใช่หรือไม่?")) {
      try { await deleteDoc(doc(db, "users", staffId)); loadStaffData(); } catch (error) { alert("ลบข้อมูลไม่สำเร็จครับ"); }
    }
  };

  const checkCustomerHistory = async (orderId, phone) => {
    if (!phone || phone.length < 9 || !userOwnerId) return;
    try {
      const q = query(collection(db, "orders"), where("phone", "==", phone));
      const querySnapshot = await getDocs(q);
      if (!querySnapshot.empty) {
        const historyData = []; 
        querySnapshot.forEach((doc) => {
           if(doc.data().ownerId === userOwnerId) {
               historyData.push(doc.data());
           }
        });
        if(historyData.length > 0) {
            historyData.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
            setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: historyData[0] } : o));
        } else {
            setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: null } : o));
        }
      } else { setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: null } : o)); }
    } catch (error) { console.error(error); }
  };

  const handleTextChange = (id, newText) => {
    let updatedOrders = orders.map(order => {
      if (order.id === id) {
        const parsed = newText.trim() !== '' ? extractOrderData(newText) : null;
        if (parsed && parsed.phone && parsed.phone !== order.parsedData?.phone) checkCustomerHistory(id, parsed.phone);
        if (!parsed || !parsed.phone) return { ...order, rawText: newText, parsedData: parsed, isSaved: false, crmSuggestion: null };
        return { ...order, rawText: newText, parsedData: parsed, isSaved: false };
      }
      return order;
    });
    if (updatedOrders[updatedOrders.length - 1].rawText.trim() !== '') updatedOrders.push({ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null });
    setOrders(updatedOrders);
  };

  const applyCrmData = (orderId, crmData) => {
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        const newRawText = `${crmData.customerName}\n${crmData.address} ${crmData.zipcode}\n${o.rawText}`;
        return { ...o, rawText: newRawText, parsedData: extractOrderData(newRawText), crmSuggestion: null };
      }
      return o;
    }));
  };

  const handleDeleteOrder = (id) => {
    const remaining = orders.filter(o => o.id !== id);
    setOrders(remaining.length === 0 ? [{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }] : remaining);
  };

  const handleFocus = (id) => { 
      if (labelRefs.current[id]) {
          labelRefs.current[id].scrollIntoView({ behavior: 'smooth', block: 'center' }); 
      }
  };

  const handleSaveProfile = () => {
    setStoreProfile(tempProfile); localStorage.setItem('smartlabel_profile', JSON.stringify(tempProfile)); setIsSettingsOpen(false);
  };

  const handleSaveAndPrint = async () => {
    const readyToSaveOrders = orders.filter(o => o.parsedData && !o.isSaved && o.rawText.trim() !== '');
    if (userRole === 'Owner' && readyToSaveOrders.length > quota) { setIsTopupOpen(true); return; }

    if (readyToSaveOrders.length > 0) {
      try {
        for (const order of readyToSaveOrders) {
          const codNumber = order.parsedData.isCOD ? Number(order.parsedData.codAmount.replace(/,/g, '')) : 0;
          await addDoc(collection(db, "orders"), {
            rawText: order.rawText, adminEmail: user.email, storeName: storeProfile.name,
            customerName: order.parsedData.customerName, phone: order.parsedData.phone,
            address: order.parsedData.address, zipcode: order.parsedData.zipcode,
            items: order.parsedData.items, isCOD: order.parsedData.isCOD, codAmount: codNumber, 
            ownerId: userOwnerId, 
            createdAt: serverTimestamp() 
          });
        }
        if (userRole === 'Owner') {
          const userRef = doc(db, "users", user.uid);
          await updateDoc(userRef, { quota: increment(-readyToSaveOrders.length) });
          setQuota(prev => prev - readyToSaveOrders.length);
        }
        setOrders(prev => prev.map(o => (o.parsedData && !o.isSaved && o.rawText.trim() !== '') ? { ...o, isSaved: true } : o));
      } catch (error) { alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลครับ"); }
    }
    window.print();
  };

  const handleEditHistory = (order) => {
    setOrders([{ id: Date.now(), rawText: order.rawText || '', parsedData: extractOrderData(order.rawText || ''), isSaved: false, crmSuggestion: null }, { id: Date.now() + 1, rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]);
    setActiveTab('maker'); window.scrollTo(0, 0); 
  };
  const handleReprintHistory = (order) => { setReprintOrder(order); setTimeout(() => { window.print(); setReprintOrder(null); }, 300); };
  
  const handleExportCSV = () => {
    if (historyOrders.length === 0) return alert("ไม่มีข้อมูลให้ดาวน์โหลดครับ");
    const headers = ["วันที่สร้าง", "เลขอ้างอิง", "ชื่อผู้รับ", "เบอร์โทร", "ที่อยู่", "รหัสไปรษณีย์", "รายการสินค้า", "ยอด COD", "แอดมิน"];
    const csvRows = historyOrders.map(order => [
      order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH') : '-', `REF-${order.id.slice(-6).toUpperCase()}`, `"${order.customerName || ''}"`, order.phone || '-', `"${order.address || ''}"`, order.zipcode || '-', `"${(order.items || []).join(' | ')}"`, order.isCOD ? order.codAmount : "0", order.adminEmail || '-'
    ].join(','));
    const blob = new Blob(["\uFEFF" + headers.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `SmartLabel_Orders.csv`; link.click();
  };

  const handleSubmitTopup = async () => {
    try {
      await addDoc(collection(db, "topups"), { email: user.email, uid: user.uid, requestedQuota: selectedPackage, amount: selectedPackage === 100 ? 50 : 200, status: 'pending', createdAt: serverTimestamp() });
      alert("ส่งหลักฐานสำเร็จ! กรุณารอแอดมินอนุมัติครับ"); setIsTopupOpen(false);
    } catch (error) { alert("เกิดข้อผิดพลาดในการส่งคำขอ"); }
  };

  const handleApproveTopup = async (requestId, userId, requestedQuota) => {
    try {
      await updateDoc(doc(db, "topups", requestId), { status: 'approved', approvedAt: serverTimestamp() });
      await updateDoc(doc(db, "users", userId), { quota: increment(requestedQuota) });
      if (userId === user.uid) setQuota(prev => prev + requestedQuota);
      loadBillingRequests(); 
    } catch (error) { alert("เกิดข้อผิดพลาดในการอนุมัติ"); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-100 font-bold text-blue-600 animate-pulse">กำลังโหลดระบบ...</div>;

  if (!user && !isAuthView) {
    return (
      <div className="min-h-screen bg-white font-sans text-gray-900 selection:bg-blue-200">
        <style>{`
          @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
          .animate-float { animation: float 3s ease-in-out infinite; }
          .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
          .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 10px 20px -10px rgba(59, 130, 246, 0.5); }
          .card-hover { transition: transform 0.3s ease, box-shadow 0.3s ease; }
          .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 30px -10px rgba(0,0,0,0.1); }
        `}</style>
        <nav className="flex justify-between items-center px-6 py-4 border-b">
          <div className="text-2xl font-black text-blue-800 flex items-center gap-2"><span className="animate-float inline-block">📦</span> SmartLabel</div>
          <button onClick={() => setIsAuthView(true)} className="btn-cute bg-blue-600 text-white px-6 py-2 rounded-full font-bold">เข้าสู่ระบบ</button>
        </nav>
        <header className="px-6 py-20 text-center bg-gradient-to-b from-blue-50 to-white">
          <h1 className="text-5xl md:text-7xl font-black text-blue-900 mb-6 leading-tight hover:scale-[1.01] transition-transform">จ่าหน้าพัสดุไวขึ้น 10 เท่า <br/> <span className="text-blue-600">ด้วยสมองกลอัจฉริยะ</span></h1>
          <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">สกัดชื่อที่อยู่จากแชทลูกค้าอัตโนมัติ พร้อมระบบจดจำลูกค้าเก่า (CRM) และสถิติครบวงจร เพื่อแม่ค้าออนไลน์มือโปรเช่นคุณ</p>
          <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute bg-blue-600 text-white text-xl px-12 py-4 rounded-full font-black shadow-xl animate-bounce mt-4">เริ่มทดลองใช้ฟรี 20 ใบ</button>
        </header>
        <section className="py-20 px-6 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12">
           <div className="text-center group"><div className="text-6xl mb-4 group-hover:scale-125 group-hover:rotate-12 transition-transform duration-300 inline-block">🧠</div><h3 className="text-xl font-bold mb-2">Smart CRM</h3><p className="text-gray-500">พิมพ์แค่เบอร์โทร ข้อมูลชื่อและที่อยู่ลูกค้าเก่าเด้งขึ้นมาให้ทันที</p></div>
           <div className="text-center group"><div className="text-6xl mb-4 group-hover:scale-125 group-hover:-translate-y-2 transition-transform duration-300 inline-block">🖨️</div><h3 className="text-xl font-bold mb-2">Thermal Ready</h3><p className="text-gray-500">ออกแบบมาเพื่อเครื่องพิมพ์ความร้อน พิมพ์ออกมาสวยเป๊ะทุกใบ</p></div>
           <div className="text-center group"><div className="text-6xl mb-4 group-hover:scale-125 group-hover:rotate-[-12deg] transition-transform duration-300 inline-block">📊</div><h3 className="text-xl font-bold mb-2">Dashboard & Export</h3><p className="text-gray-500">ดูยอดส่งรายวัน และดาวน์โหลดข้อมูลเป็น Excel ได้ในคลิกเดียว</p></div>
        </section>
        <section className="py-24 bg-slate-50 border-t border-slate-100">
          <div className="max-w-4xl mx-auto px-6 text-center">
            <h2 className="text-4xl font-black mb-12 text-slate-800">ราคาแพ็กเกจที่คุณเลือกได้</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-white p-10 rounded-3xl shadow-lg border border-slate-200 card-hover flex flex-col justify-between">
                 <div><p className="text-blue-600 font-bold mb-4 tracking-widest uppercase text-sm">เริ่มต้นเบาๆ</p><p className="text-6xl font-black mb-4 text-slate-800">฿50</p><p className="text-slate-500 mb-8 font-medium">ได้รับ 100 จ่าหน้า <br/> <span className="text-sm">(เพียง 0.5 บาท/ใบ)</span></p></div>
                 <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-xl border-2 border-blue-600 text-blue-600 font-bold hover:bg-blue-50">เริ่มต้นใช้งาน</button>
              </div>
              <div className="bg-white p-10 rounded-3xl shadow-2xl border-4 border-blue-600 relative overflow-hidden card-hover transform md:-translate-y-4 flex flex-col justify-between">
                 <div className="absolute top-0 right-0 bg-blue-600 text-white px-6 py-2 font-black text-sm rounded-bl-2xl shadow-sm tracking-widest">ยอดฮิต 🔥</div>
                 <div><p className="text-blue-600 font-bold mb-4 tracking-widest uppercase text-sm">คุ้มค่าที่สุด</p><p className="text-6xl font-black mb-4 text-slate-800">฿200</p><p className="text-slate-500 mb-8 font-medium">ได้รับ 500 จ่าหน้า <br/> <span className="text-sm">(เพียง 0.4 บาท/ใบ)</span></p></div>
                 <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-xl bg-blue-600 text-white font-bold shadow-lg shadow-blue-500/40">เลือกแพ็กเกจนี้</button>
              </div>
            </div>
            <div className="mt-12 text-slate-500 font-medium bg-white p-6 rounded-2xl shadow-sm border border-slate-200 inline-block">ต้องการส่งไม่จำกัดจำนวน? แพ็กเกจ Unlimited ฿299/เดือน <button className="text-blue-600 font-bold hover:underline ml-2">ติดต่อทีมงาน</button></div>
          </div>
        </section>
        <footer className="py-12 bg-white border-t border-slate-100 text-center text-slate-400 text-sm font-medium">© 2026 ToppySmart Logistics. พัฒนาโดยพาร์ทเนอร์ & CTO Copilot</footer>
      </div>
    );
  }

  if (!user && isAuthView) {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center p-6 font-sans relative">
        <style>{`.btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); } .btn-cute:hover { transform: scale(1.05); }`}</style>
        <button onClick={() => setIsAuthView(false)} className="absolute top-6 left-6 text-blue-200 hover:text-white font-bold transition hover:-translate-x-1">← กลับหน้าหลัก</button>
        <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md animate-[fadeIn_0.5s_ease-out]">
          <div className="text-center mb-6"><h1 className="text-4xl font-extrabold text-blue-800 mb-2 flex justify-center items-center gap-2"><span className="animate-bounce inline-block">📦</span> SmartLabel</h1><p className="text-gray-500 font-bold">{authMode === 'login' ? 'ยินดีต้อนรับกลับมา!' : 'เริ่มต้นความสำเร็จไปกับเรา'}</p></div>
          <form onSubmit={handleAuth}>
            {authMode === 'register' && (<div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-1">ชื่อร้านค้าของคุณ</label><input name="storeName" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-200 outline-none bg-gray-50 transition-all" placeholder="เช่น ToppySmart Shop" /></div>)}
            <div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-1">{authMode === 'login' ? 'อีเมล หรือ เบอร์โทรศัพท์' : 'อีเมลของคุณ'}</label><input name="email" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-200 outline-none bg-gray-50 transition-all" placeholder={authMode === 'login' ? "เบอร์โทรศัพท์ หรือ อีเมล" : "owner@mail.com"} /></div>
            <div className="mb-6"><label className="block text-sm font-bold text-gray-700 mb-1">รหัสผ่าน</label><input name="password" type="password" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-200 outline-none bg-gray-50 transition-all" placeholder="••••••••" /></div>
            <button type="submit" className="btn-cute w-full bg-blue-600 text-white font-bold py-3 rounded-xl shadow-lg hover:shadow-blue-500/50">{authMode === 'login' ? 'เข้าสู่ระบบ' : '✨ สมัครสมาชิกฟรี'}</button>
          </form>
          <div className="mt-6 text-center border-t pt-4">
            {authMode === 'login' ? <p className="text-sm text-gray-600">เจ้าของร้านคนใหม่? <button onClick={() => setAuthMode('register')} className="text-blue-600 font-bold hover:underline">เปิดร้านฟรี</button></p> : <p className="text-sm text-gray-600">มีบัญชีอยู่แล้ว? <button onClick={() => setAuthMode('login')} className="text-blue-600 font-bold hover:underline">เข้าสู่ระบบ</button></p>}
          </div>
        </div>
      </div>
    );
  }

  // --- Print View ---
  if (reprintOrder) {
    return (
      <div className="bg-white min-h-screen">
        {/* 🔥 ปลดล็อกกล่องพิมพ์ที่นี่! เปลี่ยนเป็น min-height */}
        <style>{`@media print { @page { size: 100mm 150mm; margin: 0; } body, html { background-color: white; margin: 0; padding: 0; -webkit-print-color-adjust: exact; } .thermal-label { width: 100mm !important; height: auto !important; min-height: 148mm !important; padding: 5mm !important; box-sizing: border-box !important; margin: 0 !important; border: none !important; box-shadow: none !important; page-break-after: always; page-break-inside: avoid; } }`}</style>
        <div className="w-full max-w-sm mx-auto p-4 thermal-label print:max-w-none print:m-0 print:p-2">
           <div className="flex justify-between border-b pb-2 mb-2 font-bold text-sm"><span>SmartLabel ✅</span><span className="text-gray-500">Admin: {reprintOrder.adminEmail?.split('@')[0]}</span></div>
           <div className="mb-3"><p className="text-xs text-gray-500">ผู้ส่ง:</p><p className="font-bold text-sm">{reprintOrder.storeName}</p></div>
           {reprintOrder.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold">COD: {reprintOrder.codAmount}</div>}
           <div className="bg-gray-100 p-2 mb-2 print:bg-white print:border"><p className="text-xs text-blue-600 font-bold">ผู้รับ:</p><p className="text-xl font-bold">{reprintOrder.customerName || 'ไม่มีชื่อผู้รับ'}</p><p className="text-lg font-bold">☎ {reprintOrder.phone || '-'}</p><p className="text-sm leading-tight">{reprintOrder.address || 'ไม่มีที่อยู่'}</p></div>
           <div className="text-center text-4xl font-black mb-3 tracking-widest">{reprintOrder.zipcode || '00000'}</div>
           <div className="flex flex-col items-center border-t border-b py-2 mb-2">
             <QRCodeSVG value={JSON.stringify({ id: reprintOrder.id, cod: reprintOrder.isCOD ? reprintOrder.codAmount : 0 })} size={60} />
             <p className="text-[10px] mt-1 font-mono uppercase font-bold text-slate-500 tracking-widest">REF: #{String(reprintOrder.id).slice(-6)}</p>
           </div>
           <div><p className="text-xs font-bold">รายการสินค้า:</p>{reprintOrder.items && reprintOrder.items.length > 0 ? (<ul className="text-[10px] list-disc pl-4 mt-1 leading-tight">{reprintOrder.items.map((item, index) => <li key={index}>{item}</li>)}</ul>) : (<p className="text-[10px] text-gray-500 italic mt-1">- ไม่ระบุรายการ -</p>)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans print:bg-white print:p-0 relative">
      {/* 🔥 ปลดล็อกกล่องพิมพ์ที่นี่! เปลี่ยนเป็น min-height และเอา overflow:hidden ทิ้ง */}
      <style>{`
        @media print { 
          @page { size: 100mm 150mm; margin: 0; } 
          body, html { background-color: white; margin: 0; padding: 0; -webkit-print-color-adjust: exact; } 
          ::-webkit-scrollbar { display: none; }
          .thermal-label { 
            width: 100mm !important; 
            min-height: 148mm !important; 
            height: auto !important; 
            padding: 5mm !important; 
            box-sizing: border-box !important; 
            page-break-after: always !important; 
            page-break-inside: avoid !important;
            margin: 0 !important; 
            border: none !important; 
            box-shadow: none !important;
          } 
        }
        .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 5px 15px -5px rgba(0,0,0,0.2); }
        .card-hover { transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); }
      `}</style>
      
      {isTopupOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 print:hidden transition-opacity">
          <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-lg animate-[fadeIn_0.3s_ease-out]">
            <div className="flex justify-between items-center mb-6"><h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">🚀 เติมแพ็กเกจจ่าหน้า</h2><button onClick={() => setIsTopupOpen(false)} className="text-gray-400 hover:text-red-500 hover:rotate-90 transition-transform font-bold text-2xl">&times;</button></div>
            <div className="bg-blue-50 border border-blue-200 p-4 rounded-2xl mb-6 text-center card-hover"><p className="text-gray-600 mb-1">โควต้าปัจจุบันของคุณ</p><p className="text-4xl font-extrabold text-blue-600">{quota} <span className="text-lg font-normal text-blue-800">ใบ</span></p></div>
            <h3 className="font-bold text-gray-700 mb-3">1. เลือกแพ็กเกจ</h3>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div onClick={() => setSelectedPackage(100)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 100 ? 'border-blue-500 bg-blue-50 scale-[1.02]' : 'border-gray-200 hover:border-blue-300 hover:bg-slate-50'}`}>{selectedPackage === 100 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">เลือกอยู่</div>}<p className={`font-bold text-xl ${selectedPackage === 100 ? 'text-blue-800' : 'text-gray-800'}`}>100 ใบ</p><p className="text-sm text-gray-600 mt-1">50 บาท</p></div>
              <div onClick={() => setSelectedPackage(500)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 500 ? 'border-blue-500 bg-blue-50 scale-[1.02]' : 'border-gray-200 hover:border-blue-300 hover:bg-slate-50'}`}>{selectedPackage === 500 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">เลือกอยู่</div>}<p className={`font-bold text-xl ${selectedPackage === 500 ? 'text-blue-800' : 'text-gray-800'}`}>500 ใบ</p><p className="text-sm text-gray-600 mt-1">200 บาท</p></div>
            </div>
            <button onClick={handleSubmitTopup} className="btn-cute w-full bg-green-500 text-white font-bold py-4 rounded-xl shadow-lg shadow-green-500/30">ยืนยันการชำระเงิน (จำลอง)</button>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md animate-[fadeIn_0.3s_ease-out]">
            <h2 className="text-2xl font-bold mb-6 text-gray-800">⚙️ ตั้งค่าข้อมูลร้านค้า</h2>
            <div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-2">ชื่อร้านค้า (ผู้ส่ง)</label><input type="text" className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" value={tempProfile.name} onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})} /></div>
            <div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-2">เบอร์โทรศัพท์</label><input type="text" className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" value={tempProfile.phone} onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})} /></div>
            <div className="mb-8"><label className="block text-sm font-bold text-gray-700 mb-2">ที่อยู่ร้านค้า</label><textarea className="w-full border p-3 rounded-xl h-24 resize-none focus:ring-4 focus:ring-blue-100 outline-none transition-all" value={tempProfile.address} onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})} /></div>
            <div className="flex justify-end gap-3"><button onClick={() => setIsSettingsOpen(false)} className="btn-cute px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-bold">ยกเลิก</button><button onClick={handleSaveProfile} className="btn-cute px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg shadow-blue-500/30">💾 บันทึก</button></div>
          </div>
        </div>
      )}

      <header className="mb-6 bg-white p-5 rounded-2xl shadow-sm border border-gray-100 print:hidden">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-5">
          <div>
            <h1 className="text-3xl font-black text-blue-800 flex items-center gap-2">📦 SmartLabel <span className={`text-xs px-3 py-1 rounded-full font-bold shadow-sm ${userRole === 'SuperAdmin' ? 'bg-gradient-to-r from-red-500 to-rose-500 text-white' : userRole === 'Owner' ? 'bg-gradient-to-r from-purple-500 to-fuchsia-500 text-white' : userRole === 'Admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'}`}>{userRole}</span></h1>
            <p className="text-gray-500 text-sm mt-1 font-medium">ผู้ใช้งาน: {user.email.replace('@smartlabel.com', '')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex bg-slate-100 p-1.5 rounded-xl">
              <button onClick={() => setActiveTab('maker')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm ${activeTab === 'maker' ? 'bg-white text-blue-600 shadow-md' : 'text-gray-500 hover:text-gray-700'}`}>✍️ สร้างจ่าหน้า</button>
              {(userRole === 'SuperAdmin' || userRole === 'Owner' || userRole === 'Admin') && <button onClick={() => setActiveTab('dashboard')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow-md' : 'text-gray-500 hover:text-gray-700'}`}>📊 สถิติ</button>}
              {(userRole === 'Owner' || userRole === 'SuperAdmin') && <button onClick={() => setActiveTab('team')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm ${activeTab === 'team' ? 'bg-white text-blue-600 shadow-md' : 'text-gray-500 hover:text-gray-700'}`}>👥 พนักงาน</button>}
              {userRole === 'SuperAdmin' && <button onClick={() => setActiveTab('billing')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 ${activeTab === 'billing' ? 'bg-white text-blue-600 shadow-md' : 'text-gray-500 hover:text-gray-700'}`}>💳 บิล {billingRequests.length > 0 && <span className="bg-red-500 text-white px-2 py-0.5 rounded-full text-xs animate-bounce">{billingRequests.length}</span>}</button>}
            </div>
            <button onClick={handleLogout} className="btn-cute bg-red-50 text-red-600 px-5 py-3 rounded-xl font-bold text-sm hover:bg-red-100">ออก 🚪</button>
          </div>
        </div>
        
        {(userRole === 'Owner' || userRole === 'SuperAdmin') && (
          <div className="flex justify-between items-center bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-xl border border-blue-100 shadow-inner">
            <div className="text-sm flex items-center gap-4">
                <div className="font-bold text-indigo-700 bg-white px-4 py-2 rounded-lg shadow-sm flex items-center gap-2">
                  🎫 โควต้า: <span className={`text-lg ${quota <= 5 && userRole !== 'SuperAdmin' ? 'text-red-500 animate-pulse' : 'text-indigo-900'}`}>{userRole === 'SuperAdmin' ? '∞' : quota} ใบ</span>
                  {userRole !== 'SuperAdmin' && <button onClick={() => setIsTopupOpen(true)} className="btn-cute ml-2 bg-indigo-600 text-white px-3 py-1 rounded-md text-xs shadow-md shadow-indigo-500/30">➕ เติม</button>}
                </div>
              <span className="text-slate-600 font-medium"><span className="text-slate-400 mr-1">📍 ร้าน:</span>{storeProfile.name}</span>
            </div>
            <button onClick={() => setIsSettingsOpen(true)} className="btn-cute bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-lg font-bold text-sm shadow-sm hover:bg-slate-50">⚙️ ตั้งค่า</button>
          </div>
        )}
      </header>

      {/* --- Tab Content --- */}
      {activeTab === 'maker' ? (
         <div className="flex flex-col lg:flex-row gap-6 print:block print:gap-0 print:m-0">
            <div className="flex-1 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 max-h-[75vh] overflow-y-auto print:hidden">
              <h2 className="text-xl font-black mb-6 text-gray-800 flex items-center gap-2"><span className="text-blue-500">1.</span> วางข้อความแชต</h2>
              {orders.map((order, index) => {
                let boxColorClass = 'border-gray-200 focus:ring-blue-300';
                if (order.parsedData) {
                  const hasWarnings = order.parsedData.warnings.length > 0;
                  boxColorClass = order.parsedData.isCOD ? (hasWarnings ? 'border-orange-400 bg-orange-50/50' : 'border-orange-500 bg-orange-50 ring-2 ring-orange-200') : (hasWarnings ? 'border-rose-400 bg-rose-50/50' : 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200');
                }
                return (
                  <div key={order.id} className="mb-6 p-5 rounded-2xl border border-gray-100 bg-slate-50/50 hover:bg-white transition-colors group">
                    <div className="flex justify-between items-center mb-3"><label className="font-bold text-gray-500 bg-white px-3 py-1 rounded-lg text-sm shadow-sm border border-gray-100">ออเดอร์ที่ {index + 1} {order.isSaved && <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">💾 บันทึกแล้ว</span>}</label>{(order.rawText !== '' || orders.length > 1) && <button onClick={() => handleDeleteOrder(order.id)} className="text-rose-400 hover:text-rose-600 text-sm font-bold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">🗑️ ลบ</button>}</div>
                    {order.crmSuggestion && <div className="mb-3 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl flex justify-between items-center shadow-sm animate-pulse"><div><p className="text-xs text-indigo-600 font-black mb-1">✨ พบประวัติลูกค้า!</p><p className="text-sm font-bold text-slate-800">{order.crmSuggestion.customerName}</p></div><button onClick={() => applyCrmData(order.id, order.crmSuggestion)} className="btn-cute bg-indigo-600 text-white text-xs font-bold py-2 px-4 rounded-lg shadow-md shadow-indigo-500/30">ใช้ข้อมูลนี้</button></div>}
                    <textarea 
                      className={`w-full h-32 p-4 rounded-xl focus:outline-none focus:ring-4 resize-none transition-all shadow-inner ${boxColorClass}`} 
                      placeholder="วางที่อยู่ หรือ พิมพ์แค่เบอร์โทรศัพท์..." 
                      value={order.rawText} 
                      onChange={(e) => handleTextChange(order.id, e.target.value)} 
                      onFocus={() => handleFocus(order.id)} 
                    />
                    {order.parsedData && order.parsedData.warnings.length > 0 && <div className="mt-3 text-sm font-bold text-rose-500 flex flex-col gap-1 bg-rose-50 p-3 rounded-lg border border-rose-100">{order.parsedData.warnings.map((w, i) => <span key={i}>⚠️ {w.replace('⚠️ ', '')}</span>)}</div>}
                  </div>
                );
              })}
            </div>
            
            <div className="flex-1 bg-slate-100/50 rounded-2xl shadow-inner border-2 border-dashed border-slate-300 max-h-[75vh] overflow-y-auto print:max-h-none print:overflow-visible print:bg-white print:border-none print:shadow-none print:m-0 print:p-0 relative print:static">
               <div className="sticky top-0 bg-white/80 backdrop-blur-md border-b border-slate-200 p-5 flex justify-between items-center z-10 print:hidden"><h2 className="text-xl font-black text-gray-800 flex items-center gap-2"><span className="text-blue-500">2.</span> ตรวจสอบและสั่งพิมพ์</h2><button onClick={handleSaveAndPrint} className="btn-cute bg-blue-600 text-white font-bold py-3 px-6 rounded-xl shadow-lg shadow-blue-500/30 flex items-center gap-2">💾 บันทึก & สั่งพิมพ์</button></div>
               <div className="p-8 print:p-0 print:m-0">
                {orders.filter(o => o.parsedData).map((order) => (
                  <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm mx-auto mb-10 bg-white border-2 border-black p-4 thermal-label shadow-xl card-hover print:max-w-none print:mx-0 print:mb-0 print:shadow-none print:transform-none">
                     <div className="flex justify-between border-b-2 border-slate-200 pb-2 mb-3 font-bold text-sm print:border-black"><span>SmartLabel ✅</span><span className="text-gray-500">Admin: {user.email.split('@')[0]}</span></div>
                     <div className="mb-3"><p className="text-xs text-gray-500 font-medium">ผู้ส่ง:</p><p className="font-bold text-sm">{storeProfile.name}</p></div>
                     {order.parsedData.isCOD && <div className="bg-black text-white text-center py-2 mb-3 text-2xl font-black tracking-wider rounded-sm print:border-4 print:border-black">COD: {order.parsedData.codAmount}</div>}
                     <div className="bg-slate-50 p-3 mb-3 rounded-sm border border-slate-200 print:bg-white print:border-black print:border-2"><p className="text-xs text-blue-600 font-black mb-1 print:text-black">ผู้รับ:</p><p className="text-xl font-black text-slate-800">{order.parsedData.customerName || 'ไม่มีชื่อ'}</p><p className="text-lg font-bold text-slate-700 mt-1">☎ {order.parsedData.phone || '-'}</p><p className="text-sm leading-relaxed mt-2 text-slate-600">{order.parsedData.address || 'ไม่มีที่อยู่'}</p></div>
                     <div className="text-center text-5xl font-black mb-4 tracking-widest text-slate-900">{order.parsedData.zipcode || '00000'}</div>
                     <div className="flex flex-col items-center border-t-2 border-b-2 border-slate-200 py-3 mb-3 print:border-black"><QRCodeSVG value={JSON.stringify({ id: order.id, cod: order.parsedData.isCOD ? order.parsedData.codAmount : 0, admin: user.email })} size={60} /><p className="text-[10px] mt-2 font-mono uppercase font-bold text-slate-500 tracking-widest">REF: #{String(order.id).slice(-6)}</p></div>
                     <div><p className="text-xs font-black text-slate-700 mb-1">รายการสินค้า:</p>{order.parsedData.items.length > 0 ? (<ul className="text-[10px] list-disc pl-4 font-medium text-slate-600">{order.parsedData.items.map((item, index) => <li key={index}>{item}</li>)}</ul>) : (<p className="text-[10px] text-gray-400 italic">- ไม่ระบุรายการ -</p>)}</div>
                  </div>
                ))}
               </div>
            </div>
         </div>
      ) : activeTab === 'dashboard' ? (
         <div className="flex flex-col gap-6">
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
              <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">📊 ภาพรวมธุรกิจ</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100 card-hover"><div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-xl mb-4">📦</div><h3 className="text-blue-600 font-bold mb-1">ส่งรวมทั้งหมด</h3><p className="text-5xl font-black text-blue-900">{dashboardStats.totalOrders} <span className="text-lg font-medium">ชิ้น</span></p></div>
                <div className="bg-orange-50 p-6 rounded-2xl border border-orange-100 card-hover"><div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center text-xl mb-4">🚚</div><h3 className="text-orange-600 font-bold mb-1">ออเดอร์ COD</h3><p className="text-5xl font-black text-orange-900">{dashboardStats.codOrders} <span className="text-lg font-medium">ชิ้น</span></p></div>
                <div className="bg-emerald-50 p-6 rounded-2xl border border-emerald-100 card-hover"><div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-xl mb-4">💰</div><h3 className="text-emerald-600 font-bold mb-1">คาดการณ์เงินโอน</h3><p className="text-5xl font-black text-emerald-900">฿{dashboardStats.totalCodAmount.toLocaleString()}</p></div>
              </div>
            </div>
         </div>
      ) : activeTab === 'team' && (userRole === 'Owner' || userRole === 'SuperAdmin') ? (
         <div className="flex flex-col lg:flex-row gap-6">
            <div className="w-full lg:w-1/3">
              <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 sticky top-6">
                <h2 className="text-xl font-black mb-6 text-slate-800 flex items-center gap-2">➕ เพิ่มพนักงาน</h2>
                <form onSubmit={handleAddStaff}>
                  <div className="mb-5"><label className="block text-sm font-bold text-slate-700 mb-2">ชื่อพนักงาน</label><input type="text" required value={newStaff.name} onChange={(e)=>setNewStaff({...newStaff, name: e.target.value})} className="w-full border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none bg-slate-50 transition-all" placeholder="เช่น น้องฟ้าใส" /></div>
                  <div className="mb-5"><label className="block text-sm font-bold text-slate-700 mb-2">เบอร์โทรศัพท์ (ใช้ล็อกอิน)</label><input type="text" maxLength="10" required value={newStaff.phone} onChange={(e)=>setNewStaff({...newStaff, phone: e.target.value})} className="w-full border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none bg-slate-50 transition-all" placeholder="089xxxxxxx" /><div className="bg-blue-50 text-blue-700 text-xs p-2 rounded-lg mt-2 font-medium">🔑 รหัสผ่านเริ่มต้นจะถูกตั้งเป็น: 123456</div></div>
                  <div className="mb-8"><label className="block text-sm font-bold text-slate-700 mb-2">สิทธิ์การเข้าถึง</label><select value={newStaff.role} onChange={(e)=>setNewStaff({...newStaff, role: e.target.value})} className="w-full border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none bg-slate-50 font-medium appearance-none"><option value="Staff">👨‍💻 พนักงาน (จ่าหน้าอย่างเดียว)</option><option value="Admin">💼 ผู้จัดการ (ดูสถิติได้)</option></select></div>
                  <button type="submit" className="btn-cute w-full bg-blue-600 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-500/30 text-lg">บันทึกข้อมูลพนักงาน</button>
                </form>
              </div>
            </div>
            <div className="w-full lg:w-2/3">
              <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-black mb-6 text-slate-800 flex items-center gap-2">👥 ทีมงานของคุณ</h2>
                <div className="overflow-hidden border border-slate-200 rounded-2xl">
                  <table className="w-full text-sm text-left"><thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider"><tr><th className="py-4 px-6">ชื่อ</th><th className="py-4 px-6">เบอร์โทร (ล็อกอิน)</th><th className="py-4 px-6">สิทธิ์</th><th className="py-4 px-6 text-center">จัดการ</th></tr></thead>
                    <tbody>
                      {staffList.length === 0 ? ( <tr><td colSpan="4" className="text-center py-12 text-slate-400 font-medium">ยังไม่มีพนักงานในระบบ...</td></tr>
                      ) : ( staffList.map((staff, idx) => (
                          <tr key={idx} className="border-t border-slate-100 hover:bg-blue-50/50 transition-colors">
                            <td className="py-4 px-6 font-bold text-slate-800">{staff.name}</td>
                            <td className="py-4 px-6 font-mono font-medium text-slate-600">{staff.phone}</td>
                            <td className="py-4 px-6"><span className={`px-3 py-1 rounded-full text-xs font-bold shadow-sm ${staff.role === 'Admin' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-700'}`}>{staff.role}</span></td>
                            <td className="py-4 px-6 text-center"><button onClick={() => handleDeleteStaff(staff.id)} className="btn-cute text-rose-500 hover:text-white font-bold text-xs bg-rose-50 hover:bg-rose-500 px-3 py-1.5 rounded-lg transition-colors">ลบออก</button></td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
         </div>
      ) : activeTab === 'billing' && userRole === 'SuperAdmin' ? (
         <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-amber-400">
           <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">💳 อนุมัติบิล (SuperAdmin)</h2>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
             {billingRequests.map((req, index) => (
               <div key={index} className="border border-amber-100 p-6 rounded-2xl bg-amber-50/30 relative card-hover">
                 <p className="font-bold text-slate-800">{req.data.email}</p><p className="text-xs text-slate-500 mb-5 font-medium">{req.data.createdAt?.toDate().toLocaleString('th-TH')}</p>
                 <div className="bg-white p-4 rounded-xl mb-5 flex justify-between shadow-sm border border-amber-100"><div><p className="text-xs text-slate-500 font-medium mb-1">แพ็กเกจ</p><p className="font-black text-blue-600 text-lg">{req.data.requestedQuota} <span className="text-sm">ใบ</span></p></div><div className="text-right"><p className="text-xs text-slate-500 font-medium mb-1">ยอดโอน</p><p className="font-black text-emerald-600 text-lg">฿{req.data.amount}</p></div></div>
                 <button onClick={() => handleApproveTopup(req.id, req.data.uid, req.data.requestedQuota)} className="btn-cute w-full bg-emerald-500 text-white font-bold py-3 rounded-xl shadow-lg shadow-emerald-500/30 flex items-center justify-center gap-2">✅ ยืนยันสลิป</button>
               </div>
             ))}
           </div>
         </div>
      ) : null}
    </div>
  );
}
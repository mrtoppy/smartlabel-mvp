import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

import { auth, db } from './firebase'; 
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { initializeApp, getApps } from "firebase/app";
import { collection, addDoc, getDocs, query, serverTimestamp, doc, getDoc, setDoc, where, updateDoc, increment, deleteDoc } from "firebase/firestore";

import generatePayload from 'promptpay-qr';

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
      } else { customerName = lines[0]; }
    }
  } else if (lines.length > 1) {
    customerName = lines[0];
    addressLines = lines.slice(1);
  }

  let items = [];
  const cleanedItemsPart = itemsPart.trim();
  if (cleanedItemsPart) {
    const itemSplitRegex = /(.+?(?:x\s*\d+|\d+\s*(?:ตัว|ชิ้น|กล่อง|ใบ|คู่|ชุด|แพ็ค|ขวด|ซอง)))(?:\s+|$)/gi;
    let match; let foundItems = [];
    while ((match = itemSplitRegex.exec(cleanedItemsPart)) !== null) { foundItems.push(match[1].trim()); }
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
  
  const [slipImage, setSlipImage] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  const [isAuthView, setIsAuthView] = useState(false); 
  const [authMode, setAuthMode] = useState('login'); 
  const [authType, setAuthType] = useState('merchant'); // 🔥 สลับโหมดร้านค้า(merchant) / ตัวแทน(partner)
  const [affiliateData, setAffiliateData] = useState(null); // ข้อมูลตัวแทน
  const [withdrawalHistory, setWithdrawalHistory] = useState([]); // ประวัติถอนเงิน

  // 🔥 ฟังก์ชันช่วยก๊อปปี้ข้อความ
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert('คัดลอกลงคลิปบอร์ดแล้ว! นำไปวาง(Paste) ได้เลยครับ 📋');
  };
  
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('maker'); 
  
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({ name: '', phone: '', address: '' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  const [historyOrders, setHistoryOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDate, setSelectedDate] = useState(null); // 🔥 เก็บค่าว่ากำลังคลิกดูสถิติของวันไหน
  const [reprintOrder, setReprintOrder] = useState(null);

  const [dashboardStats, setDashboardStats] = useState({ totalOrders: 0, codOrders: 0, totalCodAmount: 0, pieData: [], barData: [] });
  const [billingRequests, setBillingRequests] = useState([]);
  
  const [staffList, setStaffList] = useState([]);
  const [newStaff, setNewStaff] = useState({ name: '', phone: '', role: 'Staff' });

  // 🔥 State ใหม่สำหรับเก็บข้อมูลร้านค้าทั้งหมด (SuperAdmin)
  const [allShops, setAllShops] = useState([]);
  // 🔥 State สำหรับ SuperAdmin ดูข้อมูล Affiliate
  const [allAffiliates, setAllAffiliates] = useState([]);
  const [allWithdrawals, setAllWithdrawals] = useState([]);

  // ดึงข้อมูลตัวแทนและการถอนเงิน
  const loadAffiliateDataForAdmin = async () => {
    try {
      const qAff = query(collection(db, "users"), where("role", "==", "Affiliate"));
      const snapAff = await getDocs(qAff);
      const affList = []; snapAff.forEach(d => affList.push({id: d.id, ...d.data()}));
      setAllAffiliates(affList);

      const qW = query(collection(db, "withdrawals")); 
      const snapW = await getDocs(qW);
      const wList = []; snapW.forEach(d => wList.push({id: d.id, ...d.data()}));
      setAllWithdrawals(wList.sort((a,b) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
    } catch (error) { console.error("Error loading affiliate data:", error); }
  };

  // 🔥 State สำหรับคู่มือการใช้งาน (Onboarding Tutorial)
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const userRef = doc(db, "users", currentUser.uid);
          const userSnap = await getDoc(userRef);
            if (userSnap.exists()) {
            const data = userSnap.data();
            if (data.role === 'Affiliate') {
               setAffiliateData(data);
               // โหลดประวัติการแจ้งถอนเงินของ Partner คนนี้
               const qW = query(collection(db, "withdrawals"), where("affiliateId", "==", currentUser.uid));
               getDocs(qW).then(snap => {
                 const wList = []; snap.forEach(d => wList.push({id: d.id, ...d.data()}));
                 setWithdrawalHistory(wList.sort((a,b) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
               });
            }
            setUserRole(data.role); setQuota(data.quota || 0); setUserOwnerId(data.ownerId || currentUser.uid);
            if(data.role === 'SuperAdmin') setActiveTab('shops');
            
            // 🔥 ถ้าเครื่องนี้ยังไม่มีโปรไฟล์ ให้ดึงชื่อร้านตอนสมัครจาก Firestore มาใส่เป็นค่าเริ่มต้น
            if (!localStorage.getItem('smartlabel_profile') && data.storeName) {
              setStoreProfile({ name: data.storeName, phone: '', address: '' });
            }
            if (!localStorage.getItem(`has_seen_tutorial_${currentUser.uid}`) && data.role === 'Owner') {
              setShowTutorial(true);
            }
          } else {
            await setDoc(userRef, { email: currentUser.email, role: 'Owner', quota: 20, ownerId: currentUser.uid, createdAt: serverTimestamp() });
            setUserRole('Owner'); setQuota(20); setUserOwnerId(currentUser.uid); 
          }
        } catch (error) { console.error("Error:", error); }
      } else {
        setUser(null); setUserRole(''); setQuota(0); setUserOwnerId(null); setAffiliateData(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

useEffect(() => {
    const savedProfile = localStorage.getItem('smartlabel_profile');
    if (savedProfile) setStoreProfile(JSON.parse(savedProfile));

    // 🔥 [Affiliate Step 1.1] ดักจับ Referral Code จาก URL
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');
    
    if (refCode) {
      // แอบจดจำ Referral Code ไว้ในเครื่องลูกค้า
      // บังคับแปลงเป็นพิมพ์ใหญ่ทั้งหมด เพื่อป้องกันปัญหาตอนคนพิมพ์ลิงก์ผิด
      localStorage.setItem('smartlabel_ref', refCode.toUpperCase()); 
      
      // ทำความสะอาด URL ให้ดูเนียนตา
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const loadDashboardData = async () => {
    if (!userOwnerId || userRole === 'SuperAdmin') return; 
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

  // 🔥 ฟังก์ชันใหม่สำหรับ SuperAdmin เพื่อดึงข้อมูลร้านค้าทั้งหมด
  const loadAllShopsData = async () => {
    try {
      const q = query(collection(db, "users"), where("role", "==", "Owner"));
      const querySnapshot = await getDocs(q);
      const shops = [];
      querySnapshot.forEach((doc) => { shops.push({ id: doc.id, ...doc.data() }); });
      // เรียงจากร้านใหม่ล่าสุดไปเก่า
      shops.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      setAllShops(shops);
    } catch (error) { console.error("Error loading shops:", error); }
  };

  useEffect(() => { 
    if (activeTab === 'dashboard') loadDashboardData(); 
    if (activeTab === 'billing' && userRole === 'SuperAdmin') loadBillingRequests();
    if (activeTab === 'team' && userRole === 'Owner') loadStaffData();
    if (activeTab === 'shops' && userRole === 'SuperAdmin') loadAllShopsData();
    if (activeTab === 'affiliates' && userRole === 'SuperAdmin') loadAffiliateDataForAdmin();
  }, [activeTab, userRole, userOwnerId]);

  const handleAuth = async (e) => {
    e.preventDefault();
    const emailInput = e.target.email.value;
    const password = e.target.password.value;
    
    // แบ่งฟอร์แมตอีเมลตามประเภท (พาร์ทเนอร์ใช้เบอร์โทรล็อกอิน เราจะแอบต่อท้ายด้วย @partner... ให้ครับ)
    const domain = authType === 'partner' ? '@partner.smartlabel.com' : '@smartlabel.com';
    const formattedEmail = emailInput.includes('@') ? emailInput : `${emailInput}${domain}`;

    try {
      if (authMode === 'login') { 
        await signInWithEmailAndPassword(auth, formattedEmail, password); 
      } else {
        const userCredential = await createUserWithEmailAndPassword(auth, formattedEmail, password);
        
        if (authType === 'partner') {
           // 🔥 สร้างรหัสแนะนำ 6 ตัวอักษร สำหรับพาร์ทเนอร์
           const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
           const partnerName = e.target.partnerName.value;
           await setDoc(doc(db, "users", userCredential.user.uid), { 
              email: formattedEmail, role: 'Affiliate', ownerId: userCredential.user.uid,
              name: partnerName, phone: emailInput, referralCode: refCode,
              balance: 0, totalEarned: 0, referredCount: 0, paymentInfo: '',
              createdAt: serverTimestamp() 
           });
           alert(`🎉 สมัครพาร์ทเนอร์สำเร็จ! รหัสแนะนำของคุณคือ: ${refCode}`);
        } else {
           const storeName = e.target.storeName.value;
           await setDoc(doc(db, "users", userCredential.user.uid), { 
               email: formattedEmail, role: 'Owner', quota: 20, ownerId: userCredential.user.uid, 
               storeName: storeName, referredByCode: localStorage.getItem('smartlabel_ref') || '', 
               createdAt: serverTimestamp() 
           });
           const initialProfile = { name: storeName, phone: '', address: '' };
           setStoreProfile(initialProfile); localStorage.setItem('smartlabel_profile', JSON.stringify(initialProfile));
           alert("🎉 สมัครสมาชิกสำเร็จ! รับโควต้าทดลองใช้ฟรี 20 จ่าหน้าครับ");
        }
      }
    } catch (error) { alert(authMode === 'login' ? "ข้อมูลเข้าสู่ระบบไม่ถูกต้องครับ" : "เกิดข้อผิดพลาด หรือไอดีนี้ถูกใช้งานแล้วครับ"); }
  };

  const handleLogout = () => { 
    setActiveTab(userRole === 'SuperAdmin' ? 'shops' : 'maker'); 
    signOut(auth); 
  };

  const handleAddStaff = async (e) => {
    e.preventDefault();
    if (newStaff.phone.length !== 10) return alert("กรุณากรอกเบอร์โทรศัพท์ 10 หลักครับ");
    try {
      let secondaryApp; const appName = "SecondaryApp";
      if (getApps().find(a => a.name === appName)) { secondaryApp = getApps().find(a => a.name === appName); } 
      else { secondaryApp = initializeApp(auth.app.options, appName); }
      const secondaryAuth = getAuth(secondaryApp);
      const staffEmail = `${newStaff.phone}@smartlabel.com`;
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, staffEmail, '123456');
      const newUid = userCredential.user.uid;
      await setDoc(doc(db, "users", newUid), { email: staffEmail, name: newStaff.name, phone: newStaff.phone, role: newStaff.role, ownerId: user.uid, createdAt: serverTimestamp() });
      await signOut(secondaryAuth);
      alert(`เพิ่มพนักงานสำเร็จ! รหัสผ่านเริ่มต้นคือ: 123456`); setNewStaff({ name: '', phone: '', role: 'Staff' }); loadStaffData();
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
        querySnapshot.forEach((doc) => { if(doc.data().ownerId === userOwnerId) { historyData.push(doc.data()); } });
        if(historyData.length > 0) {
            historyData.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
            setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: historyData[0] } : o));
        } else { setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: null } : o)); }
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
      if (labelRefs.current[id]) { labelRefs.current[id].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
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
            rawText: order.rawText, adminEmail: user.email, storeName: storeProfile.name, customerName: order.parsedData.customerName, phone: order.parsedData.phone, address: order.parsedData.address, zipcode: order.parsedData.zipcode, items: order.parsedData.items, isCOD: order.parsedData.isCOD, codAmount: codNumber, ownerId: userOwnerId, createdAt: serverTimestamp() 
          });
        }
        if (userRole === 'Owner') {
          const userRef = doc(db, "users", user.uid);
          await updateDoc(userRef, { quota: increment(-readyToSaveOrders.length), usedQuota: increment(readyToSaveOrders.length) });
          setQuota(prev => prev - readyToSaveOrders.length);
        }
        setOrders(prev => prev.map(o => (o.parsedData && !o.isSaved && o.rawText.trim() !== '') ? { ...o, isSaved: true } : o));
      } catch (error) { alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลครับ"); }
    }
    window.print();
  };

  const handleEditHistory = (order) => { setOrders([{ id: Date.now(), rawText: order.rawText || '', parsedData: extractOrderData(order.rawText || ''), isSaved: false, crmSuggestion: null }, { id: Date.now() + 1, rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]); setActiveTab('maker'); window.scrollTo(0, 0); };
  const handleReprintHistory = (order) => { setReprintOrder(order); setTimeout(() => { window.print(); setReprintOrder(null); }, 300); };
  
// 🔥 ระบบกรองข้อมูลอัจฉริยะ (กรองตามวันที่คลิก และ คำค้นหา)
  const filteredOrders = historyOrders.filter(order => {
    // 1. กรองตามวันที่กดจากกราฟแท่ง
    if (selectedDate) {
      const orderDate = order.createdAt?.toDate().toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
      if (orderDate !== selectedDate) return false;
    }
    // 2. กรองตามช่องค้นหา (ชื่อ, เบอร์, ปณ, Tracking)
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const trackRef = `REF-${order.id.slice(-6).toUpperCase()}`.toLowerCase();
      return (
        (order.customerName || '').toLowerCase().includes(q) ||
        (order.phone || '').includes(q) ||
        (order.zipcode || '').includes(q) ||
        trackRef.includes(q)
      );
    }
    return true;
  });

  const handleExportCSV = () => {
    if (filteredOrders.length === 0) return alert("ไม่มีข้อมูลให้ดาวน์โหลดครับ");
    const headers = ["วันที่สร้าง", "หมายเลขพัสดุ", "ชื่อผู้รับ", "เบอร์โทร", "ที่อยู่", "รหัสไปรษณีย์", "รายการสินค้า", "ยอด COD", "แอดมิน"];
    const csvRows = filteredOrders.map(order => [ 
      order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH') : '-', 
      `REF-${order.id.slice(-6).toUpperCase()}`, 
      `"${order.customerName || ''}"`, 
      order.phone || '-', 
      `"${order.address || ''}"`, 
      order.zipcode || '-', 
      `"${(order.items || []).join(' | ')}"`, 
      order.isCOD ? order.codAmount : "0", 
      order.adminEmail || '-' 
    ].join(','));
    const blob = new Blob(["\uFEFF" + headers.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); 
    link.download = `SmartLabel_${selectedDate ? selectedDate.replace(/\//g, '-') : 'All'}.csv`; 
    link.click();
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsUploading(true);
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 500; 
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH; canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const base64Compressed = canvas.toDataURL('image/jpeg', 0.6); 
        setSlipImage(base64Compressed);
        setIsUploading(false);
      };
    };
  };

  const handleSubmitTopup = async () => {
    if (!slipImage) return alert("กรุณาแนบสลิปโอนเงิน เพื่อให้แอดมินตรวจสอบด้วยครับ 🧾");
    try {
      await addDoc(collection(db, "topups"), { 
        email: user.email, uid: user.uid, storeName: storeProfile.name, requestedQuota: selectedPackage, amount: selectedPackage === 100 ? 50 : 200, slipImage: slipImage, status: 'pending', createdAt: serverTimestamp() 
      });
      alert("✅ ส่งหลักฐานสำเร็จ! กรุณารอแอดมินอนุมัติครับ"); 
      setIsTopupOpen(false); setSlipImage(null); 
    } catch (error) { alert("เกิดข้อผิดพลาดในการส่งคำขอ"); }
  };

const handleApproveTopup = async (requestId, userId, requestedQuota, amount) => {
    try {
      await updateDoc(doc(db, "topups", requestId), { status: 'approved', approvedAt: serverTimestamp() });
      await updateDoc(doc(db, "users", userId), { quota: increment(requestedQuota) });

      // 🔥 [Affiliate] คำนวณคอมมิชชัน 10% ให้คนแนะนำ!
      const userSnap = await getDoc(doc(db, "users", userId));
      if (userSnap.exists() && userSnap.data().referredByCode) {
        const refCode = userSnap.data().referredByCode;
        const affQuery = query(collection(db, "users"), where("role", "==", "Affiliate"), where("referralCode", "==", refCode));
        const affSnap = await getDocs(affQuery);
        
        if (!affSnap.empty) {
          const affDoc = affSnap.docs[0];
          const commission = amount * 0.10; // หัก 10% ของยอดโอน
          await updateDoc(doc(db, "users", affDoc.id), {
            balance: increment(commission),
            totalEarned: increment(commission),
            referredCount: increment(1) // แอบเพิ่มยอดสะสมร้านค้าให้ด้วย
          });
        }
      }

      if (userId === user?.uid) setQuota(prev => prev + requestedQuota);
      loadBillingRequests(); 
      loadAllShopsData(); 
    } catch (error) { alert("เกิดข้อผิดพลาดในการอนุมัติ"); }
  };

  // 🔥 ฟังก์ชันกด "โอนเงินให้นักการตลาดแล้ว"
  const handleApproveWithdrawal = async (withdrawId) => {
    try {
      await updateDoc(doc(db, "withdrawals", withdrawId), { status: 'approved', approvedAt: serverTimestamp() });
      alert("✅ ยืนยันการโอนเงินให้นักการตลาดสำเร็จ!");
      loadAffiliateDataForAdmin();
    } catch(err) { alert("เกิดข้อผิดพลาด"); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-100 font-bold text-blue-600 animate-pulse">กำลังโหลดระบบ...</div>;

  if (!user && !isAuthView) {
    return (
      <div className="min-h-screen bg-white font-sans text-gray-900 selection:bg-blue-200">
        <style>{`@keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } } .animate-float { animation: float 3s ease-in-out infinite; } .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); } .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 10px 20px -10px rgba(59, 130, 246, 0.5); } .card-hover { transition: transform 0.3s ease, box-shadow 0.3s ease; } .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 30px -10px rgba(0,0,0,0.1); }`}</style>
        <nav className="flex justify-between items-center px-6 py-4 border-b"><div className="text-2xl font-black text-blue-800 flex items-center gap-2"><span className="animate-float inline-block">📦</span> SmartLabel</div><button onClick={() => setIsAuthView(true)} className="btn-cute bg-blue-600 text-white px-6 py-2 rounded-full font-bold">เข้าสู่ระบบ</button></nav>
        <header className="px-6 py-20 text-center bg-gradient-to-b from-blue-50 to-white"><h1 className="text-5xl md:text-7xl font-black text-blue-900 mb-6 leading-tight hover:scale-[1.01] transition-transform">จ่าหน้าพัสดุไวขึ้น 10 เท่า <br/> <span className="text-blue-600">ด้วยสมองกลอัจฉริยะ</span></h1><p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">สกัดชื่อที่อยู่จากแชทลูกค้าอัตโนมัติ พร้อมระบบจดจำลูกค้าเก่า (CRM) และสถิติครบวงจร เพื่อแม่ค้าออนไลน์มือโปรเช่นคุณ</p><button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute bg-blue-600 text-white text-xl px-12 py-4 rounded-full font-black shadow-xl animate-bounce mt-4">เริ่มทดลองใช้ฟรี 20 ใบ</button></header>
        <section className="py-20 px-6 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12"><div className="text-center group"><div className="text-6xl mb-4 group-hover:scale-125 group-hover:rotate-12 transition-transform duration-300 inline-block">🧠</div><h3 className="text-xl font-bold mb-2">Smart CRM</h3><p className="text-gray-500">พิมพ์แค่เบอร์โทร ข้อมูลชื่อและที่อยู่ลูกค้าเก่าเด้งขึ้นมาให้ทันที</p></div><div className="text-center group"><div className="text-6xl mb-4 group-hover:scale-125 group-hover:-translate-y-2 transition-transform duration-300 inline-block">🖨️</div><h3 className="text-xl font-bold mb-2">Thermal Ready</h3><p className="text-gray-500">ออกแบบมาเพื่อเครื่องพิมพ์ความร้อน พิมพ์ออกมาสวยเป๊ะทุกใบ</p></div><div className="text-center group"><div className="text-6xl mb-4 group-hover:scale-125 group-hover:rotate-[-12deg] transition-transform duration-300 inline-block">📊</div><h3 className="text-xl font-bold mb-2">Dashboard & Export</h3><p className="text-gray-500">ดูยอดส่งรายวัน และดาวน์โหลดข้อมูลเป็น Excel ได้ในคลิกเดียว</p></div></section>
        <section className="py-24 bg-slate-50 border-t border-slate-100"><div className="max-w-4xl mx-auto px-6 text-center"><h2 className="text-4xl font-black mb-12 text-slate-800">ราคาแพ็กเกจที่คุณเลือกได้</h2><div className="grid grid-cols-1 md:grid-cols-2 gap-8"><div className="bg-white p-10 rounded-3xl shadow-lg border border-slate-200 card-hover flex flex-col justify-between"><div><p className="text-blue-600 font-bold mb-4 tracking-widest uppercase text-sm">เริ่มต้นเบาๆ</p><p className="text-6xl font-black mb-4 text-slate-800">฿50</p><p className="text-slate-500 mb-8 font-medium">ได้รับ 100 จ่าหน้า <br/> <span className="text-sm">(เพียง 0.5 บาท/ใบ)</span></p></div><button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-xl border-2 border-blue-600 text-blue-600 font-bold hover:bg-blue-50">เริ่มต้นใช้งาน</button></div><div className="bg-white p-10 rounded-3xl shadow-2xl border-4 border-blue-600 relative overflow-hidden card-hover transform md:-translate-y-4 flex flex-col justify-between"><div className="absolute top-0 right-0 bg-blue-600 text-white px-6 py-2 font-black text-sm rounded-bl-2xl shadow-sm tracking-widest">ยอดฮิต 🔥</div><div><p className="text-blue-600 font-bold mb-4 tracking-widest uppercase text-sm">คุ้มค่าที่สุด</p><p className="text-6xl font-black mb-4 text-slate-800">฿200</p><p className="text-slate-500 mb-8 font-medium">ได้รับ 500 จ่าหน้า <br/> <span className="text-sm">(เพียง 0.4 บาท/ใบ)</span></p></div><button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-xl bg-blue-600 text-white font-bold shadow-lg shadow-blue-500/40">เลือกแพ็กเกจนี้</button></div></div><div className="mt-12 text-slate-500 font-medium bg-white p-6 rounded-2xl shadow-sm border border-slate-200 inline-block">ต้องการส่งไม่จำกัดจำนวน? แพ็กเกจ Unlimited ฿299/เดือน <button className="text-blue-600 font-bold hover:underline ml-2">ติดต่อทีมงาน</button></div></div></section>
          <footer className="py-12 bg-white border-t border-slate-100 flex flex-col items-center gap-4 text-slate-400 text-sm font-medium">
          <p>© 2026 ToppySmart Logistics. พัฒนาโดยพาร์ทเนอร์ & CTO Copilot</p>
          <button onClick={() => { setIsAuthView(true); setAuthType('partner'); setAuthMode('login'); }} className="text-indigo-500 font-bold hover:underline flex items-center gap-1">🤝 ระบบจัดการรายได้สำหรับนักการตลาด (Partner Login)</button>
        </footer>
      </div>
    );
  }

  if (!user && isAuthView) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center p-6 font-sans relative transition-colors duration-500 ${authType === 'partner' ? 'bg-indigo-900' : 'bg-blue-900'}`}>
        <style>{`.btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); } .btn-cute:hover { transform: scale(1.05); }`}</style>
        <button onClick={() => setIsAuthView(false)} className="absolute top-6 left-6 text-white/50 hover:text-white font-bold transition hover:-translate-x-1">← กลับหน้าหลัก</button>
        <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md animate-[fadeIn_0.5s_ease-out]">
          <div className="text-center mb-6">
            <h1 className={`text-4xl font-extrabold mb-2 flex justify-center items-center gap-2 ${authType === 'partner' ? 'text-indigo-600' : 'text-blue-800'}`}>
              {authType === 'partner' ? <><span className="animate-bounce inline-block">🤝</span> Partner</> : <><span className="animate-bounce inline-block">📦</span> SmartLabel</>}
            </h1>
            <p className="text-gray-500 font-bold">
              {authType === 'partner' ? (authMode === 'login' ? 'ระบบจัดการรายได้นักการตลาด' : 'สมัครเป็นพาร์ทเนอร์กับเรา') : (authMode === 'login' ? 'ยินดีต้อนรับกลับมา!' : 'เริ่มต้นความสำเร็จไปกับเรา')}
            </p>
          </div>
          <form onSubmit={handleAuth}>
            {authMode === 'register' && authType === 'merchant' && (<div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-1">ชื่อร้านค้าของคุณ</label><input name="storeName" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-200 outline-none bg-gray-50 transition-all" placeholder="เช่น ToppySmart Shop" /></div>)}
            {authMode === 'register' && authType === 'partner' && (<div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-1">ชื่อ-นามสกุล (พาร์ทเนอร์)</label><input name="partnerName" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-indigo-200 outline-none bg-gray-50 transition-all" placeholder="เช่น นิชาภา สอนชา" /></div>)}
            <div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-1">{authType === 'partner' ? 'เบอร์โทรศัพท์ (ID)' : (authMode === 'login' ? 'อีเมล หรือ เบอร์โทรศัพท์' : 'อีเมลของคุณ')}</label><input name="email" type="text" required className={`w-full border p-3 rounded-xl focus:ring-4 outline-none bg-gray-50 transition-all ${authType === 'partner' ? 'focus:ring-indigo-200' : 'focus:ring-blue-200'}`} placeholder={authType === 'partner' ? "089xxxxxxx" : (authMode === 'login' ? "เบอร์โทรศัพท์ หรือ อีเมล" : "owner@mail.com")} /></div>
            <div className="mb-6"><label className="block text-sm font-bold text-gray-700 mb-1">รหัสผ่าน</label><input name="password" type="password" required className={`w-full border p-3 rounded-xl focus:ring-4 outline-none bg-gray-50 transition-all ${authType === 'partner' ? 'focus:ring-indigo-200' : 'focus:ring-blue-200'}`} placeholder="••••••••" /></div>
            <button type="submit" className={`btn-cute w-full text-white font-bold py-3 rounded-xl shadow-lg ${authType === 'partner' ? 'bg-indigo-600 hover:shadow-indigo-500/50' : 'bg-blue-600 hover:shadow-blue-500/50'}`}>{authMode === 'login' ? 'เข้าสู่ระบบ' : '✨ สมัครสมาชิกฟรี'}</button>
          </form>
          <div className="mt-6 text-center border-t pt-4">
            {authMode === 'login' ? <p className="text-sm text-gray-600">{authType === 'partner' ? 'พาร์ทเนอร์ใหม่?' : 'เจ้าของร้านคนใหม่?'} <button onClick={() => setAuthMode('register')} className={`font-bold hover:underline ${authType === 'partner' ? 'text-indigo-600' : 'text-blue-600'}`}>ลงทะเบียนที่นี่</button></p> : <p className="text-sm text-gray-600">มีบัญชีอยู่แล้ว? <button onClick={() => setAuthMode('login')} className={`font-bold hover:underline ${authType === 'partner' ? 'text-indigo-600' : 'text-blue-600'}`}>เข้าสู่ระบบ</button></p>}
            {authType === 'partner' && <button type="button" onClick={() => { setAuthType('merchant'); setAuthMode('login'); }} className="mt-4 text-xs text-slate-400 hover:text-slate-600 underline">กลับหน้าล็อกอินร้านค้าปกติ</button>}
          </div>
        </div>
      </div>
    );
  }

  if (reprintOrder) {
    return (
      <div className="bg-white min-h-screen">
        <style>{`@media print { @page { size: 100mm 150mm; margin: 0; } body, html { background-color: white; margin: 0; padding: 0; -webkit-print-color-adjust: exact; } .thermal-label { width: 100mm !important; min-height: 148mm !important; height: auto !important; padding: 5mm !important; box-sizing: border-box !important; margin: 0 !important; border: none !important; box-shadow: none !important; page-break-after: always; page-break-inside: avoid; } }`}</style>
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
  // --- Affiliate Partner Dashboard ---
  const handleWithdrawRequest = async (e) => {
     e.preventDefault();
     const promptpay = e.target.promptpay.value;
     const amount = parseFloat(e.target.amount.value);
     if(amount < 100) return alert("ขั้นต่ำในการถอน 100 บาทครับ");
     if(amount > affiliateData.balance) return alert("ยอดเงินในบัญชีไม่พอครับ");

     try {
       await addDoc(collection(db, "withdrawals"), {
          affiliateId: user.uid, affiliateName: affiliateData.name, paymentInfo: promptpay,
          amount: amount, status: 'pending', createdAt: serverTimestamp()
       });
       // ตัดยอด balance ใน users
       await updateDoc(doc(db, "users", user.uid), { balance: increment(-amount) });
       setAffiliateData(prev => ({...prev, balance: prev.balance - amount}));
       alert("ส่งคำขอถอนเงินสำเร็จ! กรุณารอแอดมินตรวจสอบครับ");
       
       // โหลดประวัติใหม่
       const qW = query(collection(db, "withdrawals"), where("affiliateId", "==", user.uid));
       const snap = await getDocs(qW);
       const wList = []; snap.forEach(d => wList.push({id: d.id, ...d.data()}));
       setWithdrawalHistory(wList.sort((a,b) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
       e.target.reset();
     } catch (error) { alert("เกิดข้อผิดพลาดในการแจ้งถอนเงิน"); }
  };

  if (userRole === 'Affiliate' && affiliateData) {
    const refLink = `${window.location.origin}/?ref=${affiliateData.referralCode}`;
    const adText = `📦 จบปัญหาหลังบ้านร้านค้าออนไลน์ที่วุ่นวาย! ด้วย SmartLabel ระบบสร้างจ่าหน้าอัจฉริยะ\n✅ ดึงชื่อที่อยู่จากแชทอัตโนมัติ\n✅ จำลูกค้าเก่า (CRM) ไม่ต้องพิมพ์ใหม่\n✅ โหลดไฟล์ Excel ทำบัญชีได้ทันที\n🎁 สมัครวันนี้ รับโควต้าจ่าหน้าฟรี 20 ใบ!\n👉 สมัครเลย: ${refLink}`;

    return (
      <div className="min-h-screen bg-slate-50 p-6 font-sans">
        <header className="flex justify-between items-center bg-white p-5 rounded-2xl shadow-sm border border-slate-100 mb-6">
          <h1 className="text-2xl font-black text-indigo-600 flex items-center gap-2">🤝 Partner Dashboard</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm font-bold text-slate-600">ID: <span className="text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{affiliateData.referralCode}</span></span>
            <button onClick={() => { setActiveTab('maker'); signOut(auth); }} className="btn-cute bg-rose-50 text-rose-600 px-5 py-2 rounded-xl font-bold text-sm hover:bg-rose-100">ออก 🚪</button>
          </div>
        </header>

        <div className="bg-orange-500 text-white p-4 rounded-2xl shadow-md mb-6 text-center font-bold text-lg">
          💰 พื้นที่สำหรับการตลาด (Affiliate Partner)
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
           <div className="bg-gradient-to-br from-orange-500 to-orange-600 p-8 rounded-3xl shadow-lg text-white relative overflow-hidden">
             <div className="absolute -right-6 -bottom-6 text-8xl opacity-20">💸</div>
             <p className="font-bold text-orange-100 mb-2">ยอดเงินที่ถอนได้ (Balance)</p>
             <p className="text-5xl font-black">{affiliateData.balance.toLocaleString()} <span className="text-xl">THB</span></p>
           </div>
           <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 flex flex-col justify-center">
             <p className="font-bold text-slate-500 mb-2">รายได้สะสมตลอดกาล (Total Earned)</p>
             <p className="text-4xl font-black text-slate-800 mb-2">{affiliateData.totalEarned.toLocaleString()} <span className="text-xl">THB</span></p>
             <p className="text-sm font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg inline-block self-start">✨ แนะนำสำเร็จแล้ว: {affiliateData.referredCount} ร้านค้า</p>
           </div>
        </div>

        <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 mb-6">
           <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center gap-2">🎯 อาวุธสำหรับการตลาด</h2>
           
           <div className="mb-6">
              <p className="font-bold text-slate-700 mb-2">1. ลิงก์แนะนำส่วนตัวของคุณ (รหัสลับ: <span className="text-indigo-600">{affiliateData.referralCode}</span>)</p>
              <div className="flex gap-2">
                 <input type="text" readOnly value={refLink} className="flex-1 border border-slate-200 bg-slate-50 p-3 rounded-xl text-slate-600 font-mono text-sm outline-none" />
                 <button onClick={() => copyToClipboard(refLink)} className="btn-cute bg-indigo-600 text-white font-bold px-6 rounded-xl shadow-md hover:bg-indigo-700">📋 คัดลอกลิงก์</button>
              </div>
           </div>

           <div>
              <p className="font-bold text-slate-700 mb-2">2. ไอเดียข้อความโพสต์ Facebook / Line</p>
              <div className="bg-yellow-50/50 border border-yellow-200 p-5 rounded-2xl relative">
                 <pre className="text-sm text-slate-700 font-sans whitespace-pre-wrap">{adText}</pre>
                 <button onClick={() => copyToClipboard(adText)} className="btn-cute mt-4 bg-orange-500 text-white font-bold px-4 py-2 rounded-lg text-sm shadow-md hover:bg-orange-600">📋 คัดลอกข้อความ</button>
              </div>
           </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
           <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
             <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center gap-2">🏦 แจ้งถอนเงินเข้าบัญชี</h2>
             <form onSubmit={handleWithdrawRequest}>
                <div className="mb-4">
                  <label className="block text-sm font-bold text-slate-700 mb-2">เบอร์พร้อมเพย์ หรือ เลขบัญชีธนาคาร</label>
                  <input name="promptpay" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-orange-100 outline-none transition-all bg-slate-50 focus:bg-white" placeholder="เช่น 0891234567 (กสิกรไทย)" />
                </div>
                <div className="mb-6">
                  <label className="block text-sm font-bold text-slate-700 mb-2">ยอดเงินที่ต้องการถอน (ขั้นต่ำ 100 บาท)</label>
                  <input name="amount" type="number" required min="100" max={affiliateData.balance} className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-orange-100 outline-none transition-all bg-slate-50 focus:bg-white" placeholder="0.00" />
                </div>
                <button type="submit" className="btn-cute w-full bg-slate-800 text-white font-black py-4 rounded-xl shadow-lg hover:bg-slate-900 transition-colors">🚀 แจ้งถอนเงิน</button>
             </form>
           </div>
           
           <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
             <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center gap-2">📄 ประวัติการถอนเงิน</h2>
             <div className="overflow-hidden border border-slate-100 rounded-2xl max-h-64 overflow-y-auto">
               <table className="w-full text-sm text-left">
                 <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr><th className="py-3 px-4">วันที่</th><th className="py-3 px-4 text-right">ยอดเงิน</th><th className="py-3 px-4 text-center">สถานะ</th></tr></thead>
                 <tbody>
                   {withdrawalHistory.length === 0 ? (
                     <tr><td colSpan="3" className="text-center py-8 text-slate-400">ยังไม่มีประวัติการแจ้งถอนเงิน</td></tr>
                   ) : (
                     withdrawalHistory.map((item, idx) => (
                       <tr key={idx} className="border-t border-slate-50">
                         <td className="py-3 px-4 text-slate-500 text-xs">{item.createdAt ? item.createdAt.toDate().toLocaleDateString('th-TH') : '-'}</td>
                         <td className="py-3 px-4 text-right font-black text-slate-700">฿{item.amount.toLocaleString()}</td>
                         <td className="py-3 px-4 text-center">
                           <span className={`px-2 py-1 rounded text-[10px] font-bold ${item.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{item.status === 'approved' ? 'โอนแล้ว' : 'รอตรวจสอบ'}</span>
                         </td>
                       </tr>
                     ))
                   )}
                 </tbody>
               </table>
             </div>
           </div>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans print:bg-white print:p-0 relative">
      <style>{`
        @media print { @page { size: 100mm 150mm; margin: 0; } body, html { background-color: white; margin: 0; padding: 0; -webkit-print-color-adjust: exact; } ::-webkit-scrollbar { display: none; } .thermal-label { width: 100mm !important; min-height: 148mm !important; height: auto !important; padding: 5mm !important; box-sizing: border-box !important; page-break-after: always !important; page-break-inside: avoid !important; margin: 0 !important; border: none !important; box-shadow: none !important; } }
        .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 5px 15px -5px rgba(0,0,0,0.2); }
        .card-hover { transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); }
        .modal-enter { animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      `}</style>

      {/* 🔥 The "WOW" Onboarding Tutorial */}
      {showTutorial && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-[100] print:hidden">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-lg w-full text-center modal-enter relative overflow-hidden">
            {/* วงกลมตกแต่งฉากหลัง */}
            <div className="absolute -top-20 -right-20 w-40 h-40 bg-blue-100 rounded-full blur-2xl opacity-50 pointer-events-none"></div>
            <div className="absolute -bottom-20 -left-20 w-40 h-40 bg-indigo-100 rounded-full blur-2xl opacity-50 pointer-events-none"></div>
            
            {/* เนื้อหาคู่มือ */}
            <div className="relative z-10 min-h-[250px] flex flex-col items-center justify-center">
              {tutorialStep === 0 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4 animate-bounce">⚙️</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">1. ตั้งค่าร้านค้าให้เป๊ะ!</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">เริ่มต้นด้วยการกดปุ่ม <span className="font-bold text-blue-600">"ตั้งค่าร้าน"</span> (มุมขวาบน) เพื่อใส่ชื่อ เบอร์โทร และที่อยู่ของคุณให้ครบถ้วน เพื่อให้ไปแสดงบนใบจ่าหน้าอย่างสวยงาม</p>
                </div>
              )}
              {tutorialStep === 1 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4 hover:scale-110 transition-transform">👥</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">2. สร้างทีมงานแพ็กของ</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">ไปที่แท็บ <span className="font-bold text-blue-600">"พนักงาน"</span> เพื่อเพิ่มลูกน้องเข้าสู่ระบบ พวกเขาจะล็อกอินด้วยเบอร์โทรได้ทันที โดยไม่เห็นข้อมูลโควต้าและการเงินของร้าน!</p>
                </div>
              )}
              {tutorialStep === 2 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4">✍️</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">3. วางแชท สกัดจ่าหน้า</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">ก๊อปปี้ที่อยู่ลูกค้ามาวาง ระบบจะแยกชื่อ เบอร์โทร และรหัสไปรษณีย์ให้อัตโนมัติ <br/><span className="text-rose-500 font-bold">อย่าลืม!</span> ตรวจสอบความถูกต้องก่อนกดบันทึกและสั่งพิมพ์นะ</p>
                </div>
              )}
              {tutorialStep === 3 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4 animate-float">🚀</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">4. โควต้าหมด? เติมได้เลย</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">ถ้าจ่าหน้าใกล้หมด กดปุ่ม <span className="font-bold text-indigo-600">"+ เติมโควต้า"</span> สแกนจ่ายผ่านคิวอาร์โค้ด แล้วอัปโหลดรูปสลิปส่งให้แอดมินอนุมัติได้ง่ายๆ ไม่กี่วินาที</p>
                </div>
              )}
              {tutorialStep === 4 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4">📊</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">5. วิเคราะห์ยอดขาย</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">เช็คสถิติการส่ง แยกยอดโอนและยอด COD รายวันได้ที่แท็บ <span className="font-bold text-blue-600">"สถิติ"</span> พร้อมดาวน์โหลดประวัติเป็น Excel ไปทำบัญชีต่อได้ทันที</p>
                </div>
              )}
            </div>

            {/* จุดบอกสถานะ (Dots) */}
            <div className="flex justify-center gap-2 mt-6 mb-8">
              {[0, 1, 2, 3, 4].map((step) => (
                <div key={step} className={`w-2.5 h-2.5 rounded-full transition-colors ${tutorialStep === step ? 'bg-blue-600 w-6' : 'bg-slate-200'}`}></div>
              ))}
            </div>

            {/* ปุ่มควบคุม */}
            <div className="flex justify-between gap-4">
              <button 
                onClick={() => setTutorialStep(prev => Math.max(0, prev - 1))} 
                className={`px-6 py-3 rounded-xl font-bold transition-opacity ${tutorialStep === 0 ? 'opacity-0 cursor-default' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                disabled={tutorialStep === 0}
              >
                ย้อนกลับ
              </button>
              
              {tutorialStep < 4 ? (
                <button 
                  onClick={() => setTutorialStep(prev => prev + 1)} 
                  className="flex-1 bg-blue-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition-transform active:scale-95"
                >
                  ถัดไป 👉
                </button>
              ) : (
                <button 
                  onClick={() => {
                    localStorage.setItem(`has_seen_tutorial_${user.uid}`, 'true');
                    setShowTutorial(false);
                    setIsSettingsOpen(true); // 🔥 ปิดคู่มือปุ๊บ บังคับเด้งหน้าตั้งค่าร้านทันที!
                  }} 
                  className="flex-1 bg-emerald-500 text-white px-6 py-3 rounded-xl font-black shadow-lg shadow-emerald-500/30 hover:bg-emerald-600 transition-transform active:scale-95 animate-pulse"
                >
                  เริ่มลุยกันเลย! 🎉
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      
      {isTopupOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md flex items-center justify-center z-50 print:hidden transition-opacity">
          <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-lg modal-enter max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">🚀 เติมแพ็กเกจจ่าหน้า</h2>
              <button onClick={() => { setIsTopupOpen(false); setSlipImage(null); }} className="text-gray-400 hover:text-rose-500 hover:rotate-90 transition-transform font-bold text-2xl">&times;</button>
            </div>
            
            <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-100 p-4 rounded-2xl mb-6 text-center card-hover">
              <p className="text-indigo-600 font-medium mb-1">โควต้าปัจจุบันของคุณ</p>
              <p className="text-4xl font-extrabold text-indigo-700">{quota} <span className="text-lg font-normal">ใบ</span></p>
            </div>

            <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><span className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span> เลือกแพ็กเกจสุดคุ้ม</h3>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div onClick={() => setSelectedPackage(100)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 100 ? 'border-blue-500 bg-blue-50 scale-[1.03] shadow-md shadow-blue-500/20' : 'border-gray-200 hover:border-blue-300 hover:bg-slate-50'}`}>
                {selectedPackage === 100 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">เลือกอยู่</div>}
                <p className={`font-black text-2xl ${selectedPackage === 100 ? 'text-blue-700' : 'text-slate-700'}`}>100 ใบ</p>
                <p className="text-sm text-slate-500 mt-1 font-medium">50 บาท</p>
              </div>
              <div onClick={() => setSelectedPackage(500)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 500 ? 'border-blue-500 bg-blue-50 scale-[1.03] shadow-md shadow-blue-500/20' : 'border-gray-200 hover:border-blue-300 hover:bg-slate-50'}`}>
                {selectedPackage === 500 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">ยอดฮิต 🔥</div>}
                <p className={`font-black text-2xl ${selectedPackage === 500 ? 'text-blue-700' : 'text-slate-700'}`}>500 ใบ</p>
                <p className="text-sm text-slate-500 mt-1 font-medium">200 บาท</p>
              </div>
            </div>

            <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><span className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span> สแกน QR ชำระเงิน</h3>
              <div className="flex flex-col items-center bg-slate-50 p-5 rounded-2xl border border-slate-200 mb-6">
              <div className="bg-white p-3 rounded-xl shadow-sm mb-3 border border-slate-100">
                {/* 🎯 สร้างรหัส PromptPay อัตโนมัติ (ใส่เบอร์พาร์ทเนอร์ และยอดเงิน) */}
                <QRCodeSVG 
                  value={generatePayload("0874484448", { amount: selectedPackage === 100 ? 50 : 200 })} 
                  size={130} 
                />
              </div>
              <p className="text-sm font-black text-slate-800">พร้อมเพย์: ท็อปปี้สมาร์ท โลจิสติกส์</p>
              <p className="text-lg font-black text-emerald-600 mt-1 bg-emerald-50 px-4 py-1 rounded-full border border-emerald-100">
                ยอดชำระ: ฿{selectedPackage === 100 ? '50.00' : '200.00'}
              </p>
            </div>

            <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><span className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span> แนบหลักฐานการโอนเงิน</h3>
            <div className="mb-8">
              {slipImage ? (
                <div className="relative rounded-2xl overflow-hidden border-2 border-emerald-500 group">
                  <img src={slipImage} alt="Slip" className="w-full h-48 object-cover" />
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setSlipImage(null)} className="btn-cute bg-white text-rose-600 font-bold px-4 py-2 rounded-lg text-sm">เปลี่ยนรูปภาพ</button>
                  </div>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-blue-300 rounded-2xl cursor-pointer bg-blue-50/50 hover:bg-blue-50 transition-colors group">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <span className="text-3xl mb-2 group-hover:scale-125 transition-transform">📸</span>
                    <p className="mb-1 text-sm text-blue-600 font-bold"><span className="underline">คลิกที่นี่</span> เพื่อเลือกรูปสลิป</p>
                    <p className="text-xs text-slate-400">รองรับไฟล์ JPG, PNG</p>
                  </div>
                  <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                </label>
              )}
              {isUploading && <p className="text-center text-xs text-blue-500 font-bold mt-2 animate-pulse">กำลังประมวลผลรูปภาพ...</p>}
            </div>

            <button onClick={handleSubmitTopup} disabled={!slipImage || isUploading} className={`btn-cute w-full font-bold py-4 rounded-xl shadow-lg text-lg flex justify-center items-center gap-2 ${(!slipImage || isUploading) ? 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none' : 'bg-blue-600 text-white shadow-blue-500/30 hover:bg-blue-700'}`}>
              🚀 ยืนยันการชำระเงิน
            </button>
          </div>
        </div>
      )}

      {/* Header Panel */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md animate-[fadeIn_0.3s_ease-out]">
            <h2 className="text-2xl font-bold mb-6 text-gray-800">⚙️ ตั้งค่าข้อมูลร้านค้า</h2>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-2">ชื่อร้านค้า (ผู้ส่ง)</label>
              <input type="text" className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" value={tempProfile.name} onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})} placeholder="กรอกชื่อร้านค้าของคุณ..." />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-2">เบอร์โทรศัพท์ <span className="text-rose-500 text-xs ml-1">*จำเป็น</span></label>
              <input type="text" className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none transition-all bg-yellow-50 focus:bg-white" value={tempProfile.phone} onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})} placeholder="เช่น 0891234567 (ติดต่อกรณีพัสดุมีปัญหา)" />
            </div>
            <div className="mb-8">
              <label className="block text-sm font-bold text-gray-700 mb-2">ที่อยู่ร้านค้า <span className="text-rose-500 text-xs ml-1">*จำเป็น</span></label>
              <textarea className="w-full border p-3 rounded-xl h-24 resize-none focus:ring-4 focus:ring-blue-100 outline-none transition-all bg-yellow-50 focus:bg-white" value={tempProfile.address} onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})} placeholder="กรอกที่อยู่สำหรับจ่าหน้าผู้ส่ง หรือกรณีพัสดุตีกลับ..." />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setIsSettingsOpen(false)} className="btn-cute px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-bold">ยกเลิก</button>
              <button onClick={handleSaveProfile} className="btn-cute px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg shadow-blue-500/30">💾 บันทึก</button>
            </div>
          </div>
        </div>
      )}
      <header className="mb-6 bg-white p-5 rounded-2xl shadow-sm border border-gray-100 print:hidden">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-5">
          <div>
            <h1 className="text-3xl font-black text-blue-800 flex items-center gap-2">📦 SmartLabel <span className={`text-xs px-3 py-1 rounded-full font-bold shadow-sm ${userRole === 'SuperAdmin' ? 'bg-gradient-to-r from-rose-500 to-red-600 text-white shadow-red-500/30' : userRole === 'Owner' ? 'bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white shadow-purple-500/30' : userRole === 'Admin' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}`}>{userRole}</span></h1>
            <p className="text-slate-500 text-sm mt-1 font-medium">ผู้ใช้งาน: {user.email.replace('@smartlabel.com', '')}</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            {/* 🔥 แผงปุ่มเมนู เปลี่ยนไปตาม Role (ซ่อนเมนูไม่จำเป็นของ SuperAdmin) */}
            <div className="flex bg-slate-100 p-1.5 rounded-xl">
              
              {/* พนักงานทั่วไป และ เจ้าของร้าน */}
              {userRole !== 'SuperAdmin' && (
                <>
                  <button onClick={() => setActiveTab('maker')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'maker' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>✍️ สร้างจ่าหน้า</button>
                  <button onClick={() => setActiveTab('dashboard')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>📊 สถิติ</button>
                </>
              )}
              
              {/* เฉพาะเจ้าของร้าน ถึงเห็นเมนูจัดการลูกน้อง */}
              {userRole === 'Owner' && (
                <button onClick={() => setActiveTab('team')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'team' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>👥 พนักงาน</button>
              )}

              {/* 👑 เฉพาะพระเจ้า (SuperAdmin) จะเห็นหน้าร้านค้า และ การอนุมัติบิล */}
              {userRole === 'SuperAdmin' && (
                <>
                  <button onClick={() => setActiveTab('shops')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'shops' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>🏢 จัดการร้านค้า</button>
                  <button onClick={() => setActiveTab('affiliates')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'affiliates' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>🤝 ระบบตัวแทน</button>
                  <button onClick={() => setActiveTab('billing')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 transition-all ${activeTab === 'billing' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>💳 อนุมัติบิล {billingRequests.length > 0 && <span className="bg-rose-500 text-white px-2 py-0.5 rounded-full text-xs shadow-md animate-bounce">{billingRequests.length}</span>}</button>
                </>
              )}
            </div>
            <button onClick={handleLogout} className="btn-cute bg-rose-50 text-rose-600 px-5 py-3 rounded-xl font-bold text-sm hover:bg-rose-100 transition-colors">ออก 🚪</button>
          </div>
        </div>
        
        {/* 🔥 ซ่อนแถบแสดงโควต้าและตั้งค่าร้าน ไม่ให้ SuperAdmin เห็น */}
        {userRole === 'Owner' && (
          <div className="flex justify-between items-center bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-xl border border-blue-100 shadow-inner">
            <div className="text-sm flex items-center gap-4">
                <div className="font-black text-indigo-700 bg-white px-5 py-2.5 rounded-xl shadow-sm flex items-center gap-3 border border-indigo-50">
                  🎫 โควต้าคงเหลือ: <span className={`text-xl ${quota <= 5 ? 'text-rose-500 animate-pulse' : 'text-indigo-900'}`}>{quota} <span className="text-sm font-bold text-indigo-400">ใบ</span></span>
                  <button onClick={() => setIsTopupOpen(true)} className="btn-cute ml-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs shadow-md shadow-indigo-500/30">➕ เติมโควต้า</button>
                </div>
              <span className="text-slate-600 font-medium hidden md:inline-block"><span className="text-slate-400 mr-2">📍 ร้าน:</span>{storeProfile.name}</span>
            </div>
            <button onClick={() => { setTempProfile(storeProfile); setIsSettingsOpen(true); }} className="btn-cute bg-white border border-slate-200 text-slate-700 px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:bg-slate-50 transition-colors">⚙️ ตั้งค่าร้าน</button>
          </div>
        )}
      </header>

      {/* --- Tab Content --- */}

      {/* 🔥 Tab ใหม่: จัดการร้านค้าทั้งหมด (SuperAdmin Only) */}
      {activeTab === 'shops' && userRole === 'SuperAdmin' ? (
         <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-blue-500">
           <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">🏢 รายชื่อร้านค้าในระบบ (Tenants)</h2>
           <div className="overflow-hidden border border-slate-200 rounded-2xl">
             <table className="w-full text-sm text-left">
               <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider">
                 <tr>
                   <th className="py-4 px-6">ชื่อร้านค้า (Store Name)</th>
                   <th className="py-4 px-6">อีเมลเจ้าของ (Owner)</th>
                   <th className="py-4 px-6 text-center">วันที่สมัคร</th>
                   <th className="py-4 px-6 text-center">ใช้ไปแล้ว (ใบ)</th>
                   <th className="py-4 px-6 text-center">โควต้าคงเหลือ</th>
                 </tr>
               </thead>
               <tbody>
                 {allShops.length === 0 ? ( 
                   <tr><td colSpan="4" className="text-center py-12 text-slate-400 font-medium">ยังไม่มีร้านค้าในระบบ...</td></tr>
                 ) : ( 
                   allShops.map((shop, idx) => (
                     <tr key={idx} className="border-t border-slate-100 hover:bg-blue-50/50 transition-colors">
                       <td className="py-4 px-6 font-bold text-slate-800 text-lg">{shop.storeName || <span className="text-slate-400 italic">ไม่ระบุ</span>}</td>
                       <td className="py-4 px-6 font-mono font-medium text-slate-600">{shop.email}</td>
                      <td className="py-4 px-6 text-center text-slate-500">{shop.createdAt ? shop.createdAt.toDate().toLocaleDateString('th-TH') : '-'}</td>
                      <td className="py-4 px-6 text-center font-black text-blue-600 text-lg">{shop.usedQuota || 0}</td>
                      <td className="py-4 px-6 text-center">
                         <span className={`px-4 py-2 rounded-xl font-black text-lg shadow-sm ${shop.quota <= 5 ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'}`}>
                           {shop.quota || 0}
                         </span>
                       </td>
                     </tr>
                   ))
                 )}
               </tbody>
             </table>
           </div>
         </div>
      ) : activeTab === 'maker' ? (
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
            {/* 1. สรุปยอดรวม (Top Cards) */}
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
              <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">📊 ภาพรวมธุรกิจ</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-2">
                <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100 card-hover"><div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-xl mb-4">📦</div><h3 className="text-blue-600 font-bold mb-1">ส่งรวมทั้งหมด</h3><p className="text-5xl font-black text-blue-900">{dashboardStats.totalOrders} <span className="text-lg font-medium">ชิ้น</span></p></div>
                <div className="bg-orange-50 p-6 rounded-2xl border border-orange-100 card-hover"><div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center text-xl mb-4">🚚</div><h3 className="text-orange-600 font-bold mb-1">ออเดอร์ COD</h3><p className="text-5xl font-black text-orange-900">{dashboardStats.codOrders} <span className="text-lg font-medium">ชิ้น</span></p></div>
                <div className="bg-emerald-50 p-6 rounded-2xl border border-emerald-100 card-hover"><div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-xl mb-4">💰</div><h3 className="text-emerald-600 font-bold mb-1">คาดการณ์เงินโอน</h3><p className="text-5xl font-black text-emerald-900">฿{dashboardStats.totalCodAmount.toLocaleString()}</p></div>
              </div>
            </div>

            {/* 2. กราฟสถิติ (Charts) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
               {/* กราฟวงกลม */}
               <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 flex flex-col items-center justify-center card-hover">
                  <h3 className="text-lg font-black text-slate-700 w-full text-left mb-2">สัดส่วนประเภทการชำระ</h3>
                  <ResponsiveContainer width="100%" height={250}>
                     <PieChart>
                        <Pie data={dashboardStats.pieData} innerRadius={60} outerRadius={85} paddingAngle={5} dataKey="value">
                           {dashboardStats.pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                        <Legend wrapperStyle={{fontSize: '14px', fontWeight: 'bold'}} />
                     </PieChart>
                  </ResponsiveContainer>
               </div>
               
               {/* กราฟแท่ง */}
               <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 lg:col-span-2 card-hover">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-black text-slate-700">สถิติการส่งพัสดุรายวัน <span className="text-sm font-medium text-slate-400 ml-2">(คลิกที่แท่งกราฟเพื่อดูรายละเอียด)</span></h3>
                    {selectedDate && <button onClick={() => setSelectedDate(null)} className="btn-cute text-xs bg-slate-100 text-slate-600 px-4 py-2 rounded-xl font-bold hover:bg-slate-200">❌ ดูทั้งหมด</button>}
                  </div>
                  <ResponsiveContainer width="100%" height={250}>
                     <BarChart data={dashboardStats.barData} onClick={(data) => { if(data && data.activePayload) setSelectedDate(data.activePayload[0].payload.name); }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 12, fill: '#64748b', fontWeight: 'bold'}} />
                        <YAxis axisLine={false} tickLine={false} tick={{fontSize: 12, fill: '#64748b'}} />
                        <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                        <Legend iconType="circle" wrapperStyle={{fontSize: '13px', fontWeight: 'bold'}} />
                        <Bar dataKey="โอนเงิน" stackId="a" fill="#22c55e" radius={[0, 0, 6, 6]} cursor="pointer" />
                        <Bar dataKey="COD" stackId="a" fill="#f97316" radius={[6, 6, 0, 0]} cursor="pointer" />
                     </BarChart>
                  </ResponsiveContainer>
               </div>
            </div>

            {/* 3. ตารางรายละเอียด (Data Table) */}
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 mb-10">
               <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
                  <h3 className="text-xl font-black text-slate-800 flex items-center gap-3">
                     📋 รายละเอียดพัสดุ 
                     {selectedDate && <span className="text-blue-600 bg-blue-50 px-4 py-1.5 rounded-xl text-sm border border-blue-100 animate-[fadeIn_0.3s_ease-out]">📅 ประจำวันที่: {selectedDate}</span>}
                  </h3>
                  <div className="flex gap-3 w-full md:w-auto">
                     <input type="text" placeholder="🔍 ค้นหา ชื่อ, รหัสปณ, หรือ REF..." value={searchQuery} onChange={(e)=>setSearchQuery(e.target.value)} className="border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none text-sm w-full md:w-72 transition-all bg-slate-50 focus:bg-white" />
                     <button onClick={handleExportCSV} className="btn-cute bg-emerald-50 text-emerald-600 font-black px-6 py-3 rounded-xl text-sm hover:bg-emerald-500 hover:text-white flex-shrink-0 transition-colors shadow-sm">📥 ดาวน์โหลด Excel</button>
                  </div>
               </div>
               
               <div className="overflow-x-auto border border-slate-200 rounded-2xl">
                 <table className="w-full text-sm text-left">
                   <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider border-b border-slate-200">
                     <tr>
                       <th className="py-4 px-6 whitespace-nowrap">วันที่ / เวลา</th>
                       <th className="py-4 px-6 whitespace-nowrap">หมายเลขสิ่งของ</th>
                       <th className="py-4 px-6 whitespace-nowrap">ชื่อผู้รับ</th>
                       <th className="py-4 px-6 min-w-[200px]">ที่อยู่จัดส่ง</th>
                       <th className="py-4 px-6 text-right whitespace-nowrap">ยอดเก็บเงิน (COD)</th>
                     </tr>
                   </thead>
                   <tbody>
                     {filteredOrders.length === 0 ? (
                        <tr><td colSpan="5" className="text-center py-16 text-slate-400 font-medium">ไม่พบข้อมูลที่ค้นหา หรือยังไม่มีออเดอร์ในวันนี้...</td></tr>
                     ) : (
                        filteredOrders.map((order, idx) => (
                           <tr key={idx} className="border-b border-slate-100 hover:bg-blue-50/50 transition-colors">
                              <td className="py-4 px-6 text-slate-500 whitespace-nowrap">{order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-'}</td>
                              <td className="py-4 px-6 font-mono font-bold text-indigo-600 tracking-wider bg-indigo-50/30 whitespace-nowrap">REF-{order.id.slice(-6).toUpperCase()}</td>
                              <td className="py-4 px-6 whitespace-nowrap">
                                 <p className="font-bold text-slate-800 text-base">{order.customerName}</p>
                                 <p className="text-xs text-slate-500 mt-1 font-medium">☎ {order.phone}</p>
                              </td>
                              <td className="py-4 px-6">
                                 <p className="text-slate-600 line-clamp-2 text-xs leading-relaxed mb-1" title={order.address}>{order.address}</p>
                                 <span className="font-black text-slate-800 tracking-widest bg-slate-100 px-2 py-0.5 rounded text-xs">{order.zipcode}</span>
                              </td>
                              <td className="py-4 px-6 text-right">
                                 {order.isCOD 
                                  ? <span className="font-black text-xl text-orange-600 bg-orange-50 px-4 py-1.5 rounded-xl border border-orange-100">฿{order.codAmount}</span> 
                                  : <span className="font-black text-emerald-600 text-sm bg-emerald-50 px-4 py-1.5 rounded-xl border border-emerald-100">โอนเงินแล้ว</span>}
                              </td>
                           </tr>
                        ))
                     )}
                   </tbody>
                 </table>
               </div>
            </div>
         </div>
      ) : activeTab === 'team' && userRole === 'Owner' ? (
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
      ) : activeTab === 'affiliates' && userRole === 'SuperAdmin' ? (
         <div className="flex flex-col gap-6">
           {/* ตารางนักการตลาด */}
           <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-indigo-500">
             <h2 className="text-2xl font-black mb-6 text-slate-800 flex items-center gap-2">🤝 รายชื่อนักการตลาด (Affiliate Partners)</h2>
             <div className="overflow-hidden border border-slate-200 rounded-2xl">
               <table className="w-full text-sm text-left">
                 <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500">
                   <tr><th className="py-4 px-6">ชื่อ - เบอร์โทร</th><th className="py-4 px-6 text-center">รหัสแนะนำ</th><th className="py-4 px-6 text-right">รายได้สะสม</th><th className="py-4 px-6 text-right">ยอดคงเหลือ</th></tr>
                 </thead>
                 <tbody>
                   {allAffiliates.length === 0 ? <tr><td colSpan="4" className="text-center py-8 text-slate-400">ยังไม่มีนักการตลาด...</td></tr> : 
                    allAffiliates.map((aff, idx) => (
                     <tr key={idx} className="border-t border-slate-100 hover:bg-slate-50">
                       <td className="py-4 px-6"><p className="font-bold text-slate-800">{aff.name}</p><p className="text-xs text-slate-500">ID: {aff.phone}</p></td>
                       <td className="py-4 px-6 text-center"><span className="bg-indigo-100 text-indigo-700 font-bold px-3 py-1 rounded">{aff.referralCode}</span></td>
                       <td className="py-4 px-6 text-right font-black text-slate-700">฿{(aff.totalEarned || 0).toLocaleString()}</td>
                       <td className="py-4 px-6 text-right font-black text-orange-600">฿{(aff.balance || 0).toLocaleString()}</td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </div>

           {/* ตารางขอถอนเงิน */}
           <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-orange-500">
             <h2 className="text-2xl font-black mb-6 text-slate-800 flex items-center gap-2">🏦 รายการขอถอนเงิน (Withdrawals)</h2>
             <div className="overflow-hidden border border-slate-200 rounded-2xl">
               <table className="w-full text-sm text-left">
                 <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500">
                   <tr><th className="py-4 px-6">วันที่</th><th className="py-4 px-6">พาร์ทเนอร์</th><th className="py-4 px-6">พร้อมเพย์/บัญชี</th><th className="py-4 px-6 text-right">ยอดถอน</th><th className="py-4 px-6 text-center">จัดการ</th></tr>
                 </thead>
                 <tbody>
                   {allWithdrawals.length === 0 ? <tr><td colSpan="5" className="text-center py-8 text-slate-400">ไม่มีรายการขอถอนเงิน...</td></tr> : 
                    allWithdrawals.map((w, idx) => (
                     <tr key={idx} className="border-t border-slate-100 hover:bg-slate-50">
                       <td className="py-4 px-6 text-slate-500">{w.createdAt ? w.createdAt.toDate().toLocaleDateString('th-TH') : '-'}</td>
                       <td className="py-4 px-6 font-bold text-slate-800">{w.affiliateName}</td>
                       <td className="py-4 px-6 font-mono text-blue-600">{w.paymentInfo}</td>
                       <td className="py-4 px-6 text-right font-black text-orange-600">฿{w.amount.toLocaleString()}</td>
                       <td className="py-4 px-6 text-center">
                         {w.status === 'pending' ? 
                           <button onClick={() => handleApproveWithdrawal(w.id)} className="btn-cute bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-4 py-2 rounded-lg text-xs shadow-md">✅ โอนเงินแล้ว</button>
                         : <span className="bg-emerald-100 text-emerald-700 font-bold px-3 py-1 rounded text-xs">โอนแล้ว</span>}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </div>
         </div>
       ) : activeTab === 'billing' && userRole === 'SuperAdmin' ? (
         <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-emerald-400">
           <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">💳 ตรวจสอบและอนุมัติบิล (SuperAdmin)</h2>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
             {billingRequests.map((req, index) => (
               <div key={index} className="border border-slate-200 rounded-3xl bg-white shadow-lg overflow-hidden flex flex-col card-hover">
                 <div className="bg-slate-100 h-48 w-full border-b border-slate-200 relative">
                   {req.data.slipImage ? (
                     <img src={req.data.slipImage} alt="Slip" className="w-full h-full object-cover" onClick={() => window.open(req.data.slipImage, '_blank')} title="คลิกเพื่อดูรูปใหญ่" style={{cursor: 'zoom-in'}} />
                   ) : (
                     <div className="flex items-center justify-center h-full text-slate-400 font-medium">ไม่มีรูปภาพแนบมา</div>
                   )}
                   <div className="absolute top-3 right-3 bg-rose-500 text-white text-[10px] font-bold px-3 py-1 rounded-full shadow-md">รอตรวจสอบ</div>
                 </div>
                 
                 <div className="p-6 flex-1 flex flex-col justify-between">
                   <div>
                     <p className="font-black text-slate-800 text-lg">{req.data.storeName || 'ไม่มีชื่อร้าน'}</p>
                     <p className="text-xs text-slate-500 mb-4 font-medium">{req.data.email}</p>
                     <div className="bg-slate-50 p-4 rounded-xl mb-6 flex justify-between border border-slate-100">
                       <div><p className="text-xs text-slate-500 font-bold mb-1 uppercase tracking-widest">แพ็กเกจที่ขอ</p><p className="font-black text-blue-600 text-xl">{req.data.requestedQuota} <span className="text-sm">ใบ</span></p></div>
                       <div className="text-right"><p className="text-xs text-slate-500 font-bold mb-1 uppercase tracking-widest">ยอดโอน</p><p className="font-black text-emerald-600 text-xl">฿{req.data.amount}</p></div>
                     </div>
                   </div>
                   <button onClick={() => handleApproveTopup(req.id, req.data.uid, req.data.requestedQuota, req.data.amount)} className="btn-cute w-full bg-emerald-500 text-white font-black py-4 rounded-xl shadow-lg shadow-emerald-500/30 flex items-center justify-center gap-2 text-lg">✅ ยืนยันว่ายอดเงินเข้าแล้ว</button>
                 </div>
               </div>
             ))}
             {billingRequests.length === 0 && (
               <div className="col-span-full py-20 text-center text-slate-400"><span className="text-6xl mb-4 block">🎉</span><p className="text-xl font-bold">สุดยอด! ไม่มีรายการค้างตรวจสอบเลย</p></div>
             )}
           </div>
         </div>
      ) : null}
    </div>
  );
}
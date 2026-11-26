/* =====================================================
   بوت الواتساب - التحكم في حساب الواتساب عن طريق التليجرام
   Telegram: Telegraf | WhatsApp: @whiskeysockets/baileys v7 (LID + QR + Ubuntu Chrome)
   كود ربط ثابت WATX-HOU2 قابل للنسخ + تنقل بالتعديل — الإصدار v3.2
   ===================================================== */
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    Browsers,
    DisconnectReason,
    proto
} = require('@whiskeysockets/baileys');
const { Telegraf, Markup } = require('telegraf');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

process.env.DEBUG = '';
process.env.NODE_DEBUG = '';
process.env.BAILEYS_LOG_LEVEL = 'fatal';

// ==========================================
// ⚙️ الإعدادات
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN || '9251699043:AAGkmAOtRAiLpUnHX4vXPhPOqo55uYDwHIk';
const ADMIN_ID = String(process.env.ADMIN_ID || '8422032426');
const SOURCE_CHANNEL = '@SourceHouda';
const CHANNEL_URL = 'https://t.me/SourceHouda';
const SIGNATURE = 'TG : Devlopers: @sw_of';
const PORT = 3000;
const START_IMAGE = path.join(__dirname, 'botwatsspp.png'); // الصورة التي يرسلها البوت في /start
const PAIR_TIMEOUT_MS = 6 * 60 * 1000; // مهلة الربط : 6 دقايق
const MAX_PAIR_ROUNDS = 8; // أقصى عدد جولات إعادة اتصال أثناء الربط قبل الإلغاء
const QR_LIFETIME_MS = 90 * 1000; // مدة صلاحية كل كود ربط / QR (90 ثانية بدل 20 ثانية)
// كود الربط الثابت : بيتستخدم كمفتاح تشفير عند سيرفر واتساب (أي 8 حروف تنفع)
// نفس الكود يظهر للمستخدم دايما و قابل للنسخ بضغطة واحدة
const PAIRING_CODE_CUSTOM = 'WATXHOU2';
const PAIRING_CODE_DISPLAY = 'WATX-HOU2';
const FATAL_CODES = [401, 403, 411];
const MAX_RECONNECT_ATTEMPTS = 10;

// ==========================================
// ⏱️ دوال مساعدة لمنع التجميد
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));

function withTimeout(promise, ms, errMsg = 'انتهت مهلة العملية') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errMsg)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ==========================================
// 🌐 السيرفر (للـ hosting)
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('WhatsApp Bot ONLINE\n');
}).listen(PORT, () => console.log(`🌐 السيرفر شغال على بورت ${PORT}`));

// ==========================================
// 📁 المجلدات
// ==========================================
const sessionsDir = path.join(__dirname, 'sessions');
const dataDir = path.join(__dirname, 'data');
const photosRoot = path.join(__dirname, 'photos');
[sessionsDir, dataDir, photosRoot].forEach(d => {
    if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
});

const contactsFile = (num) => path.join(dataDir, `contacts_${num}.json`);
const photosDir = (num) => path.join(photosRoot, num);

function loadContacts(num) {
    try { return JSON.parse(fs.readFileSync(contactsFile(num), 'utf-8')) || []; }
    catch (_) { return []; }
}

function writeContacts(num, arr) {
    try { fs.writeFileSync(contactsFile(num), JSON.stringify(arr || [])); } catch (_) {}
}

// ==========================================
// 🗄️ قاعدة البيانات (SQLite عن طريق sql.js - WASM)
// ==========================================
const initSqlJs = require('sql.js');
const dbFile = path.join(__dirname, 'bot.db');
let db = null;
let dbSaveTimer = null;

async function initDb() {
    const SQL = await initSqlJs();
    if (fs.existsSync(dbFile)) {
        try { db = new SQL.Database(fs.readFileSync(dbFile)); }
        catch (e) { console.error('⚠️ فشل تحميل bot.db، هيتعمل ملف جديد:', e.message); db = new SQL.Database(); }
    } else {
        db = new SQL.Database();
    }
    db.run(`
    CREATE TABLE IF NOT EXISTS users (
        cid TEXT PRIMARY KEY,
        number TEXT UNIQUE,
        linked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_users (
        cid TEXT PRIMARY KEY,
        seen_at TEXT,
        name TEXT,
        username TEXT,
        lang TEXT
    );
    CREATE TABLE IF NOT EXISTS banned (
        cid TEXT PRIMARY KEY,
        name TEXT,
        handle TEXT,
        added_at TEXT
    );
    `);
    // ترقية قاعدة قديمة لو موجودة
    ['name', 'username', 'lang', 'seen_iso'].forEach(col => {
        try { db.run(`ALTER TABLE bot_users ADD COLUMN ${col} TEXT`); } catch (_) {}
    });
    persistDb();
}

function persistDb() {
    if (dbSaveTimer) return;
    dbSaveTimer = setTimeout(() => {
        dbSaveTimer = null;
        try {
            const data = Buffer.from(db.export());
            fs.promises.writeFile(dbFile, data).catch(e => console.error('❌ خطأ في حفظ قاعدة البيانات:', e.message));
        } catch (e) {
            console.error('❌ خطأ في تصدير قاعدة البيانات:', e.message);
        }
    }, 300);
}

function dbRun(sql, params = []) {
    const stmt = db.prepare(sql);
    try { stmt.bind(params); stmt.step(); } finally { stmt.free(); }
    persistDb();
}
function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : null;
    } finally { stmt.free(); }
}
function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    const rows = [];
    try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
    } finally { stmt.free(); }
    return rows;
}

const q = {
    getSetting: (key) => dbGet('SELECT value FROM settings WHERE key = ?', [key]),
    setSetting: (key, val) => dbRun(
        `INSERT INTO settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, val]),
    delSetting: (key) => dbRun('DELETE FROM settings WHERE key = ?', [key]),
    getUserByCid: (cid) => dbGet('SELECT * FROM users WHERE cid = ?', [cid]),
    getUserByNumber: (num) => dbGet('SELECT * FROM users WHERE number = ?', [num]),
    upsertUser: (cid, num, at) => dbRun(
        `INSERT INTO users(cid, number, linked_at) VALUES(?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET number = excluded.number, linked_at = excluded.linked_at`, [cid, num, at]),
    deleteUserByCid: (cid) => dbRun('DELETE FROM users WHERE cid = ?', [cid]),
    deleteUserByNumber: (num) => dbRun('DELETE FROM users WHERE number = ?', [num]),
    countUsers: () => dbGet('SELECT COUNT(*) c FROM users'),
    allUsers: () => dbAll('SELECT * FROM users'),
    upsertBotUser: (cid, name, username) => dbRun(
        `INSERT INTO bot_users(cid, seen_at, name, username, seen_iso) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET seen_at = excluded.seen_at, name = excluded.name, username = excluded.username, seen_iso = excluded.seen_iso`,
        [cid, new Date().toLocaleString('ar-EG'), name || '', username || '', new Date().toISOString()]),
    getBotUser: (cid) => dbGet('SELECT * FROM bot_users WHERE cid = ?', [String(cid)]),
    allBotUsers: () => dbAll('SELECT * FROM bot_users'),
    delBotUser: (cid) => dbRun('DELETE FROM bot_users WHERE cid = ?', [String(cid)]),
    setLang: (cid, lang) => dbRun(
        `INSERT INTO bot_users(cid, lang, seen_iso) VALUES(?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET lang = excluded.lang, seen_iso = excluded.seen_iso`,
        [String(cid), lang, new Date().toISOString()]),
    banUser: (cid, name, handle) => dbRun(
        `INSERT INTO banned(cid, name, handle, added_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET name = excluded.name, handle = excluded.handle`,
        [String(cid), name || '', handle || '', new Date().toLocaleString('ar-EG')]),
    unbanUser: (cid) => dbRun('DELETE FROM banned WHERE cid = ?', [String(cid)]),
    getBanned: (cid) => dbGet('SELECT * FROM banned WHERE cid = ?', [String(cid)]),
    allBanned: () => dbAll('SELECT * FROM banned'),
    countBanned: () => dbGet('SELECT COUNT(*) c FROM banned')
};

function getSetting(key, def = null) {
    const row = q.getSetting(key);
    return row ? row.value : def;
}
function setSetting(key, val) { q.setSetting(key, String(val)); }
function delSetting(key) { q.delSetting(key); }

// ─── المستخدمين المربوطين (users) ───
function getUserNumber(cid) {
    const row = q.getUserByCid(String(cid));
    return row ? row.number : null;
}
function getCidByNumber(num) {
    const clean = String(num || '').replace(/\D/g, '');
    const row = q.getUserByNumber(clean);
    return row ? row.cid : null;
}
function setUserNumber(cid, num) {
    const clean = String(num || '').replace(/\D/g, '');
    const cidStr = String(cid);
    const existing = q.getUserByNumber(clean);
    if (existing && existing.cid !== cidStr) q.deleteUserByCid(existing.cid);
    q.upsertUser(cidStr, clean, new Date().toLocaleString('ar-EG'));
}
function removeUser(cid) { q.deleteUserByCid(String(cid)); }
function removeUserByNumber(number) {
    const clean = String(number || '').replace(/\D/g, '');
    q.deleteUserByNumber(clean);
}
function isAdminId(id) { return String(id) === ADMIN_ID; }

// ─── المستخدمون النشطون + معالج تنظيف دوري ───
// كل حد يفتح البوت كان بيتسجل للمستابد الا لانهائي — دلوقتي بنعد النشطين خلال 30 يوم بس
// والمربوطين بيعدوا دايما + معالج كل ساعة بيمسح الحسابات الوهمية القديمة
const USER_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
function activeBotUsers() {
    const cut = Date.now() - USER_ACTIVE_MS;
    return q.allBotUsers().filter(u => {
        if (q.getUserByCid(u.cid)) return true; // المربوطين دايما نشطين
        if (!u.seen_iso) return false;
        const t = Date.parse(u.seen_iso);
        return !isNaN(t) && t >= cut;
    });
}
// معالج تنظيف دوري : بيحذف مستخدمي تليجرام اللي عمرهم ما ربطوا رقم ومعدوش بيفتحوا البوت
setInterval(() => {
    try {
        const cut = Date.now() - USER_ACTIVE_MS;
        let cleaned = 0;
        for (const u of q.allBotUsers()) {
            if (q.getUserByCid(u.cid)) continue;
            const t = u.seen_iso ? Date.parse(u.seen_iso) : NaN;
            if (isNaN(t) || t < cut) { q.delBotUser(u.cid); cleaned++; }
        }
        if (cleaned) console.log(`🧹 تم تنظيف ${cleaned} مستخدم غير نشط من قاعدة البيانات`);
    } catch (e) { console.error('❌ تنظيف المستخدمين:', e?.message || e); }
}, 60 * 60 * 1000);

// ─── مستخدمي البوت + اللغة ───
function getLang(cid) {
    const row = q.getBotUser(cid);
    return row ? (row.lang || null) : null;
}
function langOf(cid) { return getLang(cid) || 'ar'; }

// ─── الحظر ───
function isBanned(cid) { return !!q.getBanned(String(cid)); }
function banTelegramUser(cid, name, handle) { q.banUser(String(cid), name, handle); }
function unbanTelegramUser(cid) { q.unbanUser(String(cid)); }

// ==========================================
// 🌍 النصوص (عربي / انجليزي)
// ==========================================
const LANGS = {
    ar: {
        need_sub: 'عذرآ عليك الاشتراك في قناة السورس اولا لتتمكن من استخدام البوت',
        btn_channel: 'SourceHouda',
        btn_check: 'تحقق',
        sub_not_yet: 'لم تقم بالاشتراك بعد ، اشترك في القناة ثم اضغط تحقق',
        choose_lang: 'اختر اللغة',
        btn_ar: 'اللغه العربيه',
        btn_en: 'اللغه الانجليزيه',
        welcome: (n) => `مرحبا ${n} بك في بوت الواتساب التحديث الجديد v2 استخدم من الازرار التي بـ الاسفل`,
        btn_link: 'اربط رقمك',
        choose_link: 'اختر طريقة الربط :',
        btn_link_code: 'ربط بكود الربط',
        btn_link_qr: 'تسجيل دخول عبر QR',
        qr_sent: 'كود QR جاهز — امسحه من واتساب\n\nافتح واتساب\nادخل على الاجهزة المرتبطة\nاختر ربط جهاز\nوجه الكاميرا على صورة الكود\nالكود بيتجدد تلقائيا كل ما انتهى',
        qr_wait: 'جاري توليد كود QR لتسجيل الدخول...',
        btn_disc: 'قطع الاتصال',
        btn_cmds: 'الاوامر المتاحة',
        btn_howto: 'ازاي استخدم البوت',
        btn_lang: 'تغير اللغة',
        btn_admin: 'لوحة الادمن',
        btn_back: 'رجوع',
        send_phone: 'ارسل رقمك الان مع كود الدولة بالشكل هاذه +20123456789',
        invalid_number: 'رقم غير صحيح ، ارسل رقمك مع كود الدولة بالشكل هاذه +20123456789',
        preparing: 'جاري تجهيز الرقم وإنشاء كود الربط...',
        pair_code: (c) => `🔑 كود الربط : <code>${c}</code> (اضغط على الكود مرة واحدة للنسخ)\n\n` +
            `⚠️ الكود ثابت — لو واتساب قال «كود خاطئ» استنى 10 ثواني وادخل الكود تاني ، البوت بيجدد الاتصال تلقائيا\n\n` +
            `خطوات الربط :\n` +
            `1️⃣ افتح واتساب في الموبايل\n` +
            `2️⃣ الإعدادات ← الأجهزة المرتبطة\n` +
            `3️⃣ اضغط : ربط جهاز\n` +
            `4️⃣ بدل رمز QR اختار : «الربط برقم الهاتف بدلا من ذلك»\n` +
            `5️⃣ اكتب الكود في واتساب من غير الشرطة : ${String(c).replace('-', '')} وسيتصل تلقائيا`,
        pair_fail: 'فشل في إنشاء كود الربط ، حاول مرة أخرى',
        pair_timeout: (n) => `انتهت مهلة كود الربط للرقم +${n}\nتم مسح البيانات ، اطلب كود جديد`,
        pair_timeout_qr: (n) => `انتهت مهلة مسح كود QR للرقم +${n}\nتم مسح البيانات ، اطلب كود جديد وجرب تاني`,
        pair_failed: (n) => `فشل الربط للرقم +${n}\nتم مسح البيانات ، اطلب كود جديد وجرب تاني`,
        linked_ok: 'تم ربط رقمك بنجاح',
        disconnected: (n) => `تم قطع الرقم +${n} ومسح كل بياناته`,
        pair_cancelled: 'تم الغاء عملية الربط',
        no_number: 'لا يوجد رقم مربوط بحسابك',
        already_linked: (n) => `عندك رقم مربوط بالفعل : +${n}`,
        replace_hint: 'تقدر تقطعه وتربط رقم جديد بضغطة واحدة',
        btn_replace: 'قطعه واربط رقم جديد',
        btn_cancel_pair: 'الغاء الربط',
        btn_try_again: 'حاول تاني',
        number_busy: (n) => `الرقم +${n} بيتربط دلوقتي من حساب تاني ، جرب بعد دقيقتين`,
        number_taken: (n) => `الرقم +${n} مسجل بحساب تاني`,
        session_dead: (n) => `الرقم +${n} جلسته بطلت صالحة\nتم مسح بياناته وتقدر تربطه تاني`,
        left_channel: (n) => `تم قطع رقمك +${n} لأنك خرجت من قناة السورس\nاشترك تاني واربط رقمك من جديد`,
        howto: `طريقة استخدام البوت

1 اضغط على زر ( اربط رقمك )
2 قم رسال رقم هاتفك مع رمز الدولة
3 قم ب الدخول ل الواتساب ( رقمك )
4 ادخل على ربط الاجهزه ( اختر ربط الرقم بدلا من ذالك )
5 قم بتجربة البوت في اي محادثه ب كتابة امر (.الاوامر) لعرض الاوامر الخاصه بك`,
        cmds_header: 'الاوامر المتاحة',
        admin_title: 'لوحة الادمن',
        st_users: 'مستخدمين نشطين (30 يوم)',
        st_linked: 'عدد الارقام المربوطة',
        st_online: 'الارقام المتصلة الان',
        st_banned: 'المحظورين',
        btn_broadcast: 'الاذاعه',
        btn_ban: 'حظر مستخدم',
        btn_banned: 'المحظورين',
        btn_numbers: 'قائمة الارقام',
        bc_prompt: 'ارسل الرسالة التي تريد نشرها لجميع المستخدمين (نص او صوره او فيديو او ملف)',
        bc_running: 'فيه اذاعة شغالة بالفعل في الخلفية دلوقتي',
        bc_started: 'بدأت الاذاعة في الخلفية بنظام المجموعات والبوت شغال طبيعي',
        bc_stop: 'ايقاف الاذاعه',
        bc_stopped: 'تم ايقاف الاذاعة يدويا',
        bc_done: 'تمت الاذاعة بنجاح',
        bc_sent: 'وصلت بنجاح',
        bc_removed: 'حسابات غير نشطة تم تنظيفها',
        bc_failed: 'فشل',
        bc_total: 'الاجمالي',
        ban_prompt: 'ارسل ايدي المستخدم او يوزر المستخدم لحظره من البوت\nمثال : 123456789 او @username',
        ban_done: (n, h) => `تم حظر المستخدم ${n || ''} ${h}`.trim(),
        ban_notfound: 'لم يتم العثور على المستخدم',
        banned_title: (c) => `قائمة المحظورين (${c})`,
        no_banned: 'لا يوجد محظورين',
        btn_unban: 'الغاء الحظر',
        numbers_title: (c) => `قائمة الارقام (${c})`,
        no_numbers: 'لا توجد ارقام',
        btn_disc_all: 'قطع الكل',
        admin_disc_done: (n) => `تم قطع الرقم +${n} ومسح بياناته`,
        admin_disc_all_done: (c) => `تم قطع ${c} رقم ومسح بياناتهم`,
        err: 'حدث خطأ ، حاول مرة أخرى'
    },
    en: {
        need_sub: 'Sorry, you must subscribe to the source channel first to use the bot',
        btn_channel: 'SourceHouda',
        btn_check: 'Check',
        sub_not_yet: 'You did not subscribe yet, subscribe to the channel then press Check',
        choose_lang: 'Choose language / اختر اللغة',
        btn_ar: 'اللغه العربيه',
        btn_en: 'English',
        welcome: (n) => `Hello ${n}, welcome to the new WhatsApp Bot v2. Use the buttons below`,
        btn_link: 'Link your number',
        choose_link: 'Choose the linking method :',
        btn_link_code: 'Link with pairing code',
        btn_link_qr: 'Login via QR',
        qr_sent: 'QR code is ready — scan it from WhatsApp\n\nOpen WhatsApp\nGo to Linked devices\nChoose Link a device\nPoint the camera at the code image\nThe code refreshes automatically when it expires',
        qr_wait: 'Generating the QR login code...',
        btn_disc: 'Disconnect',
        btn_cmds: 'Available commands',
        btn_howto: 'How to use the bot',
        btn_lang: 'Change language',
        btn_admin: 'Admin panel',
        btn_back: 'Back',
        send_phone: 'Send your number now with the country code like this +20123456789',
        invalid_number: 'Invalid number, send your number with the country code like this +20123456789',
        preparing: 'Preparing your number and creating the pairing code...',
        pair_code: (c) => `🔑 Pairing code : <code>${c}</code> (tap the code once to copy)\n\n` +
            `⚠️ The code is static — if WhatsApp says «wrong code» wait 10 seconds and enter it again, the bot refreshes the connection automatically\n\n` +
            `Steps :\n` +
            `1️⃣ Open WhatsApp on your phone\n` +
            `2️⃣ Settings ← Linked devices\n` +
            `3️⃣ Tap : Link a device\n` +
            `4️⃣ Instead of QR choose : «Link with phone number instead»\n` +
            `5️⃣ Type the code in WhatsApp without the dash : ${String(c).replace('-', '')} and it will connect automatically`,
        pair_fail: 'Failed to create the pairing code, try again',
        pair_timeout: (n) => `Pairing code expired for +${n}\nData cleared, request a new code`,
        pair_timeout_qr: (n) => `QR code scan expired for +${n}\nData cleared, request a new code and try again`,
        pair_failed: (n) => `Pairing failed for +${n}\nData cleared, request a new code and try again`,
        linked_ok: 'Your number has been linked successfully',
        disconnected: (n) => `Your number +${n} has been disconnected and all its data cleared`,
        pair_cancelled: 'Pairing cancelled',
        no_number: 'You have no linked number',
        already_linked: (n) => `You already have a linked number : +${n}`,
        replace_hint: 'You can disconnect it and link a new number with one click',
        btn_replace: 'Disconnect and link a new number',
        btn_cancel_pair: 'Cancel pairing',
        btn_try_again: 'Try again',
        number_busy: (n) => `+${n} is being linked from another account, try again in 2 minutes`,
        number_taken: (n) => `+${n} is already linked to another account`,
        session_dead: (n) => `The session of +${n} is no longer valid\nIts data was cleared, you can link it again`,
        left_channel: (n) => `Your number +${n} was disconnected because you left the source channel\nSubscribe again and link your number`,
        howto: `How to use the bot

1 Press the ( Link your number ) button
2 Send your phone number with the country code
3 Open WhatsApp on your number
4 Go to Linked devices ( choose Link with phone number instead )
5 Try the bot in any chat by typing (.الاوامر) to see your commands`,
        cmds_header: 'Available commands',
        admin_title: 'Admin panel',
        st_users: 'Active users (30 days)',
        st_linked: 'Linked numbers',
        st_online: 'Online numbers',
        st_banned: 'Banned',
        btn_broadcast: 'Broadcast',
        btn_ban: 'Ban a user',
        btn_banned: 'Banned users',
        btn_numbers: 'Numbers list',
        bc_prompt: 'Send the message you want to broadcast to all users (text, photo, video or file)',
        bc_running: 'A broadcast is already running in the background',
        bc_started: 'Broadcast started in the background in batches, the bot is working normally',
        bc_stop: 'Stop broadcast',
        bc_stopped: 'Broadcast stopped manually',
        bc_done: 'Broadcast finished successfully',
        bc_sent: 'Sent successfully',
        bc_removed: 'Inactive accounts cleaned',
        bc_failed: 'Failed',
        bc_total: 'Total',
        ban_prompt: 'Send the user ID or the user username to ban them from the bot\nExample : 123456789 or @username',
        ban_done: (n, h) => `User banned: ${n || ''} ${h}`.trim(),
        ban_notfound: 'User not found',
        banned_title: (c) => `Banned users (${c})`,
        no_banned: 'No banned users',
        btn_unban: 'Unban',
        numbers_title: (c) => `Numbers list (${c})`,
        no_numbers: 'No numbers',
        btn_disc_all: 'Disconnect all',
        admin_disc_done: (n) => `+${n} has been disconnected and its data cleared`,
        admin_disc_all_done: (c) => `${c} numbers have been disconnected and their data cleared`,
        err: 'An error occurred, try again'
    }
};
const T = (cid) => LANGS[langOf(cid)] || LANGS.ar;

// ==========================================
// 📜 قائمة الأوامر (تُستخدم في تليجرام وفي واتساب)
// ==========================================
const COMMANDS = [
    ['.الاوامر', 'عرض جميع الاوامر', 'show all commands'],
    ['.رقمي', 'رقم هاتفك مع كود الدولة', 'your phone number with country code'],
    ['.معلوماتي', 'معلومات حسابك', 'your account info'],
    ['.بروفايل', 'صورة ومعلومات بروفايل المحادثه', 'chat profile picture and info'],
    ['.رد تلقائي', 'تفعيل الرد التلقائي على الخاص', 'enable auto reply for private chats'],
    ['.ايقاف الرد التلقائي', 'ايقاف الرد التلقائي', 'disable auto reply'],
    ['.تفعيل وضع الذكاء الاصطناعي', 'الذكاء الاصطناعي يرد مكانك على رسايل الخاص', 'AI replies for you in private chats'],
    ['.ايقاف وضع الذكاء الاصطناعي', 'ايقاف وضع الذكاء الاصطناعي', 'disable the AI mode'],
    ['.نص', 'اختيار شكل نص رسايل البوت (0 عادي / 1 عريض / 2 مائل / 3 مشطب / 4 داخل إطار)', 'choose bot text style (0-4)'],
    ['.ايقاف النص', 'ايقاف تعديل شكل النص', 'stop the text style modification'],
    ['.التحديثات', 'اشعارات تغيير الصور والاسامي والاستوري لرقمك الشخصي (الحافظة)', 'profile pic/name/story notifications to your vault number'],
    ['.ايقاف التحديثات', 'ايقاف اشعارات التحديثات', 'stop the update notifications'],
    ['تفعيل الوقت', 'قائمه زخارف الوقت للساعة بجانب اسم حسابك (الوقت 1 الى الوقت 4)', 'clock decoration menu next to your account name'],
    ['.الغاء الوقت', 'ايقاف الساعه واسترجاع اسم حسابك الاصلي', 'stop the clock and restore your original name'],
    ['.وقت (الدقائق)', 'عد تنازلي بالدقائق بالتعديل على نفس الرساله مثال : .وقت 1 او .وقت 1:30', 'countdown in minutes edited in the same message'],
    ['.وقف الوقت', 'ايقاف العد التنازلي في المحادثه', 'stop the countdown in the chat'],
    ['.اونلاين', 'جعل حسابك نشط اونلاين بشكل دائم', 'keep your account always online'],
    ['.ايقاف الاونلاين', 'ايقاف وضع الاونلاين الدائم', 'stop the always online mode'],
    ['.صوره', 'التقاط الصوره المعروضه لمره واحده', 'capture a view-once image'],
    ['.فيد', 'التقاط الفيديو المعروض لمره واحده', 'capture a view-once video'],
    ['.استوري', 'قائمه بجميع الحسابات المحفوظ استوريهاتها', 'list all accounts with saved stories'],
    ['.سحب استوري (الرقم)', 'سحب استوري مستخدم بالرقم مع الاحصائيات', 'download the stories of a number'],
    ['.ريك', 'ارسال المقطع الصوتي كريكورد لرقمك الشخصي', 'send an audio clip as a voice note to your own chat'],
    ['.الطقس', 'حالة الطقس لاي دولة او مدينة مثال : .الطقس مصر', 'weather for any country or city'],
    ['.سعر الدولار', 'سعر الدولار مقابل عملتك مثال : .سعر الدولار بالمصري', 'USD price in your currency'],
    ['.حساب (العملية)', 'العملية الحسابية مثال : .حساب 12 + 12', 'math calculation example : .حساب 12 + 12'],
    ['.ابعت (العدد) (الرساله)', 'ارسال رسايل متكرره في المحادثه', 'send repeated messages in the chat'],
    ['.نشر (الرساله)', 'نشر رساله لجميع المحادثات', 'broadcast a message to all chats'],
    ['.نشر للمجموعات (الرساله)', 'نشر رساله لجميع المجموعات', 'broadcast a message to all groups'],
    ['.اسم (الاسم)', 'تغيير اسم حسابك', 'change your account name'],
    ['.تغيير صورتي', 'تغيير صورة الحساب بالرد على صوره', 'set profile picture by replying to an image'],
    ['.تغيير صورة تلقائيا (العدد)', 'تغيير صورة البروفايل تلقائيا', 'auto rotate your profile picture'],
    ['.ايقاف تغيير صورة', 'ايقاف تغيير الصوره التلقائي', 'stop auto rotate'],
    ['.حذف مجلد الصور الخاص بي', 'حذف مجلد صور البروفايل', 'delete your profile photos folder'],
    ['.كتم', 'كتم مستخدم في المجموعات بالرد على رسالته', 'mute a user in groups (reply to their message)'],
    ['.المكتومين', 'قائمه المستخدمين المكتومين في المجموعة', 'list muted users in the group'],
    ['.حظر', 'حظر المستخدم في المحادثه', 'block the user in the chat'],
    ['.هل قام بحظري', 'فحص هل قام المستخدم بحظرك', 'check if someone blocked you'],
    ['.حذف رسائلي', 'حذف كل رسائلك في المحادثه', 'delete your messages in the chat'],
    ['.حذف جميع الرسائل', 'حذف رسائل المحادثه من الطرفين', 'delete chat messages from both sides']
];

// قائمة الاوامر : مرقمة ومرتبة بدون شرح — الامر وجنبه رقم ترتيبه لاخر عدد الاوامر
function commandsText(lang) {
    const L = LANGS[lang] || LANGS.ar;
    const lines = COMMANDS.map((c, i) => `${i + 1} ${c[0]}`);
    return `${L.cmds_header}\n\n${lines.join('\n')}\n\n${SIGNATURE}`;
}

// ==========================================
// 🔧 أدوات عامة
// ==========================================
const cleanDigits = (n) => String(n || '').replace(/\D/g, '');
function numFromJid(jid) {
    return String(jid || '').split(':')[0].split('@')[0].replace(/\D/g, '');
}
function fmtDate(tsSec) {
    const d = tsSec ? new Date(Number(tsSec) * 1000) : new Date();
    try { return d.toLocaleString('ar-EG'); } catch (_) { return d.toISOString(); }
}
function fmtSize(v) {
    const n = Number(v && v.low !== undefined ? v.low : v) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
// رقم هاتف منسق مع رمز الدولة بدون مسافات مثل +201214629001
// بدون اي محارف تحكم — الرقم الصلب (+ لزق بالارقام) بيتعرض مظبوط وسط الكلام العربي
// وبيتاكد ان الرقم صحيح (7 الى 15 رقم)
function fmtPhone(n) {
    const d = cleanDigits(n);
    if (!d || !/^\d{7,15}$/.test(d)) return '(رقم غير صحيح)';
    return `+${d}`;
}
// هل ده معرف داخلي (LID) وليس رقم تليفون حقيقي؟
function isLidJid(jid) {
    const s = String(jid || '');
    return s.endsWith('@lid') || s.endsWith('@hosted.lid');
}
// فك معرف LID الى رقم الهاتف الحقيقي من خريطة الجلسة
function resolveNumber(A, jid) {
    const s = String(jid || '');
    if (!s) return null;
    if (!isLidJid(s)) {
        if (s.endsWith('@s.whatsapp.net')) return numFromJid(s);
        return cleanDigits(s) || null;
    }
    const lid = numFromJid(s);
    if (A && A.lidMap && A.lidMap.has(lid)) return A.lidMap.get(lid);
    return null;
}
// تعلم خريطة LID ← الرقم الحقيقي من الحقول البديلة في مفاتيح الرسايل (baileys 7)
function learnLidMapping(A, key) {
    try {
        if (!key || !A || !A.lidMap) return;
        const pairs = [];
        if (isLidJid(key.remoteJid) && key.remoteJidAlt) pairs.push([numFromJid(key.remoteJid), numFromJid(key.remoteJidAlt)]);
        if (isLidJid(key.participant) && key.participantAlt) pairs.push([numFromJid(key.participant), numFromJid(key.participantAlt)]);
        let changed = false;
        for (const [lid, pn] of pairs) {
            if (lid && pn && pn.length >= 7 && A.lidMap.get(lid) !== pn) {
                A.lidMap.set(lid, pn);
                changed = true;
            }
        }
        if (changed) {
            if (A.lidMap.size > 3000) {
                const first = A.lidMap.keys().next().value;
                A.lidMap.delete(first);
            }
            saveLidMap(A);
        }
    } catch (_) {}
}
function saveLidMap(A) {
    clearTimeout(A._lidTimer);
    A._lidTimer = setTimeout(() => {
        try { setSetting(`lidmap:${A.num}`, JSON.stringify([...A.lidMap])); } catch (_) {}
    }, 2000);
}
// فك اي جهاز/ارقام لرقم الهاتف الحقيقي — لو معرف LID مش معروف نرجع null
function displayNum(A, jid) {
    const real = resolveNumber(A, jid);
    if (real) return fmtPhone(real);
    if (isLidJid(jid)) return '(رقم غير معروف)';
    const d = cleanDigits(jid);
    if (!d || !/^\d{7,15}$/.test(d)) return '(رقم غير معروف)';
    return `+${d}`;
}
// معرف موحد للشات : الرقم الحقيقي لو متاح وإلا الجيد نفسه
function chatKey(chat, A) {
    const real = resolveNumber(A, chat);
    return real ? `${real}@s.whatsapp.net` : chat;
}
// المحادثات النشطة = الارقام اللي المستخدم بيكلمها فعلا برسايل صادرة منه
function isActiveChat(A, chat) {
    const real = resolveNumber(A, chat);
    if (real && A.activeChats.has(`${real}@s.whatsapp.net`)) return true;
    return A.activeChats.has(chat);
}
function isActiveNum(A, n) { return !!n && A.activeChats.has(`${String(n)}@s.whatsapp.net`); }
function markActiveChat(A, chat) {
    const k = chatKey(chat, A);
    if (!A.activeChats.has(k)) {
        A.activeChats.add(k);
        if (A.activeChats.size > 1000) {
            const f = A.activeChats.values().next().value;
            A.activeChats.delete(f);
        }
        saveActiveChats(A);
    }
}
function saveActiveChats(A) {
    clearTimeout(A._actTimer);
    A._actTimer = setTimeout(() => {
        try { setSetting(`activechats:${A.num}`, JSON.stringify([...A.activeChats])); } catch (_) {}
    }, 2000);
}
// عرض المحادثة في التقارير (مجموعة او رقم هاتف بالشكل الصحيح)
function displayChat(chat, A) {
    if (!chat) return '(غير معروف)';
    if (chat.endsWith('@g.us')) return 'مجموعة';
    if (chat.endsWith('@newsletter')) return 'قناة';
    if (isLidJid(chat)) {
        const real = resolveNumber(A, chat);
        return real ? fmtPhone(real) : '(رقم غير معروف)';
    }
    return fmtPhone(chat);
}
function gizaTime() {
    try {
        const s = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true
        }).format(new Date());
        return s.replace('AM', 'ص').replace('PM', 'م').replace('am', 'ص').replace('pm', 'م');
    } catch (_) {
        return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
}
function unwrapMessage(message) {
    let m = message;
    let viewOnce = false;
    let edited = false;
    const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'deviceSentMessage', 'editedMessage'];
    for (let i = 0; i < 5 && m; i++) {
        const k = Object.keys(m || {}).find(x => wrappers.includes(x));
        if (!k) break;
        if (k.startsWith('viewOnce')) viewOnce = true;
        if (k === 'editedMessage') edited = true;
        m = m[k] && m[k].message;
    }
    return { msg: m, viewOnce, edited };
}
function extractText(inner) {
    return (inner && (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.buttonsResponseMessage?.selectedDisplayText ||
        inner.listResponseMessage?.title
    )) || '';
}
function mediaKind(inner) {
    if (!inner) return null;
    if (inner.imageMessage) return 'صوره';
    if (inner.videoMessage) return 'فيديو';
    if (inner.stickerMessage) return 'ملصق';
    if (inner.audioMessage) return 'صوت';
    if (inner.documentMessage) return 'ملف';
    return null;
}
function getQuoted(msg) {
    try {
        const m = unwrapMessage(msg.message).msg || {};
        const ct = Object.keys(m).find(k => m[k] && m[k].contextInfo && m[k].contextInfo.quotedMessage);
        if (!ct) return null;
        const info = m[ct].contextInfo;
        const qm = unwrapMessage(info.quotedMessage).msg;
        if (!qm) return null;
        return {
            msg: qm,
            participant: info.participant || null,
            stanzaId: info.stanzaId || null,
            viewOnce: unwrapMessage(info.quotedMessage).viewOnce
        };
    } catch (_) { return null; }
}
async function downloadMedia(inner, preferType) {
    const types = preferType ? [preferType] : ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'];
    for (const t of types) {
        const c = inner && inner[t];
        if (!c) continue;
        const kind = t.replace('Message', '').toLowerCase();
        try {
            const stream = await downloadContentFromMessage(c, kind);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return { buffer: Buffer.concat(chunks), kind, content: c, mimetype: c.mimetype || '', seconds: c.seconds || 0, fileName: c.fileName || '' };
        } catch (_) {}
    }
    return null;
}
async function getBio(sock, jid) {
    try {
        const res = await sock.fetchStatus(jid);
        if (Array.isArray(res)) return res[0]?.status || '';
        if (res && res.status) return String(res.status);
        return '';
    } catch (_) { return ''; }
}

// ==========================================
// 🤖 بوت التليجرام
// ==========================================
const tgAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    timeout: 30000
});

const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 300000,
    telegram: { agent: tgAgent, attachmentAgent: tgAgent }
});

const connectLock = new Set();
const userStates = new Map(); // cid -> { type }

// زر بلون (Bot API 9.4 : primary / success / danger) بدون أي ايموجي
function cbtn(text, data, style) {
    const b = Markup.button.callback(text, data);
    if (style) b.style = style;
    return b;
}
function ubtn(text, url, style) {
    const b = Markup.button.url(text, url);
    if (style) b.style = style;
    return b;
}

async function safeAnswerCb(ctx, text) {
    try { await ctx.answerCbQuery(text); } catch (_) {}
}

async function safeEdit(ctx, text, extra = {}) {
    try {
        await ctx.editMessageText(text, { disable_web_page_preview: true, ...extra });
    } catch (e) {
        if (String(e?.description || '').includes('message is not modified')) return;
        try { await ctx.reply(text, { disable_web_page_preview: true, ...extra }); } catch (_) {}
    }
}

function mainMenuKb(lang, is_admin) {
    const L = LANGS[lang] || LANGS.ar;
    const rows = [
        [cbtn(L.btn_link, 'connect', 'success')],
        [cbtn(L.btn_disc, 'disconnect', 'danger')],
        [cbtn(L.btn_cmds, 'show_commands', 'primary')],
        [cbtn(L.btn_howto, 'explain_bot', 'primary')],
        [cbtn(L.btn_lang, 'change_lang', 'primary')]
    ];
    if (is_admin) rows.push([cbtn(L.btn_admin, 'admin_info', 'primary')]);
    return Markup.inlineKeyboard(rows);
}

async function sendMainMenu(ctx, lang) {
    const L = LANGS[lang] || LANGS.ar;
    const name = ctx.from?.first_name || (lang === 'ar' ? 'صديقي' : 'friend');
    const caption = L.welcome(name);
    const kb = mainMenuKb(lang, isAdminId(ctx.from?.id));

    // التنقل بالتعديل : نفس الرسالة تتحدث (نص أو صورة) بدل ما تتكرر كل مرة
    const cbMsg = ctx.callbackQuery?.message;
    if (cbMsg) {
        try {
            if (cbMsg.photo) await ctx.editMessageCaption(caption, { ...kb });
            else await ctx.editMessageText(caption, { disable_web_page_preview: true, ...kb });
            return;
        } catch (e) {
            if (String(e?.description || '').includes('message is not modified')) return;
            // فشل التعديل (مثلا رسالة قديمة) → نمسح ونرسل رسالة جديدة
            try { await ctx.deleteMessage(); } catch (_) {}
        }
    }
    if (fs.existsSync(START_IMAGE)) {
        try { return await ctx.replyWithPhoto({ source: START_IMAGE }, { caption, ...kb }); } catch (_) {}
    }
    return ctx.reply(caption, kb).catch(() => {});
}

async function showScreen(ctx, text, kb) {
    try {
        await ctx.editMessageText(text, { disable_web_page_preview: true, ...(kb || {}) });
        return;
    } catch (_) {}
    try { await ctx.reply(text, kb || undefined); } catch (_) {}
}

function langKb() {
    return Markup.inlineKeyboard([
        [cbtn(LANGS.ar.btn_ar, 'lang_ar', 'success')],
        [cbtn(LANGS.en.btn_en, 'lang_en', 'success')]
    ]);
}

function subKb(lang) {
    const L = LANGS[lang] || LANGS.ar;
    return Markup.inlineKeyboard([
        [ubtn(L.btn_channel, CHANNEL_URL, 'danger')],
        [cbtn(L.btn_check, 'check_sub', 'success')]
    ]);
}

const backKb = (style = 'primary') => Markup.inlineKeyboard([[cbtn(LANGS.ar.btn_back, 'back', style)]]);

async function isSubscribed(uid) {
    if (isAdminId(uid)) return true;
    try {
        const m = await withTimeout(bot.telegram.getChatMember(SOURCE_CHANNEL, uid), 8000);
        return !['left', 'kicked'].includes(m.status);
    } catch (_) {
        // البوت مقدرش يتأكد - نسمح عشان البوت ميقعش
        return true;
    }
}

// ─── تسجيل المستخدمين + حجب المحظورين ───
bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid) {
        if (!isAdminId(uid) && isBanned(uid)) return; // محظور - تجاهل تام
        try { q.upsertBotUser(String(uid), ctx.from.first_name || '', ctx.from.username || ''); } catch (_) {}
    }
    return next();
});
bot.catch((err) => console.error('❌ Telegram handler error:', err?.message || err));

// ─── /start : الاشتراك في القناة ← اختيار اللغة ← القائمة الرئيسية ───
bot.start(async (ctx) => {
    const uid = ctx.from.id;
    const lang = langOf(uid);
    const L = LANGS[lang] || LANGS.ar;
    if (!(await isSubscribed(uid))) {
        return ctx.reply(L.need_sub, subKb(lang)).catch(() => {});
    }
    if (!getLang(uid)) {
        return ctx.reply(L.choose_lang, langKb()).catch(() => {});
    }
    return sendMainMenu(ctx, lang);
});

bot.action('check_sub', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    if (!(await isSubscribed(ctx.from.id))) {
        return safeEdit(ctx, L.sub_not_yet, subKb(lang));
    }
    if (!getLang(ctx.from.id)) {
        return safeEdit(ctx, L.choose_lang, langKb());
    }
    return sendMainMenu(ctx, lang);
});

bot.action('lang_ar', async (ctx) => {
    await safeAnswerCb(ctx);
    q.setLang(String(ctx.from.id), 'ar');
    return sendMainMenu(ctx, 'ar');
});

bot.action('lang_en', async (ctx) => {
    await safeAnswerCb(ctx);
    q.setLang(String(ctx.from.id), 'en');
    return sendMainMenu(ctx, 'en');
});

// ─── تغيير اللغة من القائمة الرئيسية ───
bot.action('change_lang', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    return safeEdit(ctx, L.choose_lang, Markup.inlineKeyboard([
        [cbtn(LANGS.ar.btn_ar, 'lang_ar', 'success')],
        [cbtn(LANGS.en.btn_en, 'lang_en', 'success')],
        [cbtn(L.btn_back, 'back', 'primary')]
    ]));
});

bot.action('back', async (ctx) => {
    await safeAnswerCb(ctx);
    // رجوع للقائمة الرئيسية بتعديل نفس الرسالة بدل ما نمسح ونبعت رسالة جديدة
    return sendMainMenu(ctx, langOf(ctx.from.id));
});

// ─── الاوامر المتاحة ───
bot.action('show_commands', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    showScreen(ctx, `${L.cmds_header}\n\n${commandsText(lang)}`, backKb());
});

// ─── ازاي استخدم البوت ───
bot.action('explain_bot', async (ctx) => {
    await safeAnswerCb(ctx);
    const L = T(ctx.from.id);
    showScreen(ctx, L.howto, backKb());
});

// ─── ربط رقمك : اختيار الطريقة (كود ربط أو QR) ───
bot.action('connect', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    if (!(await isSubscribed(ctx.from.id))) return safeEdit(ctx, L.need_sub, subKb(lang));
    const cid = ctx.chat.id;
    const num = getUserNumber(cid);
    if (num && sessionState(num) === 'paired') {
        return showScreen(ctx,
            `${L.already_linked(num)}\n${L.replace_hint}`,
            Markup.inlineKeyboard([
                [cbtn(L.btn_replace, 'replace_number', 'danger')],
                [cbtn(L.btn_back, 'back', 'primary')]
            ]));
    }
    await cancelPairingsOfChat(cid);
    return showScreen(ctx, L.choose_link, Markup.inlineKeyboard([
        [cbtn(L.btn_link_code, 'connect_code', 'success')],
        [cbtn(L.btn_link_qr, 'connect_qr', 'success')],
        [cbtn(L.btn_back, 'back', 'primary')]
    ]));
});

bot.action('connect_code', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const cid = ctx.chat.id;
    await cancelPairingsOfChat(cid);
    userStates.set(cid, { type: 'number', mode: 'code' });
    return showScreen(ctx, L.send_phone, Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'danger')]]));
});

bot.action('connect_qr', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const cid = ctx.chat.id;
    await cancelPairingsOfChat(cid);
    userStates.set(cid, { type: 'number', mode: 'qr' });
    return showScreen(ctx, L.send_phone, Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'danger')]]));
});

bot.action('replace_number', async (ctx) => {
    await safeAnswerCb(ctx);
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const cid = ctx.chat.id;
    const num = getUserNumber(cid);
    if (num) await fullDisconnect(num);
    removeUser(cid);
    userStates.set(cid, { type: 'number' });
    return showScreen(ctx, L.send_phone, Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'danger')]]));
});

bot.action('cancel_pair', async (ctx) => {
    await safeAnswerCb(ctx);
    const cid = ctx.chat.id;
    userStates.delete(cid);
    const n = await cancelPairingsOfChat(cid);
    const L = T(cid);
    showScreen(ctx, n ? L.pair_cancelled : L.no_number,
        Markup.inlineKeyboard([
            [cbtn(L.btn_link, 'connect', 'success')],
            [cbtn(L.btn_back, 'back', 'primary')]
        ]));
});

// ─── قطع الاتصال ───
bot.action('disconnect', async (ctx) => {
    await safeAnswerCb(ctx);
    const cid = ctx.chat.id;
    userStates.delete(cid);
    const L = T(cid);
    const num = getUserNumber(cid);
    const cancelled = await cancelPairingsOfChat(cid);
    if (!num) {
        return showScreen(ctx, cancelled ? L.pair_cancelled : L.no_number,
            Markup.inlineKeyboard([
                [cbtn(L.btn_link, 'connect', 'success')],
                [cbtn(L.btn_back, 'back', 'primary')]
            ]));
    }
    await fullDisconnect(num);
    removeUser(cid);
    showScreen(ctx, L.disconnected(num),
        Markup.inlineKeyboard([
            [cbtn(L.btn_link, 'connect', 'success')],
            [cbtn(L.btn_back, 'back', 'primary')]
        ]));
});

// ==========================================
// 👑 لوحة الادمن
// ==========================================
function adminKb(lang) {
    const L = LANGS[lang] || LANGS.ar;
    return Markup.inlineKeyboard([
        [cbtn(L.btn_broadcast, 'broadcast_start', 'success')],
        [cbtn(L.btn_ban, 'ban_user', 'danger'), cbtn(L.btn_banned, 'banned_list', 'primary')],
        [cbtn(L.btn_numbers, 'admin_list', 'primary')],
        [cbtn(L.btn_back, 'back', 'primary')]
    ]);
}

async function adminStatsText(lang) {
    const L = LANGS[lang] || LANGS.ar;
    const sessions = listConnectedSessions();
    // العدد الحقيقي للمربوطين : أرقام جلساتها فعلا مربوطة (مش مجرد متسجلة في قاعدة البيانات)
    const linkedCount = listAllNumbers().filter(n => sessionState(n) === 'paired').length;
    return `${L.admin_title}\n\n` +
        `${L.st_users} : ${activeBotUsers().length}\n` +
        `${L.st_linked} : ${linkedCount}\n` +
        `${L.st_online} : ${sessions.length}\n` +
        `${L.st_banned} : ${q.countBanned().c}`;
}

bot.command('admin', async (ctx) => {
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    return ctx.reply(await adminStatsText(lang), adminKb(lang)).catch(() => {});
});

bot.action('admin_info', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    return safeEdit(ctx, await adminStatsText(lang), adminKb(lang));
});

// ─── قائمة الارقام (ادمن) ───
bot.action('admin_list', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const nums = listAllNumbers();
    if (!nums.length) return showScreen(ctx, L.no_numbers, backKb());
    let list = `${L.numbers_title(nums.length)}\n\n`;
    nums.forEach((s, i) => {
        const uid = getCidByNumber(s);
        list += `${i + 1}. +${s} | ${uid ? uid : '-'} | ${numberStatus(s)}\n`;
    });
    showScreen(ctx, list, Markup.inlineKeyboard([
        [cbtn(L.btn_disc_all, 'admin_disc_all', 'danger')],
        [cbtn(L.btn_back, 'admin_info', 'primary')]
    ]));
});

bot.action(/admin_disc_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const num = ctx.match[1];
    const owner = getCidByNumber(num);
    await fullDisconnect(num);
    if (owner) removeUser(owner);
    showScreen(ctx, L.admin_disc_done(num), backKb());
});

bot.action('admin_disc_all', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const nums = listAllNumbers();
    setImmediate(async () => {
        for (const n of nums) {
            const owner = getCidByNumber(n);
            await fullDisconnect(n).catch(() => {});
            if (owner) removeUser(owner);
            await yieldLoop();
        }
    });
    showScreen(ctx, L.admin_disc_all_done(nums.length), backKb());
});

// ─── حظر مستخدم ───
bot.action('ban_user', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    userStates.set(ctx.chat.id, { type: 'ban_user' });
    showScreen(ctx, L.ban_prompt, backKb());
});

bot.action('banned_list', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    const all = q.allBanned();
    if (!all.length) return showScreen(ctx, L.no_banned, backKb());
    let txt = `${L.banned_title(all.length)}\n\n`;
    all.forEach((b, i) => {
        txt += `${i + 1}. ${b.name || '-'} | ${b.handle || b.cid}\n`;
    });
    const btns = all.map(b => [cbtn(`${L.btn_unban} (${b.handle || b.cid})`, `unb_${b.cid}`, 'danger')]);
    btns.push([cbtn(L.btn_back, 'admin_info', 'primary')]);
    showScreen(ctx, txt, Markup.inlineKeyboard(btns));
});

bot.action(/unb_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    unbanTelegramUser(ctx.match[1]);
    const all = q.allBanned();
    if (!all.length) return showScreen(ctx, L.no_banned, backKb());
    let txt = `${L.banned_title(all.length)}\n\n`;
    all.forEach((b, i) => {
        txt += `${i + 1}. ${b.name || '-'} | ${b.handle || b.cid}\n`;
    });
    const btns = all.map(b => [cbtn(`${L.btn_unban} (${b.handle || b.cid})`, `unb_${b.cid}`, 'danger')]);
    btns.push([cbtn(L.btn_back, 'admin_info', 'primary')]);
    showScreen(ctx, txt, Markup.inlineKeyboard(btns));
});

// ==========================================
// 📢 الاذاعه (بنظام المجموعات في الخلفية)
// ==========================================
let activeBroadcast = null;

bot.action('broadcast_start', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    const lang = langOf(ctx.from.id);
    const L = LANGS[lang] || LANGS.ar;
    if (activeBroadcast && !activeBroadcast.cancelled) {
        return showScreen(ctx, L.bc_running,
            Markup.inlineKeyboard([
                [cbtn(L.bc_stop, 'broadcast_cancel', 'danger')],
                [cbtn(L.btn_back, 'admin_info', 'primary')]
            ]));
    }
    userStates.set(ctx.chat.id, { type: 'broadcast' });
    showScreen(ctx, L.bc_prompt,
        Markup.inlineKeyboard([[cbtn(L.btn_back, 'admin_info', 'primary')]]));
});

bot.action('broadcast_cancel', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdminId(ctx.from.id)) return;
    if (activeBroadcast) activeBroadcast.cancelled = true;
});

async function sendCopyToUserSmart(targetCid, fromChatId, messageId, state) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (state.cancelled) return 'cancelled';
        try {
            await withTimeout(bot.telegram.copyMessage(targetCid, fromChatId, messageId), 10000);
            return 'sent';
        } catch (err) {
            const code = err?.response?.error_code;
            const desc = (err?.response?.description || err?.message || '').toLowerCase();
            const retryAfter = err?.response?.parameters?.retry_after;
            if (code === 429 && retryAfter && attempt === 1) {
                await sleep((Number(retryAfter) + 1) * 1000);
                continue;
            }
            if (code === 403 || desc.includes('blocked') || desc.includes('deactivated') || desc.includes('chat not found') || desc.includes('user not found')) {
                q.delBotUser(targetCid);
                return 'removed';
            }
            return 'failed';
        }
    }
    return 'failed';
}

function buildProgressBar(done, total) {
    if (!total) return '---------- 100%';
    const pct = Math.min(100, Math.round((done / total) * 100));
    const filled = Math.round(pct / 10);
    return '='.repeat(filled) + '-'.repeat(10 - filled) + ` ${pct}%`;
}

async function runBroadcastInBatches(adminChatId, message, statusMsgId) {
    const lang = langOf(adminChatId);
    const L = LANGS[lang] || LANGS.ar;
    const users = q.allBotUsers();
    const total = users.length;
    const BATCH_SIZE = 20;
    const totalBatches = Math.ceil(total / BATCH_SIZE) || 1;
    const state = { cancelled: false };
    activeBroadcast = state;
    let sentTg = 0, removedTg = 0, failedTg = 0, processed = 0;
    let lastUiUpdate = Date.now();

    try {
        for (let b = 0; b < totalBatches; b++) {
            if (state.cancelled) break;
            const batch = users.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(u => sendCopyToUserSmart(u.cid, adminChatId, message.message_id, state))
            );
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    if (r.value === 'sent') sentTg++;
                    else if (r.value === 'removed') removedTg++;
                    else failedTg++;
                } else failedTg++;
            }
            processed += batch.length;

            const now = Date.now();
            if (now - lastUiUpdate >= 3000 && processed < total && !state.cancelled) {
                lastUiUpdate = now;
                const progressTxt =
                    `${L.bc_started}\n\n` +
                    `${buildProgressBar(processed, total)}\n` +
                    `${L.bc_sent} : ${sentTg}\n` +
                    `${L.bc_removed} : ${removedTg}\n` +
                    `${L.bc_failed} : ${failedTg}\n` +
                    `${L.bc_total} : ${processed} / ${total}`;
                bot.telegram.editMessageText(adminChatId, statusMsgId, null, progressTxt, {
                    ...Markup.inlineKeyboard([[cbtn(L.bc_stop, 'broadcast_cancel', 'danger')]])
                }).catch(() => {});
            }
            await yieldLoop();
            if (b + 1 < totalBatches && !state.cancelled) await sleep(900);
        }

        const finalHeader = state.cancelled ? L.bc_stopped : L.bc_done;
        const finalTxt =
            `${finalHeader}\n\n` +
            `${buildProgressBar(processed, total)}\n` +
            `${L.bc_sent} : ${sentTg}\n` +
            `${L.bc_removed} : ${removedTg}\n` +
            `${L.bc_failed} : ${failedTg}\n` +
            `${L.bc_total} : ${processed} / ${total}`;
        await bot.telegram.editMessageText(adminChatId, statusMsgId, null, finalTxt, {
            ...Markup.inlineKeyboard([[cbtn(L.btn_back, 'admin_info', 'primary')]])
        }).catch(() => {});
    } finally {
        activeBroadcast = null;
    }
}

// ─── استقبال الرسايل حسب الحالة ───
bot.on('message', async (ctx) => {
    const cid = ctx.chat?.id;
    if (!cid) return;
    const state = userStates.get(cid);
    if (!state) return;

    // الاذاعه (ادمن فقط)
    if (state.type === 'broadcast') {
        if (!isAdminId(ctx.from.id)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const lang = langOf(cid);
        const L = LANGS[lang] || LANGS.ar;
        const wait = await ctx.reply(L.bc_started, {
            ...Markup.inlineKeyboard([[cbtn(L.bc_stop, 'broadcast_cancel', 'danger')]])
        }).catch(() => null);
        setImmediate(() => {
            if (wait) runBroadcastInBatches(cid, ctx.message, wait.message_id).catch(err => console.error('❌ خطأ أثناء الإذاعة:', err?.message || err));
        });
        return;
    }

    if (!ctx.message?.text) return;
    const text = ctx.message.text.trim();

    // حظر مستخدم (ادمن فقط)
    if (state.type === 'ban_user') {
        if (!isAdminId(ctx.from.id)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const lang = langOf(cid);
        const L = LANGS[lang] || LANGS.ar;
        const input = text.trim();
        let row = null;
        if (/^\d+$/.test(input)) {
            row = q.getBotUser(input) || { cid: input, name: '', username: '' };
            row.cid = String(input);
        } else {
            const uname = input.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').trim();
            row = q.allBotUsers().find(u => (u.username || '').toLowerCase() === uname.toLowerCase());
            if (!row) return ctx.reply(L.ban_notfound).catch(() => {});
        }
        if (isAdminId(row.cid)) return ctx.reply(L.err).catch(() => {});
        const handle = row.username ? `@${row.username}` : (row.cid ? row.cid : input);
        const phone = getUserNumber(row.cid);
        banTelegramUser(row.cid, row.name || '', phone ? `+${phone}` : handle);
        const num = getUserNumber(row.cid);
        if (num) {
            await fullDisconnect(num).catch(() => {});
            removeUser(row.cid);
        }
        return ctx.reply(L.ban_done(row.name || '', phone ? `+${phone}` : handle)).catch(() => {});
    }

    // ادخال الرقم للربط
    if (state.type === 'number') {
        const lang = langOf(cid);
        const L = LANGS[lang] || LANGS.ar;
        const number = text.replace(/\D/g, '');
        if (!number || number.length < 7 || number.length > 15) {
            return ctx.reply(L.invalid_number).catch(() => {});
        }
        const me = String(cid);
        if (connectLock.has(number)) return ctx.reply(L.preparing).catch(() => {});

        const mine = getUserNumber(cid);
        if (mine && mine !== number) {
            if (sessionState(mine) === 'paired') {
                userStates.delete(cid);
                return ctx.reply(`${L.already_linked(mine)}\n${L.replace_hint}`, {
                    ...Markup.inlineKeyboard([[cbtn(L.btn_replace, 'replace_number', 'danger')]])
                }).catch(() => {});
            }
            await fullDisconnect(mine);
        }

        const owner = getCidByNumber(number);
        const st = sessionState(number);
        const pend = pendingPairs.get(number);

        if (pend && String(pend.cid) !== me) {
            userStates.delete(cid);
            return ctx.reply(L.number_busy(number)).catch(() => {});
        }
        if (st === 'paired' && !pend && owner !== me) {
            userStates.delete(cid);
            return ctx.reply(L.number_taken(number)).catch(() => {});
        }

        userStates.delete(cid);
        const mode = state.mode === 'qr' ? 'qr' : 'code';
        const waitMsg = mode === 'qr' ? L.qr_wait : L.preparing;
        const wait = await ctx.reply(waitMsg).catch(() => null);
        connectLock.add(number);

        setImmediate(async () => {
            try {
                await cancelPairingsOfChat(cid);
                if (st !== 'none' || owner) await fullDisconnect(number);

                const code = await startWhatsApp(number, { cid, mode });
                const p = pendingPairs.get(number);
                if (p) p.msgId = wait ? wait.message_id : null;

                if (wait) {
                    const doneTxt = mode === 'qr' ? L.qr_sent : (code ? L.pair_code(code) : L.no_number);
                    // نص كود الربط فيه <code> للنسخ بضغطة واحدة → parse_mode HTML في وضع الكود فقط
                    const doneExtra = mode === 'qr' ? {} : { parse_mode: 'HTML' };
                    await ctx.telegram.editMessageText(cid, wait.message_id, null,
                        doneTxt,
                        { ...doneExtra,
                          disable_web_page_preview: true,
                          ...Markup.inlineKeyboard([
                              [cbtn(L.btn_cancel_pair, 'cancel_pair', 'danger')],
                              [cbtn(L.btn_back, 'back', 'primary')]
                          ]) }
                    ).catch(() => {});
                }
            } catch (e) {
                if (e && e.cancelled) return;
                await fullDisconnect(number).catch(() => {});
                if (wait) {
                    await ctx.telegram.editMessageText(cid, wait.message_id, null,
                        `${L.pair_fail}\n${e?.message || ''}`,
                        { ...Markup.inlineKeyboard([
                            [cbtn(L.btn_try_again, 'connect', 'success')],
                            [cbtn(L.btn_back, 'back', 'primary')]
                        ]) }
                    ).catch(() => {});
                }
            } finally {
                connectLock.delete(number);
            }
        });
    }
});

// ─── لو خرج من قناة السورس وهو مربوط نقطع رقمه ───
bot.on('chat_member', async (ctx) => {
    try {
        const upd = ctx.chatMember;
        const chatUsername = ctx.chat?.username ? `@${ctx.chat.username}` : null;
        if (!chatUsername || chatUsername.toLowerCase() !== SOURCE_CHANNEL.toLowerCase()) return;
        if (['left', 'kicked'].includes(upd.new_chat_member.status)) {
            const uid = upd.new_chat_member.user.id;
            if (isAdminId(uid)) return;
            const num = getUserNumber(uid);
            await cancelPairingsOfChat(uid);
            if (num) {
                await fullDisconnect(num);
                removeUser(uid);
                bot.telegram.sendMessage(uid, LANGS.ar.left_channel(num), {}).catch(() => {});
            }
        }
    } catch (_) {}
});

// ==========================================
// 📱 واتساب - الكور الأساسي
// ==========================================
const sockets = {};                    // رقم -> سوكيت نشط
const reconnectAttempts = new Map();
const reconnectTimers = new Map();
const watchdogs = new Map();
const pendingPairs = new Map();        // رقم -> { cid, paired, codeSent, msgId, timer }
const epochs = new Map();
const stoppedSessions = new Set();

const getEpoch = (n) => epochs.get(n) || 0;
const bumpEpoch = (n) => { epochs.set(n, getEpoch(n) + 1); return getEpoch(n); };

let cachedWaVersion = null;
let cachedWaVersionAt = 0;
async function getWaVersionSafe() {
    if (cachedWaVersion && Date.now() - cachedWaVersionAt < 60 * 60 * 1000) {
        return cachedWaVersion;
    }
    try {
        const res = await withTimeout(fetchLatestBaileysVersion(), 4000);
        if (res?.version) {
            cachedWaVersion = res.version;
            cachedWaVersionAt = Date.now();
        }
    } catch (_) {}
    return cachedWaVersion;
}

// 🪄 علاج ذاتي للجلسة التالفة (كود 500 متكرر) مع الحفاظ على الربط
function healCorruptedSessionKeys(cleanNum) {
    const sessionPath = path.join(sessionsDir, cleanNum);
    if (!fs.existsSync(sessionPath)) return;
    try {
        const files = fs.readdirSync(sessionPath);
        let cleaned = 0;
        for (const f of files) {
            if (f === 'creds.json' || f.startsWith('app-state-sync-key')) continue;
            if (f.startsWith('session-') || f.startsWith('sender-key-') || f.startsWith('pre-key-')) {
                try { fs.unlinkSync(path.join(sessionPath, f)); cleaned++; } catch (_) {}
            }
        }
        if (cleaned > 0) console.log(`🩺 تنظيف ${cleaned} ملف تشفير معلق للرقم ${cleanNum}`);
    } catch (_) {}
}

function isPairedCreds(creds) {
    return !!(creds && (creds.registered || creds.account || (creds.me?.id && creds.me.name !== '~')));
}
function readSessionCreds(num) {
    try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, num, 'creds.json'), 'utf-8')); }
    catch (_) { return null; }
}
function sessionDirs() {
    try {
        return fs.readdirSync(sessionsDir).filter(f => {
            try { return fs.statSync(path.join(sessionsDir, f)).isDirectory(); } catch (_) { return false; }
        });
    } catch (_) { return []; }
}
function listConnectedSessions() { return sessionDirs().filter(n => isPairedCreds(readSessionCreds(n))); }

function sessionState(num) {
    if (isPairedCreds(readSessionCreds(num))) return 'paired';
    if (pendingPairs.has(num) || sockets[num] || fs.existsSync(path.join(sessionsDir, num))) return 'pending';
    return 'none';
}
function listAllNumbers() {
    return [...new Set([...sessionDirs(), ...pendingPairs.keys(), ...q.allUsers().map(u => u.number)])];
}
function numberStatus(n) {
    const st = sessionState(n);
    if (stoppedSessions.has(n)) return '🛑';
    return st === 'paired' ? '✅' : st === 'pending' ? '⏳' : '⚠️';
}

// ─── تجاهل أخطاء التشفير المعروفة في بايليز ───
const ignoreErrors = ['Bad MAC', 'Key used already', 'No session', 'Failed to decrypt'];
process.on('uncaughtException', (err) => {
    if (ignoreErrors.some(e => err?.message?.includes(e))) return;
    console.error('❌ Uncaught:', err?.message || err);
});
process.on('unhandledRejection', (err) => {
    if (ignoreErrors.some(e => String(err?.message || '').includes(e))) return;
    console.error('❌ Unhandled:', err?.message || err);
});

// ─── إشعارات تليجرام لعملية الربط ───
function tgUpdatePairMsg(p, text, kb, parseMode) {
    const extra = {
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(kb || {})
    };
    // لو الرسالة الأصلية اتمسحت بنحاول نبعت غيرها ونسجل الـ msgId الجديد (شفاء ذاتي)
    const send = async () => {
        try {
            const m = await bot.telegram.sendMessage(p.cid, text, extra);
            p.msgId = m.message_id;
        } catch (_) {}
    };
    if (p.msgId) bot.telegram.editMessageText(p.cid, p.msgId, null, text, extra).catch(send);
    else send();
}

// تحديث رسالة QR بنفس الرسالة (تعديل الصورة نفسها بدل إرسال صورة جديدة كل مرة)
async function tgUpdateQrPhoto(p, buf, caption, kb) {
    if (p.msgId) {
        try {
            await bot.telegram.editMessageMedia(p.cid, p.msgId, null,
                { type: 'photo', media: { source: buf }, caption },
                kb ? { ...kb } : undefined);
            return;
        } catch (e) {
            if (String(e?.description || '').includes('message is not modified')) return;
        }
    }
    try {
        const m = await bot.telegram.sendPhoto(p.cid, { source: buf }, { caption, ...(kb || {}) });
        p.msgId = m.message_id;
    } catch (e) { console.error('❌ ارسال QR:', e?.message || e); }
}

// كيبورد رسالة الربط (إلغاء + رجوع)
function pairMsgKb(L) {
    return Markup.inlineKeyboard([
        [cbtn(L.btn_cancel_pair, 'cancel_pair', 'danger')],
        [cbtn(L.btn_back, 'back', 'primary')]
    ]);
}
const retryKb = () => Markup.inlineKeyboard([[cbtn(LANGS.ar.btn_try_again, 'connect', 'success'), cbtn(LANGS.ar.btn_back, 'back', 'primary')]]);

function detachSocket(num) {
    const sock = sockets[num];
    delete sockets[num];
    clearWatchdog(num);
    const t = reconnectTimers.get(num);
    if (t) { clearTimeout(t); reconnectTimers.delete(num); }
    reconnectAttempts.delete(num);
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.ev.removeAllListeners('messages.update');
            sock.ev.removeAllListeners('contacts.upsert');
            sock.ev.removeAllListeners('contacts.update');
            sock.ev.removeAllListeners('creds.update');
        } catch (_) {}
    }
    return sock;
}

async function fullDisconnect(numRaw) {
    const num = cleanDigits(numRaw);
    if (!num) return;
    stoppedSessions.delete(num);
    bumpEpoch(num);
    const p = pendingPairs.get(num);
    if (p?.timer) clearTimeout(p.timer);
    pendingPairs.delete(num);

    // إيقاع كل شيء خاص بالحساب (الساعة + تغيير الصور + العد التنازلي + فحص التحديثات)
    stopClock(num);
    stopRotation(num);
    stopAllCountdowns(num);
    stopUpdatesScan(num);
    delete acct[num];

    const sock = detachSocket(num);
    if (sock) {
        if (isPairedCreds(sock.authState?.creds)) {
            try { await Promise.race([sock.logout(), sleep(4000)]); } catch (_) {}
        }
        try { sock.end(undefined); } catch (_) {}
    }
    wipeSessionData(num);
}

async function abortPairing(num, text) {
    const p = pendingPairs.get(num);
    await fullDisconnect(num);
    // تنظيف أي تسجيل مبكر في قاعدة البيانات — عشان اللوحة ماتعرضش الرقم كمربوط
    // والربط فعليا ماكملش
    try {
        const cid = getCidByNumber(num);
        if (cid) removeUser(cid);
    } catch (_) {}
    if (p && p.codeSent && text) tgUpdatePairMsg(p, text, retryKb());
}
async function expirePairing(num) {
    const p = pendingPairs.get(num);
    if (!p || p.paired) return;
    const L = LANGS[langOf(p.cid)] || LANGS.ar;
    const msg = p.mode === 'qr' ? L.pair_timeout_qr(num) : L.pair_timeout(num);
    await abortPairing(num, msg);
}
async function cancelPairingsOfChat(cid) {
    let n = 0;
    for (const [num, p] of [...pendingPairs.entries()]) {
        if (String(p.cid) === String(cid)) { await fullDisconnect(num); n++; }
    }
    return n;
}

function markPaired(num, p) {
    p.paired = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    try { setUserNumber(p.cid, num); } catch (_) {}
}

function scheduleReconnect(cleanNum, delay) {
    const old = reconnectTimers.get(cleanNum);
    if (old) clearTimeout(old);
    const t = setTimeout(async () => {
        reconnectTimers.delete(cleanNum);
        if (sockets[cleanNum]) return;
        if (!fs.existsSync(path.join(sessionsDir, cleanNum))) return;
        try {
            await startWhatsApp(cleanNum);
        } catch (e) {
            console.error(`❌ فشل إعادة اتصال ${cleanNum}:`, e.message);
            if (!sockets[cleanNum] && fs.existsSync(path.join(sessionsDir, cleanNum))) {
                const attempt = (reconnectAttempts.get(cleanNum) || 0) + 1;
                reconnectAttempts.set(cleanNum, attempt);
                scheduleReconnect(cleanNum, Math.min(30000, 2000 * attempt));
            }
        }
    }, delay);
    reconnectTimers.set(cleanNum, t);
}

// استكمال عملية ربط شغالة : اتصال جديد بنفس جلسة الربط عشان تجيب مراجع QR
// وأكواد ربط جديدة، والاكواد بتتجدد وتتحدث في نفس رسالة تليجرام تلقائيا
function schedulePairResume(cleanNum, delay) {
    const old = reconnectTimers.get(cleanNum);
    if (old) clearTimeout(old);
    const t = setTimeout(async () => {
        reconnectTimers.delete(cleanNum);
        if (sockets[cleanNum]) return;
        const p = pendingPairs.get(cleanNum);
        if (!p || p.paired) return;
        if (!fs.existsSync(path.join(sessionsDir, cleanNum))) return;
        try {
            // إلغاء أي طلب كود معلق على السوكيت القديم — نفس أسلوب الكود القديم اللي كان شغال
            bumpEpoch(cleanNum);
            p.resumed = true;
            await startWhatsApp(cleanNum, { cid: p.cid, mode: p.mode });
        } catch (e) {
            if (e?.cancelled) return;
            console.error(`❌ فشل استكمال الربط ${cleanNum}:`, e?.message || e);
            const p2 = pendingPairs.get(cleanNum);
            if (p2 && !p2.paired && (p2.rounds || 0) < MAX_PAIR_ROUNDS) {
                p2.rounds = (p2.rounds || 0) + 1;
                schedulePairResume(cleanNum, 4000);
            }
        }
    }, delay);
    reconnectTimers.set(cleanNum, t);
}

// انتظار جاهزية الاتصال قبل طلب كود الربط
// وصول qr يعني ان العميل مسجل عند سيرفرات واتساب وجاهز لاستقبال كود الربط
// احتياط: ws مفتوح + creds.registered = true
function waitForPairingReady(sock, stale, timeoutMs = 60000) {
    return new Promise((resolve) => {
        let done = false;
        let poll = null;
        let hard = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.ev.off('connection.update', onUpdate); } catch (_) {}
            if (poll) clearInterval(poll);
            if (hard) clearTimeout(hard);
            resolve(ok);
        };
        const onUpdate = (u) => {
            if (stale && stale()) return finish(false);
            if (u && u.qr) return finish(true);
            if (u && u.connection === 'open') return finish(true);
            if (u && u.connection === 'close') return finish(false);
        };
        sock.ev.on('connection.update', onUpdate);
        const checkNow = () => {
            if (stale && stale()) return finish(false);
            try {
                const wsReady = sock.ws && sock.ws.readyState === 1;
                const registered = sock.authState && sock.authState.creds && sock.authState.creds.registered;
                if (wsReady && registered) finish(true);
            } catch (_) {}
        };
        hard = setTimeout(() => finish(false), timeoutMs);
        poll = setInterval(checkNow, 1000);
        checkNow();
    });
}

async function startWhatsApp(phoneNumber, pairInfo = null) {
    const cleanNum = cleanDigits(phoneNumber);
    if (!cleanNum) return null;
    const sessionPath = path.join(sessionsDir, cleanNum);

    if (sockets[cleanNum]) return null;

    const myEpoch = getEpoch(cleanNum);
    const stale = () => getEpoch(cleanNum) !== myEpoch;
    const cancelledErr = () => { const e = new Error('تم إلغاء عملية الربط.'); e.cancelled = true; return e; };
    const dropOrphanDir = () => {
        if (!pendingPairs.has(cleanNum) && !sockets[cleanNum]) {
            try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
        }
    };

    if (!pairInfo && !fs.existsSync(sessionPath)) return null;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const paired = isPairedCreds(state.creds);

    let credsQueue = Promise.resolve();
    const safeSaveCreds = () => {
        credsQueue = credsQueue.then(() => saveCreds()).catch(() => {});
        return credsQueue;
    };

    if (!paired && !pairInfo) {
        if (!stale()) await abortPairing(cleanNum, `⚠️ الربط ماكملش للرقم +${cleanNum}\nتم مسح البيانات ، اطلب كود جديد.`);
        return null;
    }

    // بدون تثبيت نسخة واتساب — نفس الكود القديم اللي كان شغال (الافتراضي بتاع المكتبة)
    if (stale() || sockets[cleanNum]) {
        if (stale()) { dropOrphanDir(); if (pairInfo) throw cancelledErr(); }
        return null;
    }

    const silentLogger = pino({ level: 'fatal' });
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, silentLogger)
                : state.keys
        },
        printQRInTerminal: false,
        logger: silentLogger,
        // هوية المتصفح : نفس هوية الكود القديم اللي كان الربط شغال عليه
        // (Ubuntu Chrome) — هويات الموبايل زي iPhone بتخلي واتساب يرفض كود الربط
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        // مدة صلاحية كل كود ربط/QR : 90 ثانية بدل 20 ثانية — وقت مريح لإدخال الكود في واتساب
        qrTimeout: QR_LIFETIME_MS,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        getMessage: async () => undefined
    });

    sockets[cleanNum] = sock;
    sock.__textStyle = parseInt(getSetting(`textstyle:${cleanNum}`) || '0') || 0;

    // ─── تغييرات البروفايلات (التحديثات) ───
    sock.ev.on('contacts.upsert', (cs) => {
        if (sockets[cleanNum] !== sock) return;
        try { onContactsChanged(cleanNum, sock, cs); } catch (_) {}
    });
    sock.ev.on('contacts.update', (cs) => {
        if (sockets[cleanNum] !== sock) return;
        try { onContactsChanged(cleanNum, sock, cs); } catch (_) {}
    });

    sock.ev.on('creds.update', () => {
        if (sockets[cleanNum] !== sock) return;
        safeSaveCreds();
        const p = pendingPairs.get(cleanNum);
        if (p && !p.paired && isPairedCreds(state.creds)) markPaired(cleanNum, p);
    });

    // ─── استقبال الرسايل + كل الأوامر ───
    // notify = رسايل لحظية | append = رسايل وصلت بعد انقطاع مؤقت (تتقري كمان عشان مفيش رسالة تضيع)
    sock.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
        if (sockets[cleanNum] !== sock || !sock.user) return;
        if (upsertType !== 'notify' && upsertType !== 'append') return;
        const offline = upsertType === 'append';
        for (const msg of messages) {
            try { await onUpsert(cleanNum, sock, msg, offline); } catch (err) {
                console.error(`❌ خطأ معالجة رسالة ${cleanNum}:`, err?.message || err);
            }
            await yieldLoop();
        }
    });

    // ─── التقاط الحذف والتعديل ───
    sock.ev.on('messages.update', async (updates) => {
        if (sockets[cleanNum] !== sock || !sock.user) return;
        try { await onUpdate(cleanNum, sock, updates); } catch (err) {
            console.error(`❌ خطأ messages.update ${cleanNum}:`, err?.message || err);
        }
    });

    // ─── إدارة الاتصال ───
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (sockets[cleanNum] !== sock) return;

        // ─── تسجيل دخول QR : تحديث صورة الكود في نفس الرسالة ───
        const pendQr = pendingPairs.get(cleanNum);
        if (qr && pendQr && pendQr.mode === 'qr' && qr !== pendQr.lastQr && !isPairedCreds(state.creds)) {
            pendQr.lastQr = qr;
            try {
                const qrBuf = await QRCode.toBuffer(qr, { width: 720, margin: 1 });
                const LQ = LANGS[langOf(pendQr.cid)] || LANGS.ar;
                await tgUpdateQrPhoto(pendQr, qrBuf, LQ.qr_sent,
                    Markup.inlineKeyboard([[cbtn(LQ.btn_cancel_pair, 'cancel_pair', 'danger')]]));
            } catch (e) { console.error('❌ ارسال QR:', e?.message || e); }
        }

        // ─── كود الربط الثابت : إعادة تسجيل الكود مع كل جلسة جديدة ───
        // تسجيل كود الربط مرتبط بجلسة QR الحالية وبيموت لما الجلسة تتجدد — عشان كده
        // بنعيد إرسال نفس الكود الثابت مع كل qr جديد بدون تغيير الرسالة (الكود مش بيتغير)
        const pendCode = pendingPairs.get(cleanNum);
        if (qr && pendCode && pendCode.mode === 'code' && pendCode.codeSent &&
            qr !== pendCode.lastQr && !isPairedCreds(state.creds)) {
            pendCode.lastQr = qr;
            if (!pendCode.reqBusy) {
                pendCode.reqBusy = true;
                void (async () => {
                    try {
                        await sleep(600);
                        if (sockets[cleanNum] !== sock || isPairedCreds(sock.authState.creds)) return;
                        await withTimeout(sock.requestPairingCode(cleanNum, PAIRING_CODE_CUSTOM), 25000, 'انتهت مهلة تجديد كود الربط');
                        console.log(`🔑 تم تجديد تسجيل كود الربط الثابت ${PAIRING_CODE_DISPLAY} لـ ${cleanNum}`);
                    } catch (_) {
                    } finally { pendCode.reqBusy = false; }
                })();
            }
        }

        if (!connection) return;
        console.log(`📡 ${cleanNum}: ${connection}`);

        if (connection === 'close') {
            delete sockets[cleanNum];
            clearWatchdog(cleanNum);

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const nowPaired = isPairedCreds(state.creds);
            const p = pendingPairs.get(cleanNum);

            if (!nowPaired) {
                if (p && !p.paired) {
                    // الربط لسه شغال : مراجع جلسة QR بتنتهي فبيقفل الاتصال — بنعيد الاتصال
                    // عشان نجيب مراجع وأكواد جديدة ونكمل نفس عملية الربط بدل ما نمسح كل حاجة
                    if ((p.rounds || 0) >= MAX_PAIR_ROUNDS) {
                        console.log(`🧹 ربط ${cleanNum} ماكملش بعد ${p.rounds} جولات (code ${statusCode ?? '?'}) - إلغاء ومسح`);
                        const L = LANGS[langOf(p.cid)] || LANGS.ar;
                        await abortPairing(cleanNum, L.pair_failed(cleanNum));
                        return;
                    }
                    p.rounds = (p.rounds || 0) + 1;
                    p.lastQr = null;
                    console.log(`🔄 استمرار الربط ${cleanNum} (جولة ${p.rounds}/${MAX_PAIR_ROUNDS}, code ${statusCode ?? '?'})`);
                    schedulePairResume(cleanNum, 1200);
                    return;
                }
                // مفيش ربط معلق — جلسة غير مكتملة/يتيمة → مسح
                console.log(`🧹 ربط ${cleanNum} ماكملش (code ${statusCode ?? '?'}) - إلغاء ومسح`);
                const L = LANGS[langOf(p?.cid)] || LANGS.ar;
                await abortPairing(cleanNum, p?.codeSent ? L.pair_failed(cleanNum) : `⚠️ الربط ماكملش للرقم +${cleanNum} ، اطلب كود جديد.`);
                return;
            }

            if (FATAL_CODES.includes(statusCode)) {
                console.log(`⚠️ ${cleanNum} جلسة ميتة (code ${statusCode})`);
                const owner = getCidByNumber(cleanNum);
                await fullDisconnect(cleanNum);
                // الجلسة ماتت → نزيل الرقم من اللوحة (المستخدم لازم يربط من جديد)
                if (owner) { try { removeUser(owner); } catch (_) {} }
                const msgTxt = LANGS.ar.session_dead(cleanNum);
                bot.telegram.sendMessage(ADMIN_ID, msgTxt, {}).catch(() => {});
                if (owner && String(owner) !== String(ADMIN_ID)) {
                    bot.telegram.sendMessage(owner, msgTxt, {}).catch(() => {});
                }
                return;
            }

            try { await safeSaveCreds(); } catch (_) {}
            if (stale() || sockets[cleanNum]) return;
            const attempt = (reconnectAttempts.get(cleanNum) || 0) + 1;
            reconnectAttempts.set(cleanNum, attempt);

            if (statusCode === 500 && attempt >= 2) {
                healCorruptedSessionKeys(cleanNum);
            }

            let delay;
            if (statusCode === DisconnectReason.restartRequired) {
                delay = 500;
            } else if (statusCode === 500) {
                delay = Math.min(30000, 3000 * attempt);
            } else if (attempt >= MAX_RECONNECT_ATTEMPTS) {
                delay = 60000;
            } else {
                delay = Math.min(25000, 2000 * attempt);
            }
            console.log(`🔄 إعادة اتصال ${cleanNum} بعد ${delay}ms...`);
            scheduleReconnect(cleanNum, delay);

        } else if (connection === 'open') {
            reconnectAttempts.set(cleanNum, 0);
            console.log(`✅ متصل: ${cleanNum}`);
            startWatchdog(cleanNum);
            onAccountOpen(cleanNum, sock);
            const p = pendingPairs.get(cleanNum);
            if (p) {
                if (!p.paired) markPaired(cleanNum, p);
                if (p.timer) clearTimeout(p.timer);
                pendingPairs.delete(cleanNum);
                const L = LANGS[langOf(p.cid)] || LANGS.ar;
                tgUpdatePairMsg(p, L.linked_ok,
                    Markup.inlineKeyboard([[cbtn(L.btn_back, 'back', 'primary')]]));
            }
        }
    });

    // ─── كود الربط أو تسجيل دخول QR ───
    let pairingCode = null;
    if (!paired) {
        // لو فيه عملية ربط شغالة لنفس الرقم (استكمال بعد قطع اتصال) نحتفظ بحالتها:
        // نفس رسالة تليجرام (msgId) وعدد الجولات والمؤقت
        const modeKey = pairInfo.mode === 'qr' ? 'qr' : 'code';
        const old = pendingPairs.get(cleanNum);
        const pend = (old && old.mode === modeKey) ? old : {
            cid: pairInfo.cid, paired: false, codeSent: false, msgId: null, timer: null,
            mode: modeKey, lastQr: null, rounds: 0
        };
        pend.cid = pairInfo.cid;
        pend.lastQr = null; // اتصال جديد = مراجع جديدة
        pend.reqBusy = false;
        pendingPairs.set(cleanNum, pend);
        if (pend.mode === 'qr') {
            // في وضع QR : صورة الكود بتتحدث تلقائيا في نفس الرسالة من حدث connection.update لما ييجي qr
            pend.codeSent = true;
            if (!pend.timer) pend.timer = setTimeout(() => expirePairing(cleanNum).catch(() => {}), PAIR_TIMEOUT_MS);
            return null;
        }
        // حالة الاستكمال : كود الربط بيتجدد تلقائيا مع كل qr في معالج connection.update
        // (نفس الرسالة بتتحدث بالكود الجديد) — مش محتاجين نطلبه تاني هنا
        if (pend.msgId) {
            if (!pend.timer) pend.timer = setTimeout(() => expirePairing(cleanNum).catch(() => {}), PAIR_TIMEOUT_MS);
            return null;
        }
        // الاصلاح: بدل انتظار 3 ثواني ثابتة ننتظر جاهزية الاتصال الفعلية
        // لان الاتصال على استضافة مثل Railway ممكن ياخد وقت اطول فيفشل طلب الكود
        const ready = await waitForPairingReady(sock, stale, 60000);
        if (!ready) {
            if (!stale()) await fullDisconnect(cleanNum);
            throw new Error('تعذر تجهيز الاتصال بواتساب لطلب كود الربط ، حاول مرة أخرى.');
        }
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (stale()) throw cancelledErr();
            try {
                // كود الربط الثابت WATX-HOU2 — بيتسجل كمفتاح تشفير عند سيرفر واتساب
                await withTimeout(sock.requestPairingCode(cleanNum, PAIRING_CODE_CUSTOM), 30000, 'انتهت مهلة طلب كود الربط');
                pairingCode = PAIRING_CODE_DISPLAY;
                console.log(`🔑 كود الربط الثابت ${pairingCode} لـ ${cleanNum}`);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                console.error(`⚠️ محاولة ${attempt} لطلب كود الربط لـ ${cleanNum} فشلت:`, e?.message || e);
                if (attempt < 2) await sleep(2000);
            }
        }
        if (lastErr) {
            if (!stale()) await fullDisconnect(cleanNum);
            throw new Error('فشل في إنشاء كود الربط، حاول مرة أخرى.');
        }
        if (stale()) throw cancelledErr();
        pend.codeSent = true;
        if (!pend.timer) pend.timer = setTimeout(() => expirePairing(cleanNum).catch(() => {}), PAIR_TIMEOUT_MS);
        // استكمال ربط من غير رسالة محفوظة : ابعت الكود الثابت في رسالة جديدة
        if (pend.resumed) {
            const LP = LANGS[langOf(pend.cid)] || LANGS.ar;
            tgUpdatePairMsg(pend, LP.pair_code(PAIRING_CODE_DISPLAY), pairMsgKb(LP), 'HTML');
        }
    }

    return pairingCode;
}

// ─── مراقبة صحة الاتصال ───
function startWatchdog(cleanNum) {
    clearWatchdog(cleanNum);
    const id = setInterval(async () => {
        const sock = sockets[cleanNum];
        if (!sock) return clearWatchdog(cleanNum);
        const wsState = sock.ws?.readyState ?? (sock.ws?.isClosed ? 3 : 1);
        if (wsState === 2 || wsState === 3) {
            if (sockets[cleanNum] !== sock) return;
            console.log(`♻️ سوكيت ${cleanNum} مقفول، إعادة اتصال هادي`);
            detachSocket(cleanNum);
            try { sock.end(undefined); } catch (_) {}
            scheduleReconnect(cleanNum, 1500);
        }
    }, 60000);
    watchdogs.set(cleanNum, id);
}
function clearWatchdog(cleanNum) {
    const id = watchdogs.get(cleanNum);
    if (id) { clearInterval(id); watchdogs.delete(cleanNum); }
}

function wipeSessionData(cleanNum) {
    const sessionPath = path.join(sessionsDir, cleanNum);
    try { fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    try { fs.rmSync(photosDir(cleanNum), { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    try { fs.rmSync(contactsFile(cleanNum), { force: true }); } catch (_) {}
    [`autoreply:${cleanNum}`, `clock:${cleanNum}`, `autorot:${cleanNum}`, `muted:${cleanNum}`, `online:${cleanNum}`, `updates:${cleanNum}`, `textstyle:${cleanNum}`, `ai:${cleanNum}`, `lidmap:${cleanNum}`, `activechats:${cleanNum}`].forEach(k => {
        try { delSetting(k); } catch (_) {}
    });
    removeUserByNumber(cleanNum);
}

// ─── تنضيف الأرقام العالقة ───
async function reconcileSessions() {
    let sessions = 0, rows = 0;
    for (const n of sessionDirs()) {
        if (pendingPairs.has(n)) continue;
        if (!isPairedCreds(readSessionCreds(n))) { await fullDisconnect(n); sessions++; }
    }
    const live = new Set(listConnectedSessions());
    for (const u of q.allUsers()) {
        if (!live.has(u.number) && !pendingPairs.has(u.number)) { q.deleteUserByCid(u.cid); rows++; }
    }
    return { sessions, rows };
}

// ─── استعادة الجلسات عند التشغيل ───
async function restoreAll() {
    await reconcileSessions();
    for (const f of listConnectedSessions()) {
        try { await startWhatsApp(f); } catch (e) { console.error(`❌ فشل استعادة ${f}:`, e.message); }
        await sleep(5000);
    }
}

// ==========================================
// 💬 ذاكرة كل حساب + معالجة الرسايل
// ==========================================
const acct = {}; // رقم -> ذاكرة الحساب

function getAcct(num) {
    if (!acct[num]) {
        const A = {
            num,
            nameCache: new Map(),
            msgCache: new Map(),      // chat -> مصفوفة رسايل
            storyCache: new Map(),    // رقم صاحب الاستوري -> Map(id -> entry)
            profileCache: new Map(),  // jid -> { name, imgUrl, picPath, ts } لتتبع تغيير الصور والاسامي
            lidMap: new Map(),        // معرفات LID -> ارقام الهاتف الحقيقية
            activeChats: new Set(),   // الشاتات اللي المستخدم بيكلمها فعلا (التحديثات بتشتغل عليها فقط)
            countdowns: new Map(),    // chat -> { timer, key } العد التنازلي (.وقت)
            pending: null,            // عملية انتظار إدخال من المستخدم
            autoreply: '',
            replyQueue: [],           // طابور اعادة محاولة الرد التلقائي الذكي
            ai: false,                // وضع الذكاء الاصطناعي (.تفعيل وضع الذكاء الاصطناعي)
            aiHistory: new Map(),     // chat -> سياق محادثة قصير للذكاء الاصطناعي
            muted: new Map(),         // groupJid -> Set(ارقام)
            contacts: new Set(),
            clock: null,
            rot: null,
            online: null,             // مؤقت الاونلاين الدائم
            updates: false,           // اشعارات التحديثات (.التحديثات)
            updatesScan: null,        // مؤقت الفحص الدوري لصور البروفايل
            editSeen: new Map(),      // منع تكرار تقارير التعديل
            lastAuto: new Map(),      // كولداون الرد التلقائي لكل محادثه
            _ctimer: null,
            _lidTimer: null
        };
        try { A.autoreply = String(getSetting(`autoreply:${num}`, '') || ''); } catch (_) {}
        try { A.updates = getSetting(`updates:${num}`) === '1'; } catch (_) {}
        try { A.ai = getSetting(`ai:${num}`) === '1'; } catch (_) {}
        try { A.lidMap = new Map(JSON.parse(getSetting(`lidmap:${num}`, '[]') || '[]')); } catch (_) { A.lidMap = new Map(); }
        try { A.activeChats = new Set(JSON.parse(getSetting(`activechats:${num}`, '[]') || '[]')); } catch (_) { A.activeChats = new Set(); }
        try {
            const m = JSON.parse(getSetting(`muted:${num}`, '{}') || '{}');
            for (const [g, arr] of Object.entries(m || {})) A.muted.set(g, new Set(arr || []));
        } catch (_) {}
        try { for (const j of loadContacts(num)) A.contacts.add(j); } catch (_) {}
        acct[num] = A;
    }
    return acct[num];
}

function saveMuted(num, A) {
    const obj = {};
    for (const [g, set] of A.muted) obj[g] = [...set];
    setSetting(`muted:${num}`, JSON.stringify(obj));
}
function saveAutoreply(num, A) { setSetting(`autoreply:${num}`, A.autoreply || ''); }

function addContact(num, A, jid) {
    if (!jid) return;
    if (jid === selfJidOf(num)) return;
    // بنقبل الرقم الحقيقي والمعرف الداخلي (LID) — الشاتات بتوصل بالشكلين
    if (!jid.endsWith('@s.whatsapp.net') && !isLidJid(jid)) return;
    if (A.contacts.has(jid)) return;
    A.contacts.add(jid);
    clearTimeout(A._ctimer);
    A._ctimer = setTimeout(() => writeContacts(num, [...A.contacts]), 2000);
}

function selfNumber(num) { return num; }
function selfJidOf(num) { return `${num}@s.whatsapp.net`; }

function cacheMessage(A, chat, entry) {
    let arr = A.msgCache.get(chat);
    if (!arr) { arr = []; A.msgCache.set(chat, arr); }
    arr.push(entry);
    if (arr.length > 800) arr.splice(0, arr.length - 800);
    A.msgCache.set(chat, arr);
}
function findCached(A, chat, msgId) {
    const arr = A.msgCache.get(chat);
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].key?.id === msgId) return arr[i];
    }
    return null;
}

// ─── عند فتح الاتصال: استعادة الساعة والنص والاونلاين والتحديثات وتغيير الصور ───
function onAccountOpen(num, sock) {
    const A = getAcct(num);
    sock.__textStyle = parseInt(getSetting(`textstyle:${num}`) || '0') || 0;
    const clockVal = getSetting(`clock:${num}`);
    if (clockVal !== null && clockVal !== undefined && !A.clock) {
        // الصيغة الجديدة JSON { orig, style } — والقديمة كانت اسم خام فقط
        let orig = String(clockVal), style = 1;
        try {
            const j = JSON.parse(clockVal);
            if (j && typeof j === 'object') { orig = String(j.orig || ''); style = parseInt(j.style) || 1; }
        } catch (_) {}
        startClock(num, sock, orig, style);
    }
    const rotSec = getSetting(`autorot:${num}`);
    if (rotSec && fs.existsSync(photosDir(num)) && !A.rot) {
        startRotation(num, sock, parseInt(rotSec) || 10);
    }
    if (getSetting(`online:${num}`) && !A.online) startOnline(num, sock);
    if (A.updates && !A.updatesScan) startUpdatesScan(num, sock);
}

// ─── الساعة بجانب اسم الحساب مع 4 زخارف ارقام (بدون اي ايموجي نهائيا) ───
// زخارف ارقام الوقت — كل رقم له شكل مختلف
const CLOCK_STYLES = {
    1: '٠١٢٣٤٥٦٧٨٩',      // ارقام عربية
    2: '𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵', // ارقام عريضة
    3: '𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡',  // ارقام مفرغة
    4: '０１２３４５６７８９'      // ارقام عريضة كاملة
};
function decorateClock(str, style) {
    const map = CLOCK_STYLES[style];
    if (!map) return str;
    // Array.from بيفصل بالمحرف الكامل (codepoint) — الفهرسة المباشرة على النص بتكسر الزخارف غير BMP
    const chars = Array.from(map);
    return String(str).replace(/[0-9]/g, (d) => chars[Number(d)] || d);
}
function clockString(style) { return decorateClock(gizaTime(), style); }
// شيل اي ساعة او ايموجي قديم من الاسم — علاج مشكلة التراكم (⏰ 04:00 م ⏰ 05:01 م)
function stripClockFromName(name) {
    let n = String(name || '');
    n = n.replace(/[\u231A\u23F0\u23F1\u{1F550}-\u{1F567}]/gu, '');
    n = n.replace(/\s*[0-9\u0660-\u0669]{1,2}:[0-9\u0660-\u0669]{2}\s*(ص|م|AM|PM|am|pm)?\s*/gu, ' ');
    return n.replace(/\s{2,}/g, ' ').trim();
}
function startClock(num, sock, origName, style = 1) {
    const A = getAcct(num);
    stopClock(num, false);
    style = CLOCK_STYLES[style] ? style : 1;
    const clean = stripClockFromName(origName || (sock && sock.user && sock.user.name) || '');
    A.clock = { orig: clean, style };
    setSetting(`clock:${num}`, JSON.stringify({ orig: clean, style }));
    const tick = async () => {
        const s = sockets[num];
        if (!s || !A.clock) return;
        // نكتب دايما من الاسم الاصلي المحفوظ وليس من الاسم الحالي — فمفيش تراكم ساعة ابدا
        const name = A.clock.orig ? `${A.clock.orig} ${clockString(A.clock.style)}` : clockString(A.clock.style);
        try { await s.updateProfileName(name); } catch (_) {}
    };
    A.clock.timer = setInterval(tick, 60000);
    tick().catch(() => {});
}
function stopClock(num, restore = true) {
    const A = getAcct(num);
    if (!A.clock) return;
    clearInterval(A.clock.timer);
    const orig = A.clock.orig;
    A.clock = null;
    delSetting(`clock:${num}`);
    if (restore && orig) {
        const sock = sockets[num];
        if (sock) sock.updateProfileName(orig).catch(() => {});
    }
}

// ─── تغيير صورة البروفايل ───
async function setProfilePictureSafe(sock, jid, buffer, tmpPath) {
    try { await sock.updateProfilePicture(jid, buffer); return true; } catch (_) {}
    try {
        fs.writeFileSync(tmpPath, buffer);
        await sock.updateProfilePicture(jid, { url: tmpPath });
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        return true;
    } catch (_) {}
    return false;
}

function startRotation(num, sock, sec) {
    const A = getAcct(num);
    stopRotation(num, false);
    setSetting(`autorot:${num}`, sec);
    const dir = photosDir(num);
    const timer = setInterval(async () => {
        if (!sockets[num]) return;
        try {
            const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
            if (!files.length) return;
            const f = files[Math.floor(Math.random() * files.length)];
            const buf = fs.readFileSync(path.join(dir, f));
            await setProfilePictureSafe(sock, selfJidOf(num), buf, path.join(dataDir, `tmp_${num}.jpg`));
        } catch (_) {}
    }, Math.max(2, sec) * 1000);
    A.rot = { timer, dir };
}
function stopRotation(num, delSettingKey = true) {
    const A = getAcct(num);
    if (A.rot) { clearInterval(A.rot.timer); A.rot = null; }
    if (delSettingKey) { try { delSetting(`autorot:${num}`); } catch (_) {} }
}

// ─── التقاط الحذف : نص + ميديا (صوره/فيديو/ستيكر/صوتي/ملف/عرض مره واحده) ───
// كل اشعارات الحذف تروح للحافظة (رقمك الشخصي) وليس في نفس المحادثة
async function reportDeleted(num, sock, key) {
    if (!key || key.fromMe) return;
    const chat = key.remoteJid;
    if (!chat || chat === 'status@broadcast') return;
    const vault = selfJidOf(num);
    if (chat === vault) return; // مفيش تقارير من شات الحافظة نفسه
    const A = getAcct(num);
    const orig = findCached(A, chat, key.id);
    // جيد رقم المرسل الحقيقي (فك LID من participantAlt لو متاح)
    let senderJid = key.participant || chat;
    if (isLidJid(senderJid) && key.participantAlt && key.participantAlt.endsWith('@s.whatsapp.net')) {
        senderJid = key.participantAlt;
    }
    const senderNum = resolveNumber(A, senderJid) || numFromJid(senderJid);
    const senderName = (orig && orig.senderName) || A.nameCache.get(senderNum) || '';
    const now = fmtDate(Math.floor(Date.now() / 1000));
    const head = `تم حذف رساله\n\n` +
        `المحادثة : ${displayChat(chat, A)}\n` +
        `اسم المستخدم : ${senderName || '(غير معروف)'}\n` +
        `رقم الهاتف : ${displayNum(A, senderJid)}\n`;
    let sent = false;
    // محاولة ارسال محتوى الرسالة المحذوفة (ميديا + نص) للحافظة
    if (orig && orig.inner) {
        try {
            const dl = await downloadMedia(orig.inner);
            if (dl) {
                const cap = styleText(sock, `${head}\nتاريخ الارسال : ${fmtDate(orig.ts)}\nتاريخ الحذف : ${now}` +
                    (orig.text ? `\nالنص : ${orig.text}` : ''));
                if (dl.kind === 'image') await sock.sendMessage(vault, { image: dl.buffer, caption: cap });
                else if (dl.kind === 'video') await sock.sendMessage(vault, { video: dl.buffer, caption: cap });
                else if (dl.kind === 'sticker') {
                    await sock.sendMessage(vault, { sticker: dl.buffer });
                    await sock.sendMessage(vault, { text: cap });
                } else if (dl.kind === 'audio') {
                    await sock.sendMessage(vault, { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
                    await sock.sendMessage(vault, { text: cap });
                } else {
                    await sock.sendMessage(vault, { document: dl.buffer, mimetype: dl.mimetype || 'application/octet-stream', fileName: dl.fileName || 'file' });
                    await sock.sendMessage(vault, { text: cap });
                }
                sent = true;
            }
        } catch (_) {}
    }
    if (!sent) {
        const origText = orig ? (orig.text || (orig.media ? `(${orig.media})` : '(غير متوفرة)')) : '(غير محفوظة في الذاكرة)';
        const tsLine = orig ? `تاريخ الارسال : ${fmtDate(orig.ts)}\n` : '';
        const viewLine = (orig && orig.viewOnce) ? `نوع الرساله : عرض مره واحده\n` : '';
        await sock.sendMessage(vault, { text: styleText(sock, `${head}${viewLine}\nالرساله : ${origText}\n${tsLine}تاريخ الحذف : ${now}`) }).catch(() => {});
    }
    // شيل الرسالة من الكاش
    const arr = A.msgCache.get(chat);
    if (arr) {
        const idx = arr.findIndex(e => e.key?.id === key.id);
        if (idx >= 0) arr.splice(idx, 1);
    }
}

// ─── التقاط التعديل : قبل/بعد + تاريخ الارسال والتعديل + معلومات الشخص ───
// كل اشعارات التعديل تروح للحافظة (رقمك الشخصي) وليس في نفس المحادثة
async function reportEdited(num, sock, key, newMsg, editTs) {
    if (!key || key.fromMe) return;
    const chat = key.remoteJid;
    if (!chat || chat === 'status@broadcast') return;
    const vault = selfJidOf(num);
    if (chat === vault) return;
    const A = getAcct(num);
    const orig = findCached(A, chat, key.id);
    // جيد رقم المرسل الحقيقي (فك LID من participantAlt لو متاح)
    let senderJid = key.participant || chat;
    if (isLidJid(senderJid) && key.participantAlt && key.participantAlt.endsWith('@s.whatsapp.net')) {
        senderJid = key.participantAlt;
    }
    const senderNum = resolveNumber(A, senderJid) || numFromJid(senderJid);
    const senderName = (orig && orig.senderName) || A.nameCache.get(senderNum) || '';
    const nowSec = Number(editTs) || Math.floor(Date.now() / 1000);
    const inner = unwrapMessage(newMsg).msg || newMsg || {};
    const newText = extractText(inner) || (mediaKind(inner) ? `(${mediaKind(inner)})` : '(غير متوفرة)');
    const head = `تم تعديل رساله\n\n` +
        `المحادثة : ${displayChat(chat, A)}\n` +
        `اسم المستخدم : ${senderName || '(غير معروف)'}\n` +
        `رقم الهاتف : ${displayNum(A, senderJid)}\n`;
    // الرسالة بعد التعديل : لو فيها ميديا نحملها ونرسلها كمان للحافظة
    let afterExtra = '';
    try {
        const dl = await downloadMedia(inner);
        if (dl) {
            if (dl.kind === 'image') await sock.sendMessage(vault, { image: dl.buffer, caption: styleText(sock, 'الرساله بعد التعديل') });
            else if (dl.kind === 'video') await sock.sendMessage(vault, { video: dl.buffer, caption: styleText(sock, 'الرساله بعد التعديل') });
            else if (dl.kind === 'sticker') await sock.sendMessage(vault, { sticker: dl.buffer });
            else if (dl.kind === 'audio') await sock.sendMessage(vault, { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
            else await sock.sendMessage(vault, { document: dl.buffer, mimetype: dl.mimetype || 'application/octet-stream', fileName: dl.fileName || 'file' });
            afterExtra = ' (مع الميديا المرسله للحافظة بعد التعديل)';
        }
    } catch (_) {}
    let text;
    if (orig) {
        text = `${head}\n` +
            `الرساله بعد التعديل${afterExtra} : ${newText}\n` +
            `تاريخ التعديل : ${fmtDate(nowSec)}\n\n` +
            `الرساله قبل التعديل : ${orig.text || (orig.media ? `(${orig.media})` : '(غير متوفرة)')}\n` +
            `تاريخ الارسال : ${fmtDate(orig.ts)}`;
        // حدث الكاش بالمحتوى الجديد
        orig.text = newText;
        orig.inner = inner;
    } else {
        text = `${head}\n` +
            `الرساله بعد التعديل${afterExtra} : ${newText}\n` +
            `تاريخ التعديل : ${fmtDate(nowSec)}\n\n` +
            `الرساله قبل التعديل : (غير محفوظة في الذاكرة)`;
    }
    try { await sock.sendMessage(vault, { text: styleText(sock, text) }); } catch (_) {}
}

// ─── منع تكرار تقارير التعديل (التعديل بيصل من مسارين) ───
function isDupEdit(A, id) {
    if (!id) return false;
    const now = Date.now();
    const last = A.editSeen.get(id) || 0;
    A.editSeen.set(id, now);
    if (A.editSeen.size > 500) {
        for (const [k, t] of A.editSeen) if (now - t > 300000) A.editSeen.delete(k);
    }
    return (now - last) < 60000;
}

// ─── محتوى الرسالة بعد التعديل ───
// بايليز بيرسل editedMessage باشكال مختلفة حسب الاصدار:
// شكل 1 : { editedMessage: { message: { conversation: '...' } } }
// شكل 2 : { editedMessage: { conversation: '...' } } (بدون message)
// وده كان سبب ان التقاط التعديل مش شغال — الدالة دي بتغطي الشكلين
function editedContentOf(rawEdited) {
    if (!rawEdited || typeof rawEdited !== 'object') return null;
    let m = (rawEdited.message && typeof rawEdited.message === 'object' && Object.keys(rawEdited.message).length)
        ? rawEdited.message : rawEdited;
    let guard = 0;
    while (m && guard++ < 3 && ((m.editedMessage && typeof m.editedMessage === 'object') ||
        (m.protocolMessage && m.protocolMessage.editedMessage && typeof m.protocolMessage.editedMessage === 'object'))) {
        const inner = m.editedMessage || m.protocolMessage.editedMessage;
        m = (inner.message && typeof inner.message === 'object' && Object.keys(inner.message).length) ? inner.message : inner;
    }
    if (!m || typeof m !== 'object') return null;
    if (m.protocolMessage || m.reactionMessage || m.pollUpdateMessage) return null;
    if (!Object.keys(m).length) return null;
    return m;
}

// ─── messages.update : حذف + تعديل ───
const PM_TYPE = (proto && proto.Message && proto.Message.ProtocolMessage && proto.Message.ProtocolMessage.Type) || {};
const PROTO_REVOKE = (PM_TYPE.REVOKE ?? 0);
const PROTO_EDIT = (PM_TYPE.MESSAGE_EDIT ?? 14);

async function onUpdate(num, sock, updates) {
    for (const item of updates || []) {
        const u = item.update || {};
        const key = item.key || u.key;
        if (!key || !key.remoteJid) continue;
        const A = getAcct(num);
        // تعلم خريطة LID وتطبيع الشات لرقم حقيقي لو متاح (baileys 7 : remoteJidAlt)
        learnLidMapping(A, key);
        let chat = key.remoteJid;
        if (isLidJid(chat) && key.remoteJidAlt && key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
            chat = key.remoteJidAlt;
            key.remoteJid = chat;
        }
        if (chat === 'status@broadcast') continue;

        const protoMsg = u.message?.protocolMessage || u.message?.ephemeralMessage?.message?.protocolMessage;

        // حذف
        const isRevoke = u.messageStubType === 1 ||
                         u.messageStubType === 'REVOKE' ||
                         (protoMsg && (protoMsg.type === PROTO_REVOKE || protoMsg.type === 'REVOKE'));
        if (isRevoke) {
            const delKey = (protoMsg?.key && protoMsg.key.remoteJid) ? protoMsg.key : key;
            await reportDeleted(num, sock, delKey).catch(() => {});
            continue;
        }

        // تعديل — نغطي كل الاشكال الممكنة (سبب فشل التقاط التعديل القديم)
        let newMsg = editedContentOf(u.message?.editedMessage);
        if (!newMsg && protoMsg && protoMsg.type === PROTO_EDIT) {
            newMsg = editedContentOf(protoMsg.editedMessage);
        }
        if (!newMsg) continue;
        const editTs = Number(u.messageTimestamp) || Math.floor(Date.now() / 1000);
        if (isDupEdit(getAcct(num), key.id)) continue;
        await reportEdited(num, sock, key, newMsg, editTs).catch(() => {});
    }
}

// ─── messages.upsert : الكاش + الكتم + الرد التلقائي + الأوامر ───
// offline = رسالة وصلت متأخرة بعد اعادة الاتصال (نوع append) — نكاشرها ونستخدمها لكن بدون تنفيذ اوامر
async function onUpsert(num, sock, msg, offline = false) {
    if (!msg || !msg.key) return;
    const A = getAcct(num);

    // تعلم خريطة LID ← الرقم الحقيقي وتطبيع الشات لرقم تليفون حقيقي لو متاح (baileys 7)
    learnLidMapping(A, msg.key);
    let chat = msg.key.remoteJid;
    if (!chat) return;
    if (isLidJid(chat) && msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        chat = msg.key.remoteJidAlt;
        msg.key.remoteJid = chat;
    }
    const fromMe = !!msg.key.fromMe;
    // هل الشات خاص؟ (رقم حقيقي او معرف داخلي LID بعد التطبيع)
    const chatIsPrivate = chat.endsWith('@s.whatsapp.net') || isLidJid(chat);

    // الاستوري (status@broadcast)
    if (chat === 'status@broadcast') {
        // حذف استوري : بيصل كـ REVOKE — نصطاده للحافظة (التحديثات)
        const upProto = msg.message && msg.message.protocolMessage;
        const isStoryRevoke = msg.messageStubType === 1 || msg.messageStubType === 'REVOKE' ||
            (upProto && (upProto.type === PROTO_REVOKE || upProto.type === 'REVOKE'));
        if (isStoryRevoke) {
            const delKey = (upProto && upProto.key && upProto.key.id)
                ? { ...upProto.key, remoteJid: chat } : msg.key;
            await reportStoryDeleted(num, sock, delKey).catch(() => {});
            return;
        }
        if (msg.message && msg.key.participant) cacheStory(num, sock, msg);
        return;
    }
    if (chat.endsWith('@newsletter')) return;

    const upProto0 = msg.message && msg.message.protocolMessage;
    const isRevokeStub = msg.messageStubType === 1 || msg.messageStubType === 'REVOKE' ||
        (upProto0 && (upProto0.type === PROTO_REVOKE || upProto0.type === 'REVOKE'));
    if (isRevokeStub) {
        const delKey = (upProto0 && upProto0.key && upProto0.key.id)
            ? { ...upProto0.key, remoteJid: chat } : msg.key;
        await reportDeleted(num, sock, delKey).catch(() => {});
        return;
    }
    if (!msg.message) return;

    // التقاط التعديل عبر upsert — نصطاده من المسارين (protocolMessage مباشر + editedMessage مغلف)
    const upProto = msg.message.protocolMessage;
    if (upProto && (upProto.type === PROTO_EDIT || upProto.type === 'MESSAGE_EDIT')) {
        const newContent = editedContentOf(upProto.editedMessage);
        if (newContent) {
            const ekey = (upProto.key && upProto.key.id) ? { ...upProto.key, remoteJid: chat } : msg.key;
            const editTs = Math.floor(Number(upProto.timestampMs || 0) / 1000) || Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
            if (!isDupEdit(A, ekey.id)) {
                await reportEdited(num, sock, ekey, newContent, editTs).catch(() => {});
            }
        }
        return;
    }
    const upWrap = unwrapMessage(msg.message);
    if (upWrap.edited) {
        const newContent = editedContentOf(msg.message.editedMessage);
        if (newContent) {
            const editTs = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
            if (!isDupEdit(A, msg.key.id)) {
                await reportEdited(num, sock, msg.key, newContent, editTs).catch(() => {});
            }
        }
        return;
    }

    // جيد المرسل الحقيقي (فك LID من participantAlt لو متاح)
    let senderJid = msg.key.participant || chat;
    if (isLidJid(senderJid) && msg.key.participantAlt && msg.key.participantAlt.endsWith('@s.whatsapp.net')) {
        senderJid = msg.key.participantAlt;
    }
    const senderNum = fromMe ? num : (resolveNumber(A, senderJid) || numFromJid(senderJid));
    const senderName = msg.pushName || A.nameCache.get(senderNum) || '';
    if (senderName) A.nameCache.set(senderNum, senderName);

    const inner = unwrapMessage(msg.message).msg || {};
    const mKind = mediaKind(inner);
    const text = extractText(inner);
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

    // كاش الرسايل (للحذف/التعديل وأوامر الحذف) — نخزن المحتوى الكامل عشان الميديا المحذوفة
    cacheMessage(A, chat, {
        key: msg.key,
        chat,
        senderNum,
        senderName,
        fromMe,
        text,
        media: mKind,
        inner,
        viewOnce: unwrapMessage(msg.message).viewOnce || !!inner.imageMessage?.viewOnce || !!inner.videoMessage?.viewOnce,
        ts
    });

    // قائمة المحادثات للنشر
    addContact(num, A, chat);

    // التحديثات بتتتبع فقط للحسابات اللي المستخدم بيكلمها فعلا (رسائل صادرة في الشات)
    if (chatIsPrivate) {
        if (fromMe) markActiveChat(A, chat);
        if (isActiveChat(A, chat)) trackContact(num, chatKey(chat, A), senderName);
    }

    // كتم: حذف رسايل المكتومين في المجموعات
    if (!fromMe && chat.endsWith('@g.us')) {
        const set = A.muted.get(chat);
        if (set && set.has(senderNum)) {
            try { await sock.sendMessage(chat, { delete: msg.key }); } catch (_) {}
            return;
        }
    }

    // وضع الذكاء الاصطناعي: يرد مكان صاحب الحساب على رسايل الخاص بلغة المستخدم وسياق المحادثة
    if (!offline && !fromMe && chatIsPrivate && A.ai) {
        const bodyAi = (text || '').trim();
        if (bodyAi && !bodyAi.startsWith('.')) {
            const lastAi = A.lastAuto.get('ai:' + chat) || 0;
            if (Date.now() - lastAi > 3000) {
                A.lastAuto.set('ai:' + chat, Date.now());
                setImmediate(() => {
                    aiReply(num, sock, chat, senderName, bodyAi).catch(e => console.error('❌ الذكاء الاصطناعي:', e?.message || e));
                });
            }
        }
    } else
    // الرد التلقائي: يقرا رسائل المستخدمين في الخاص ويرد عليهم بالرساله المحفوظه
    // مع معالج ذكي : رسائل offline الحديثة بترد كمان + فشل الارسال يتقفل في طابور اعادة محاولة
    if (A.autoreply && !fromMe && chatIsPrivate) {
        const recent = (Date.now() / 1000 - ts) < 120;
        if (!offline || recent) {
            const last = A.lastAuto.get(chat) || 0;
            if (Date.now() - last > 5000) {
                A.lastAuto.set(chat, Date.now());
                const s = sockets[num];
                if (s) {
                    console.log(`🤖 رد تلقائي من ${num} إلى ${senderNum}`);
                    s.sendMessage(chat, { text: styleText(s, A.autoreply) }).catch(() => {
                        // فشل الارسال — المعالج الذكي الدوري هيعيد المحاولة تلقائيا
                        A.replyQueue.push({ chat, ts: Date.now(), tries: 0 });
                    });
                }
            }
        }
    }

    // رسائل offline مفيهاش اوامر — كاش واشعارات فقط
    if (offline) return;

    // الأوامر من صاحب الحساب فقط — الميديا بدون نص تمر كمان (صوره/صوتي عشان عمليات الانتظار)
    if (!fromMe) return;
    const body = (text || '').trim();
    const hasMedia = !!(inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.stickerMessage || inner.documentMessage);
    if (!body && !hasMedia) return;
    await handleOwnerInput(num, sock, msg, chat, body, inner, A).catch(err => {
        console.error(`❌ خطأ أمر ${num}:`, err?.message || err);
    });
}

// ─── كاش الاستوري ───
function cacheStory(num, sock, msg) {
    const A = getAcct(num);
    const participant = numFromJid(msg.key.participant);
    if (!participant) return;
    let store = A.storyCache.get(participant);
    if (!store) { store = new Map(); A.storyCache.set(participant, store); }
    const inner = unwrapMessage(msg.message).msg || {};
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
    store.set(msg.key.id, { msg, ts });
    // تنظيف القديم (24 ساعة) والزيادة عن 50
    const now = Math.floor(Date.now() / 1000);
    for (const [id, e] of store) {
        if (now - e.ts > 24 * 60 * 60) store.delete(id);
    }
    if (store.size > 50) {
        const sorted = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < sorted.length - 50; i++) store.delete(sorted[i][0]);
    }
    // اشعار نشر استوري جديد للحافظة (امر .التحديثات) — للاشخاص اللي المستخدم بيكلمهم فقط
    if (A.updates && participant !== num) {
        const realPoster = resolveNumber(A, participant) || participant;
        if (isActiveNum(A, realPoster)) {
            trackContact(num, `${realPoster}@s.whatsapp.net`, msg.pushName || '');
            const kind = mediaKind(inner) || 'نص';
            const cap = (extractText(inner) || '').trim();
            const name = A.nameCache.get(realPoster) || msg.pushName || '';
            const txt = `تم نشر استوري جديد\n\n` +
                `اسم المستخدم : ${name || '(غير معروف)'}\n` +
                `رقم الهاتف : ${displayNum(A, participant)}\n` +
                `النوع : ${kind}\n` +
                `وقت النشر : ${fmtDate(ts)}` +
                (cap ? `\nالنص : ${cap.slice(0, 200)}` : '');
            const s = sockets[num];
            if (s) s.sendMessage(selfJidOf(num), { text: styleText(s, txt) }).catch(() => {});
        }
    }
}

// ─── التقاط حذف الاستوري (التحديثات) : الاسم والرقم ووقت النشر والوقت الحذف + ارسال ما حذفه ───
async function reportStoryDeleted(num, sock, delKey) {
    const A = getAcct(num);
    if (!A.updates) return;
    const id = delKey && delKey.id;
    if (!id) return;
    let poster = numFromJid(delKey.participant) || '';
    let entry = null;
    for (const [pnum, store] of A.storyCache) {
        if (store.has(id)) { entry = store.get(id); poster = poster || pnum; store.delete(id); break; }
    }
    if (!entry || !poster || poster === num) return;
    // الاشعارات للحافظة بس للاشخاص اللي المستخدم بيكلمهم فعلا
    const realPoster = resolveNumber(A, poster) || poster;
    if (!isActiveNum(A, realPoster)) return;
    const name = A.nameCache.get(realPoster) || '';
    const inner = unwrapMessage(entry.msg.message).msg || {};
    const cap = (extractText(inner) || '').trim();
    const head = `تم حذف استوري\n\n` +
        `اسم المستخدم : ${name || '(غير معروف)'}\n` +
        `رقم الهاتف : ${displayNum(A, poster)}\n` +
        `وقت النشر : ${fmtDate(entry.ts)}\n` +
        `وقت الحذف : ${fmtDate(Math.floor(Date.now() / 1000))}` +
        (cap ? `\n\nالنص : ${cap}` : '');
    const vault = selfJidOf(num);
    try {
        const dl = await downloadMedia(inner);
        if (dl) {
            const capTxt = styleText(sock, head);
            if (dl.kind === 'image') await sock.sendMessage(vault, { image: dl.buffer, caption: capTxt });
            else if (dl.kind === 'video') await sock.sendMessage(vault, { video: dl.buffer, caption: capTxt });
            else if (dl.kind === 'audio') {
                await sock.sendMessage(vault, { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
                await sock.sendMessage(vault, { text: capTxt });
            } else {
                await sock.sendMessage(vault, { document: dl.buffer, mimetype: dl.mimetype || 'application/octet-stream', fileName: dl.fileName || 'story' });
                await sock.sendMessage(vault, { text: capTxt });
            }
            return;
        }
    } catch (_) {}
    await sock.sendMessage(vault, { text: styleText(sock, head) }).catch(() => {});
}

// ─── تتبع الحسابات لتغير الاسم والصورة (اشعارات التحديثات للحافظة) ───
// التتبع بيشتغل على الشاتات اللي المستخدم بيكلمها فعلا فقط (activeChats)
function trackContact(num, jid, name) {
    if (!jid) return;
    if (!jid.endsWith('@s.whatsapp.net') && !isLidJid(jid)) return;
    const A = getAcct(num);
    if (jid === selfJidOf(num)) return;
    if (!A.profileCache.has(jid)) {
        A.profileCache.set(jid, { name: name || '', imgUrl: '', picPath: '', ts: Date.now() });
        if (A.profileCache.size > 600) {
            const first = A.profileCache.keys().next().value;
            A.profileCache.delete(first);
        }
        return;
    }
    const e = A.profileCache.get(jid);
    if (name && !e.name) e.name = name;
}

function stopUpdatesScan(num) {
    const A = getAcct(num);
    if (A.updatesScan) { clearInterval(A.updatesScan); A.updatesScan = null; }
}
function startUpdatesScan(num, sock) {
    const A = getAcct(num);
    stopUpdatesScan(num);
    setSetting(`updates:${num}`, '1');
    A.updates = true;
    // فحص دوري لصور البروفايلات لكل الحسابات المعروفة كل 10 دقائق
    A.updatesScan = setInterval(() => {
        const s = sockets[num];
        if (!s || !A.updates) { stopUpdatesScan(num); return; }
        scanProfilePics(num, s).catch(() => {});
    }, 10 * 60 * 1000);
    // فحص اول فور التفعيل — بيبنى الاساس بدون اشعارات ثم بيرصد اي تغيير بعده
    scanProfilePics(num, sock).catch(() => {});
}
async function scanProfilePics(num, sock) {
    const A = getAcct(num);
    const jids = [...A.profileCache.keys()].slice(-300);
    for (const jid of jids) {
        if (!A.updates || sockets[num] !== sock) return;
        let url = '';
        try { url = await sock.profilePictureUrl(jid, 'image'); } catch (_) {}
        await handleProfileChange(num, sock, jid, { imgUrl: url || '' });
        await sleep(300);
    }
}

// مقارنة الحالة القديمة بالجديدة وارسال الاشعار للحافظة عند التغيير
async function handleProfileChange(num, sock, jid, cur) {
    const A = getAcct(num);
    const prev = A.profileCache.get(jid);
    if (!prev) {
        A.profileCache.set(jid, { name: cur.name || '', imgUrl: cur.imgUrl || '', picPath: '', ts: Date.now() });
        return;
    }
    const targetNum = resolveNumber(A, jid) || numFromJid(jid);
    // الاشعارات فقط للحسابات اللي المستخدم بيكلمها فعلا (التحديثات مش على كل جهات الاتصال)
    if (!isActiveNum(A, targetNum)) return;
    const name = prev.name || '(غير معروف)';
    const vault = selfJidOf(num);
    // تغيير الاسم
    if (cur.name && prev.name && cur.name !== prev.name && A.updates) {
        await sock.sendMessage(vault, { text: styleText(sock,
            `تم تغيير اسم الحساب\n\n` +
            `الاسم القديم : ${prev.name}\n` +
            `الاسم الجديد : ${cur.name}\n` +
            `رقم الهاتف : ${displayNum(A, jid)}\n` +
            `الوقت : ${fmtDate(Math.floor(Date.now() / 1000))}`) }).catch(() => {});
        prev.name = cur.name;
    } else if (cur.name && !prev.name) {
        prev.name = cur.name;
    }
    // تغيير او حذف صورة البروفايل
    if (cur.imgUrl !== undefined && (cur.imgUrl || '') !== (prev.imgUrl || '')) {
        const had = !!(prev.imgUrl || prev.picPath);
        if (cur.imgUrl) {
            // حفظ الصورة الجديدة كمرجع للحافظة
            let buf = null;
            try { buf = await httpsGetBuffer(cur.imgUrl); } catch (_) {}
            if (buf) {
                const dir = path.join(photosDir(num), 'profiles');
                const fp = path.join(dir, `${targetNum}_${Date.now()}.jpg`);
                try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, buf); prev.picPath = fp; } catch (_) {}
            }
            if (had && A.updates) {
                const det = styleText(sock,
                    `تم تغيير صورة الحساب\n\n` +
                    `الاسم : ${name}\n` +
                    `رقم الهاتف : ${displayNum(A, jid)}\n` +
                    `الوقت : ${fmtDate(Math.floor(Date.now() / 1000))}`);
                if (buf) await sock.sendMessage(vault, { image: buf, caption: det }).catch(() => {});
                else await sock.sendMessage(vault, { text: det }).catch(() => {});
            }
            prev.imgUrl = cur.imgUrl;
        } else {
            if (had && A.updates) {
                const det = styleText(sock,
                    `تم حذف صورة الحساب\n\n` +
                    `الاسم : ${name}\n` +
                    `رقم الهاتف : ${displayNum(A, jid)}\n` +
                    `وقت الحذف : ${fmtDate(Math.floor(Date.now() / 1000))}`);
                let sentOld = false;
                if (prev.picPath && fs.existsSync(prev.picPath)) {
                    try {
                        await sock.sendMessage(vault, { image: fs.readFileSync(prev.picPath), caption: det });
                        sentOld = true;
                    } catch (_) {}
                }
                if (!sentOld) await sock.sendMessage(vault, { text: det }).catch(() => {});
            }
            prev.imgUrl = '';
            prev.picPath = '';
        }
        prev.ts = Date.now();
    }
}

// استقبال تغييرات الاتصال من بايليز (الاسامي + الصور المباشرة)
function onContactsChanged(num, sock, contacts) {
    for (const c of contacts || []) {
        const jid = c && c.id;
        if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;
        if (jid === selfJidOf(num)) continue;
        handleProfileChange(num, sock, jid, {
            name: (c.notify || c.name || '') || undefined,
            imgUrl: c.imgUrl !== undefined ? (c.imgUrl || '') : undefined
        }).catch(() => {});
    }
}

// ─── تنسيق النص (امر .نص) : شكل جميع رسايل البوت المرسلة للمستخدمين ───
// استخدام كل اشكال واتساب : عريض / مائل / شطب / داخل إطار
function styleText(sock, text) {
    const s = (sock && sock.__textStyle) || 0;
    const t = String(text ?? '');
    if (!t || !s) return t;
    if (s === 1) return '*' + t.replace(/\*/g, '＊') + '*'; // عريض Bold
    if (s === 2) return '_' + t.replace(/_/g, '＿') + '_'; // مائل منحني Italic
    if (s === 3) return '~' + t.replace(/~/g, '﹏') + '~'; // مشطب Strikethrough
    if (s === 4) return '```' + t.replace(/`/g, 'ˋ') + '```'; // داخل إطار Monospace
    return t;
}

// ─── رد سريع في محادثة واتساب (بيطبق تنسيق .نص تلقائيا) ───
function waReply(sock, chat, text) {
    return sock.sendMessage(chat, { text: styleText(sock, text) }).catch(() => {});
}

// ─── التعامل مع إدخال صاحب الحساب (عمليات الانتظار + توجيه الأوامر) ───
async function handleOwnerInput(num, sock, msg, chat, body, inner, A) {
    const P = A.pending;
    const hasMedia = !!(inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.stickerMessage || inner.documentMessage);

    // أمر الغاء يشغل في أي وقت
    const isCancel = body === 'الغاء العمليه' || body === '.الغاء العمليه' || body === 'الغاء' || body === '.الغاء';

    if (P && P.chat === chat) {
        if (isCancel) {
            A.pending = null;
            if (P.type === 'photointerval') { /* لا نوقف التغيير هنا، الغاء للانتظار فقط */ }
            if (P.type === 'autoreply') { saveAutoreply(num, A); }
            return waReply(sock, chat, 'تم الغاء العملية');
        }
        if (P.type === 'autoreply') {
            // أوامر النقطة تتنفذ عادي ولا تُحفظ كرسالة رد تلقائي
            if (body.startsWith('.')) {
                // نكمل للتوجيه الطبيعي للأوامر تحت
            } else {
                A.autoreply = body;
                saveAutoreply(num, A);
                A.pending = null;
                const s = sockets[num];
                return waReply(sock, chat, styleText(s, 'تم تفعيل الرد التلقائي\nالرد على المستخدمين في الخاص فقط وليس للمجموعات\nلايقافه ارسل (.ايقاف الرد التلقائي)'));
            }
        }
        if (P.type === 'clockpick' && /^[1-4]$/.test(body)) {
            return finishClockPick(num, sock, chat, parseInt(body), A);
        }
        if (P.type === 'textstyle' && /^[0-4]$/.test(body)) {
            return applyTextStyle(num, sock, chat, parseInt(body), A);
        }
        if (P.type === 'weather' && !body.startsWith('.')) {
            return doWeather(num, sock, chat, body, A);
        }
        if (P.type === 'storypick' && /^\d+$/.test(body)) {
            return pickStory(num, sock, chat, parseInt(body), A);
        }
        if (P.type === 'storyuser' && /^\d+$/.test(body)) {
            const idx = parseInt(body);
            if (idx < 1 || idx > P.users.length) return waReply(sock, chat, `اختر رقم من 1 الى ${P.users.length}`);
            return openStoryUser(num, sock, chat, P.users[idx - 1], A);
        }
        if (P.type === 'photocollect' && inner.imageMessage) {
            return collectPhoto(num, sock, chat, inner, A);
        }
        if (P.type === 'photocollect' && hasMedia && !body.startsWith('.')) {
            return waReply(sock, chat, `تأكد انك ارسلت صوره فقط (${P.got}/${P.need} تم استلامها)`);
        }
        if (P.type === 'photointerval' && /^\d+$/.test(body)) {
            return finishPhotoInterval(num, sock, chat, parseInt(body), A);
        }
        if (P.type === 'rec' && (inner.audioMessage || inner.documentMessage)) {
            return collectRec(num, sock, chat, inner, A);
        }
        if (P.type === 'rec' && hasMedia && !body.startsWith('.')) {
            return waReply(sock, chat, 'تأكد انك ارسلت مقطع صوتي فقط');
        }
        // ما ينفعش نلغي توجيه الأوامر لو المستخدم كتب أمر مختلف
        if (!body.startsWith('.')) return; // انتظار يستمر
    } else if (isCancel) {
        if (body.includes('العمليه')) return waReply(sock, chat, 'لا توجد عملية شغالة حاليا');
        return;
    }

    // كل الاوامر لازم تبدأ بنقطة — مفيش امر يشتغل بدون النقطة ابدا
    if (!body.startsWith('.')) return;
    const b = body.slice(1).trim();
    if (!b) return;

    // توجيه الأوامر (الأطول أولا)
    if (b.startsWith('نشر للمجموعات')) return cmdBroadcastGroups(num, sock, chat, b.slice('نشر للمجموعات'.length).trim(), A);
    if (b.startsWith('نشر')) return cmdBroadcast(num, sock, chat, b.slice('نشر'.length).trim(), A);
    if (b.startsWith('ابعت')) return cmdSend(num, sock, chat, b.slice('ابعت'.length).trim());
    if (b === 'معلوماتي') return cmdMyInfo(num, sock, chat);
    if (b === 'رقمي') return waReply(sock, chat, `رقمي : ${fmtPhone(num)}`);
    if (b.startsWith('رد تلقائي')) return cmdAutoReplyOn(num, sock, chat, b.slice('رد تلقائي'.length).trim(), A);
    if (b === 'ايقاف الرد التلقائي') {
        A.autoreply = '';
        saveAutoreply(num, A);
        return waReply(sock, chat, 'تم ايقاف الرد التلقائي وحذف رساله الرد التلقائي');
    }
    if (b === 'حذف رسائلي') return cmdDeleteMine(num, sock, chat, A);
    if (b === 'حذف جميع الرسائل') return cmdDeleteAll(num, sock, chat, A);
    if (b.startsWith('اسم')) return cmdSetName(num, sock, chat, b.slice('اسم'.length).trim());
    if (b === 'تغيير صورتي') return cmdSetMyPhoto(num, sock, msg, chat);
    if (b === 'كتم') return cmdMute(num, sock, msg, chat, A);
    if (b === 'المكتومين') return cmdMutedList(num, sock, chat, A);
    if (b.startsWith('هل قام بحظري')) return cmdCheckBlock(num, sock, msg, chat, b.slice('هل قام بحظري'.length).trim(), A);
    if (b === 'حظر') return cmdBlock(num, sock, msg, chat);
    if (b.startsWith('سحب استوري')) return cmdStory(num, sock, msg, chat, b.slice('سحب استوري'.length).trim(), A);
    if (b === 'استوري') return cmdStoryList(num, sock, msg, chat, A);
    if (b === 'ريك') return cmdRec(num, sock, msg, chat, A);
    if (b === 'اونلاين') return cmdOnlineOn(num, sock, chat, A);
    if (b === 'ايقاف الاونلاين') return cmdOnlineOff(num, sock, chat, A);
    if (b === 'صوره') return cmdViewOnce(num, sock, msg, chat, 'image', A);
    if (b === 'فيد') return cmdViewOnce(num, sock, msg, chat, 'video', A);
    if (b === 'الاوامر') return waReply(sock, chat, commandsText('ar'));
    if (b === 'تفعيل الوقت') return cmdClockOn(num, sock, chat, A);
    if (b === 'الغاء الوقت') return cmdClockOff(num, sock, chat, A);
    if (/^وقت\s+\d+$/.test(b) || /^وقت\s+\d+:\d{1,2}$/.test(b)) {
        const mTime = b.match(/^وقت\s+(\d+)(?::(\d{1,2}))?$/);
        return cmdCountdown(num, sock, chat, mTime[1] + (mTime[2] ? ':' + mTime[2] : ''), A);
    }
    if (b === 'وقف الوقت') return cmdStopCountdown(num, sock, chat, A);
    if (b === 'ايقاف النص') return applyTextStyle(num, sock, chat, 0, A);
    if (b === 'نص' || /^نص\s+/.test(b)) return cmdTextStyle(num, sock, chat, b.replace(/^نص\s*/, '').trim(), A);
    if (b === 'التحديثات') return cmdUpdatesOn(num, sock, chat, A);
    if (b === 'ايقاف التحديثات') return cmdUpdatesOff(num, sock, chat, A);
    if (b === 'تفعيل وضع الذكاء الاصطناعي' || b === 'تفعيل الذكاء الاصطناعي') return cmdAiOn(num, sock, chat, A);
    if (b === 'ايقاف وضع الذكاء الاصطناعي' || b === 'ايقاف الذكاء الاصطناعي') return cmdAiOff(num, sock, chat, A);
    if (b.startsWith('الطقس')) return cmdWeather(num, sock, chat, b.slice('الطقس'.length).trim(), A);
    if (b.startsWith('سعر الدولار')) return cmdUsdPrice(num, sock, chat, b.slice('سعر الدولار'.length).trim());
    if (b.startsWith('حساب')) return cmdCalc(num, sock, chat, b.slice('حساب'.length).trim());
    if (b === 'بروفايل') return cmdProfile(num, sock, msg, chat, '', A);
    if (b.startsWith('بروفايل')) return cmdProfile(num, sock, msg, chat, b.slice('بروفايل'.length).trim(), A);
    if (b.startsWith('تغيير صورة تلقائيا') || b.startsWith('تغيير الصورة تلقائيا')) {
        const arg = b.replace('تغيير الصورة تلقائيا', '').replace('تغيير صورة تلقائيا', '').trim();
        return cmdAutoPhoto(num, sock, chat, arg, A);
    }
    if (b === 'ايقاف تغيير صورة') {
        if (!A.rot) return waReply(sock, chat, 'تغيير الصوره التلقائي غير شغال حاليا');
        stopRotation(num);
        return waReply(sock, chat, 'تم ايقاف تغيير صورة البروفايل');
    }
    if (b === 'حذف مجلد الصور الخاص بي') {
        stopRotation(num);
        try { fs.rmSync(photosDir(num), { recursive: true, force: true }); } catch (_) {}
        return waReply(sock, chat, 'تم حذف مجلد الصور الخاص بي بنجاح');
    }
}

// ==========================================
// 🧰 تنفيذ أوامر الواتساب
// ==========================================

// .ابعت (العدد) (الرساله)
async function cmdSend(num, sock, chat, arg) {
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) return waReply(sock, chat, 'استخدام : .ابعت (العدد) (الرساله)\nمثال : .ابعت 5 مرحبا بالجميع');
    const count = Math.min(100, parseInt(m[1]) || 0);
    const txt = m[2];
    if (count < 1) return waReply(sock, chat, 'استخدام : .ابعت (العدد) (الرساله)');
    for (let i = 0; i < count; i++) {
        try { await sock.sendMessage(chat, { text: txt }); } catch (_) {}
        await sleep(700);
    }
}

// .معلوماتي
async function cmdMyInfo(num, sock, chat) {
    const name = sock.user?.name || '(غير معروف)';
    const bio = await getBio(sock, selfJidOf(num));
    return waReply(sock, chat, `معلوماتك\nرقمي : ${fmtPhone(num)}\nاسمي : ${name}\nالبايو : ${bio || '(لا يوجد)'}`);
}

// .رد تلقائي — يقرا رسائل المستخدمين في الخاص ويرد عليهم تلقائيا
async function cmdAutoReplyOn(num, sock, chat, arg, A) {
    // كتابة الرسالة مباشرة بعد الامر : .رد تلقائي اهلا بكم
    if (arg) {
        A.autoreply = arg;
        saveAutoreply(num, A);
        return waReply(sock, chat, 'تم تفعيل الرد التلقائي\nالبوت هيقرا رسايل المستخدمين في الخاص ويرد عليهم بالرساله دي\nلايقافه ارسل (.ايقاف الرد التلقائي)');
    }
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    A.pending = { type: 'autoreply', chat };
    return waReply(sock, chat, 'ارسل رساله الرد التلقائي لجعل حسابك يرد على جميع محادثات الخاص للمستخدمين بالرساله\nلل الغاء ارسال (الغاء)');
}

// .حذف رسائلي — حذف كل رسائلي في المحادثه + تحقق من الحذف الكامل
async function cmdDeleteMine(num, sock, chat, A) {
    const arr = A.msgCache.get(chat) || [];
    const mine = arr.filter(e => e.fromMe);
    if (!mine.length) return waReply(sock, chat, 'لا توجد رسايل محفوظه للحذف في هذه المحادثه');
    await waReply(sock, chat, `جاري حذف رسائلك (${mine.length} رساله) ...`);
    let ok = 0, fail = 0;
    const failed = [];
    for (const e of mine) {
        let done = false;
        try { await sock.sendMessage(chat, { delete: e.key }); done = true; } catch (_) { await sleep(300); }
        if (done) ok++; else failed.push(e);
        await sleep(300);
    }
    // التحقق النهائي : أي رسالة فشل حذفها نحاول مرة اخيرة
    for (const e of failed) {
        try { await sock.sendMessage(chat, { delete: e.key }); ok++; } catch (_) { fail++; }
        await sleep(250);
    }
    A.msgCache.set(chat, (A.msgCache.get(chat) || []).filter(e => !e.fromMe));
    let txt = `تم حذف ${ok} رساله من رسائلك في هذه المحادثه`;
    if (fail) txt += `\nفشل حذف ${fail} رساله (غالبا رسائل قديمه جدا او محذوفه من قبل)`;
    return waReply(sock, chat, txt);
}

// .حذف جميع الرسائل — رسائلي + رسائل الطرف الآخر في نفس المحادثه مع التحقق
async function cmdDeleteAll(num, sock, chat, A) {
    const arr = A.msgCache.get(chat) || [];
    if (!arr.length) return waReply(sock, chat, 'لا توجد رسايل محفوظه للحذف في هذه المحادثه');
    await waReply(sock, chat, `جاري حذف جميع الرسائل (${arr.length} رساله) من الطرفين ...`);
    const isGroup = chat.endsWith('@g.us');
    let okMine = 0, failMine = 0, okOther = 0, failOther = 0;
    const failedMine = [], failedOther = [];
    for (const e of arr) {
        let done = false;
        try { await sock.sendMessage(chat, { delete: e.key }); done = true; } catch (_) { await sleep(300); }
        if (e.fromMe) { if (done) okMine++; else failedMine.push(e); }
        else { if (done) okOther++; else failedOther.push(e); }
        await sleep(300);
    }
    // التحقق النهائي : أي رسالة فشل حذفها نحاول مرة اخيرة
    for (const e of failedMine) {
        try { await sock.sendMessage(chat, { delete: e.key }); okMine++; } catch (_) { failMine++; }
        await sleep(250);
    }
    for (const e of failedOther) {
        try { await sock.sendMessage(chat, { delete: e.key }); okOther++; } catch (_) { failOther++; }
        await sleep(250);
    }
    A.msgCache.set(chat, []);
    let txt = `نتيجة حذف جميع الرسائل في هذه المحادثه :\n\n` +
        `رسائلك : تم حذف ${okMine}${failMine ? ` | فشل ${failMine}` : ''}\n` +
        `رسائل الطرف الآخر : تم حذف ${okOther}${failOther ? ` | فشل ${failOther}` : ''}`;
    if (!isGroup && failOther) txt += `\n\nملحوظة : رسائل الطرف الآخر في الخاص لا يمكن حذفها للطرفين حسب نظام واتساب — يتم حذف رسائلك فقط`;
    return waReply(sock, chat, txt);
}

// .اسم (الاسم الجديد)
async function cmdSetName(num, sock, chat, arg) {
    if (!arg) return waReply(sock, chat, 'استخدام : .اسم (الاسم الذي يريد المستخدم ان يغيره)\nمثال : .اسم محمود');
    const old = sock.user?.name || '(غير معروف)';
    try {
        await sock.updateProfileName(arg);
        return waReply(sock, chat, `تم تغيير الاسم بنجاح\n\nالاسم قبل التغيير : ${old}\nالاسم الذي تم تغييره : ${arg}`);
    } catch (_) {
        return waReply(sock, chat, 'فشل تغيير الاسم ، حاول مرة أخرى');
    }
}

// .تغيير صورتي (بالرد على صوره)
async function cmdSetMyPhoto(num, sock, msg, chat) {
    const q = getQuoted(msg);
    if (!q) return waReply(sock, chat, 'قم بالرد على الصورة المراد اضافتها كبروفايل ب امر (.تغيير صورتي)');
    const dl = await downloadMedia(q.msg, 'imageMessage') || await downloadMedia(q.msg);
    if (!dl) return waReply(sock, chat, 'تأكد انك قمت بالرد على صوره');
    const ok = await setProfilePictureSafe(sock, selfJidOf(num), dl.buffer, path.join(dataDir, `tmp_${num}.jpg`));
    return waReply(sock, chat, ok ? 'تم تغيير صورة الحساب بنجاح' : 'فشل تغيير صورة الحساب ، حاول مرة أخرى');
}

// .كتم (في المجموعات - بالرد على رسالة المستخدم)
async function cmdMute(num, sock, msg, chat, A) {
    if (!chat.endsWith('@g.us')) return waReply(sock, chat, 'هاذا الامر يعمل فقط في المجموعات');
    let meta;
    try { meta = await sock.groupMetadata(chat); } catch (_) { return waReply(sock, chat, 'خطأ في جلب بيانات المجموعة'); }
    const me = meta.participants.find(p => p.id === selfJidOf(num) || numFromJid(p.id) === num);
    if (!me || (!me.isAdmin && !me.isSuperAdmin)) {
        return waReply(sock, chat, 'يجب ان يكون الحساب ادمن في المجموعة');
    }
    const q = getQuoted(msg);
    if (!q || !q.participant) return waReply(sock, chat, 'قم بالرد على رسالة المستخدم الذي تريد كتمه');
    const targetNum = numFromJid(q.participant);
    if (!targetNum) return waReply(sock, chat, 'قم بالرد على رسالة المستخدم الذي تريد كتمه');
    if (!A.muted.has(chat)) A.muted.set(chat, new Set());
    A.muted.get(chat).add(targetNum);
    saveMuted(num, A);
    // حذف الرسالة المردود عليها لو امكن
    if (q.stanzaId) {
        try {
            await sock.sendMessage(chat, {
                delete: { id: q.stanzaId, remoteJid: chat, fromMe: false, participant: q.participant }
            });
        } catch (_) {}
    }
    return waReply(sock, chat, `تم كتم المستخدم : ${fmtPhone(targetNum)}\nسيتم حذف رسائله في هذه المجموعة تلقائيا`);
}

// .المكتومين
async function cmdMutedList(num, sock, chat, A) {
    if (!chat.endsWith('@g.us')) return waReply(sock, chat, 'هاذا الامر يعمل فقط في المجموعات');
    const set = A.muted.get(chat);
    if (!set || !set.size) return waReply(sock, chat, 'لا يوجد مستخدمين مكتومين في هذه المجموعة');
    const lines = [...set].map((n, i) => {
        const nm = A.nameCache.get(n);
        return `${i + 1} : ${fmtPhone(n)}${nm ? ` (${nm})` : ''}`;
    });
    return waReply(sock, chat, `المكتومين في هذه المجموعة :\n\n${lines.join('\n')}`);
}

// .هل قام بحظري
async function cmdCheckBlock(num, sock, msg, chat, arg, A) {
    let targetJid = null;
    if (arg && /^\d+$/.test(arg.replace(/\+/g, ''))) {
        targetJid = `${arg.replace(/\D/g, '')}@s.whatsapp.net`;
    } else {
        const q = getQuoted(msg);
        if (q && q.participant) targetJid = numFromJid(q.participant) + '@s.whatsapp.net';
        else if (chat.endsWith('@s.whatsapp.net')) targetJid = chat;
    }
    if (!targetJid) return waReply(sock, chat, 'استخدام : .هل قام بحظري (رقم الهاتف)\nاو قم بالرد على رسالة المستخدم');
    const targetNum = numFromJid(targetJid);
    const res = await checkBlocked(sock, targetJid);
    if (res === 'not_on_whatsapp') return waReply(sock, chat, `الرقم ${fmtPhone(targetNum)} غير موجود على واتساب`);
    if (res === 'blocked') return waReply(sock, chat, `لقد قام بحظرك : ${fmtPhone(targetNum)}`);
    return waReply(sock, chat, `لا لم يقم بحظرك : ${fmtPhone(targetNum)}`);
}

// فحص الحظر (فحص متعدد : الصورة + البايو + الحضور)
async function checkBlocked(sock, jid) {
    try {
        const res = await sock.onWhatsApp(numFromJid(jid));
        if (!res || !res[0] || !res[0].exists) return 'not_on_whatsapp';
    } catch (_) {}
    let signals = 0;
    try { await sock.profilePictureUrl(jid, 'image'); signals++; } catch (_) {}
    try {
        const st = await sock.fetchStatus(jid);
        if (st && !Array.isArray(st) && st.status !== undefined) signals++;
        else if (Array.isArray(st) && st.length) signals++;
    } catch (_) {}
    try {
        const got = await new Promise((resolve) => {
            const t = setTimeout(() => { cleanup(); resolve(false); }, 2500);
            const h = (u) => {
                if (numFromJid(u?.jid || '') === numFromJid(jid)) { cleanup(); resolve(true); }
            };
            function cleanup() { clearTimeout(t); try { sock.ev.off('presence.update', h); } catch (_) {} }
            sock.ev.on('presence.update', h);
            sock.presenceSubscribe(jid).catch(() => {});
        });
        if (got) signals++;
    } catch (_) {}
    return signals > 0 ? 'not_blocked' : 'blocked';
}

// .حظر
async function cmdBlock(num, sock, msg, chat) {
    let targetJid = null;
    const q = getQuoted(msg);
    if (chat.endsWith('@g.us')) {
        if (!q || !q.participant) return waReply(sock, chat, 'قم بالرد على رسالة المستخدم لحظره');
        targetJid = numFromJid(q.participant) + '@s.whatsapp.net';
    } else {
        targetJid = chat;
    }
    const targetNum = numFromJid(targetJid);
    try {
        await sock.updateBlockStatus(targetJid, 'block');
        return waReply(sock, chat, `تم حظر المستخدم بنجاح : ${fmtPhone(targetNum)}`);
    } catch (_) {
        return waReply(sock, chat, 'فشل حظر المستخدم ، حاول مرة أخرى');
    }
}

// .استوري : قائمه بجميع الحسابات المحفوظ استوريهاتها (الاسم + الرقم + العدد)
async function cmdStoryList(num, sock, msg, chat, A) {
    const users = [];
    for (const [pnum, store] of A.storyCache) {
        if (store && store.size) {
            let mx = 0;
            for (const e of store.values()) if (e.ts > mx) mx = e.ts;
            users.push({ num: pnum, name: A.nameCache.get(pnum) || '', count: store.size, ts: mx });
        }
    }
    users.sort((a, b) => b.ts - a.ts);
    if (!users.length) {
        return waReply(sock, chat, 'لا توجد استوري محفوظه حاليا\nيتم حفظ جميع الاستوريهات تلقائيا لكل الحسابات فور نشرها والبوت متصل\nجرم ارسل (.استوري) بعد ما حد ينشر استوري');
    }
    const lines = users.map((u, i) =>
        `${i + 1} : ${u.name || '(بدون اسم)'} | ${fmtPhone(u.num)} | ${u.count} استوري`);
    A.pending = { type: 'storyuser', chat, users: users.map(u => u.num) };
    return waReply(sock, chat,
        `قائمه الاستوري المحفوظه (${users.length} حساب)\n\n` +
        `${lines.join('\n')}\n\n` +
        `ارسل رقم الحساب من 1 الى ${users.length} لعرض استوريهاته بالتفصيل\n` +
        `للغاء ارسال (.الغاء)`);
}

// .سحب استوري (الرقم) : عرض استوريهات رقم معين بالتفصيل
async function cmdStory(num, sock, msg, chat, arg, A) {
    let targetNum = null;
    if (arg && /^\d+$/.test(arg.replace(/\+/g, ''))) targetNum = arg.replace(/\D/g, '');
    else {
        const q = getQuoted(msg);
        if (q && q.participant) targetNum = numFromJid(q.participant);
        else if (chat.endsWith('@s.whatsapp.net')) targetNum = numFromJid(chat);
    }
    if (!targetNum) {
        return waReply(sock, chat, 'استخدام : .سحب استوري (رقم هاتف المستخدم)\nمثال : .سحب استوري 20123456789\nاو ارسل (.استوري) لعرض قائمه بجميع الحسابات');
    }
    return openStoryUser(num, sock, chat, targetNum, A);
}

// عرض استوريهات حساب معين بالاحصائيات (نوع + مدة الفيديو + النص) مرقمنه
async function openStoryUser(num, sock, chat, targetNum, A) {
    const store = A.storyCache.get(targetNum);
    if (!store || !store.size) {
        return waReply(sock, chat, `لا توجد استوري محفوظه للرقم ${fmtPhone(targetNum)} حاليا\nملاحظة : يتم حفظ الاستوري بعد ارسالها من صاحب الرقم والبوت متصل`);
    }
    const entries = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts);
    let images = 0, videos = 0, texts = 0;
    const lines = entries.map(([id, e], i) => {
        const inner = unwrapMessage(e.msg.message).msg || {};
        const cap = (extractText(inner) || '').trim();
        if (inner.imageMessage) {
            images++;
            return `${i + 1} : صوره${cap ? ` | نص : ${cap.slice(0, 40)}` : ' | بدون نص'} | حجم ${fmtSize(inner.imageMessage.fileLength)}`;
        }
        if (inner.videoMessage) {
            videos++;
            return `${i + 1} : فيديو | مدة ${inner.videoMessage.seconds || '?'} ثانيه${cap ? ` | نص : ${cap.slice(0, 40)}` : ''} | حجم ${fmtSize(inner.videoMessage.fileLength)}`;
        }
        texts++;
        return `${i + 1} : نص | ${cap.slice(0, 60) || '(فارغ)'}`;
    });
    const total = entries.length;
    A.pending = { type: 'storypick', chat, list: entries.map(x => x[1]), target: targetNum };
    const name = A.nameCache.get(targetNum) || '';
    return waReply(sock, chat,
        `استوري : ${name || '(بدون اسم)'} | ${fmtPhone(targetNum)}\n\n` +
        `عدد الاستوري : ${total}\n` +
        `الصور : ${images}\n` +
        `الفيديوهات : ${videos}\n` +
        `النصوص : ${texts}\n\n` +
        `${lines.join('\n')}\n\n` +
        `ارسل رقم الاستوري من 1 الى ${total} لتحميله وارساله هنا مع الكابشن الذي عليه\n` +
        `للغاء ارسال (.الغاء)`);
}

async function pickStory(num, sock, chat, idx, A) {
    const P = A.pending;
    if (!P || P.type !== 'storypick') return;
    const i = idx - 1;
    if (!P.list || i < 0 || i >= P.list.length) {
        return waReply(sock, chat, `اختر رقم من 1 الى ${P.list.length}`);
    }
    const entry = P.list[i];
    A.pending = null;
    const inner = unwrapMessage(entry.msg.message).msg || {};
    const storyCap = (extractText(inner) || '').trim();
    const name = A.nameCache.get(P.target) || '';
    const caption = `استوري ${name ? name + ' ' : ''}${fmtPhone(P.target)}${storyCap ? `\n\n${storyCap}` : ''}`;
    if (inner.imageMessage || inner.videoMessage) {
        const dl = await downloadMedia(inner);
        if (!dl) return waReply(sock, chat, 'فشل تحميل الاستوري ، حاول مرة أخرى');
        if (dl.kind === 'image') {
            await sock.sendMessage(chat, { image: dl.buffer, caption }).catch(() => {});
        } else {
            await sock.sendMessage(chat, { video: dl.buffer, mimetype: dl.mimetype || 'video/mp4', caption }).catch(() => {});
        }
        return;
    }
    const t = extractText(inner);
    if (t) {
        await sock.sendMessage(chat, { text: caption }).catch(() => {});
        return;
    }
    return waReply(sock, chat, 'فشل تحميل الاستوري');
}

// .ريك : ارسال المقطع الصوتي كرساله صوتيه (ريكورد) لرقمك الشخصي
async function cmdRec(num, sock, msg, chat, A) {
    const q = getQuoted(msg);
    if (q) {
        const qi = unwrapMessage(q.msg).msg || {};
        if (qi.audioMessage || qi.documentMessage) {
            const dl = await downloadMedia(qi, 'audioMessage') || await downloadMedia(qi);
            if (dl) return sendRec(num, sock, chat, dl);
            return waReply(sock, chat, 'تأكد انك ردت على مقطع صوتي');
        }
        return waReply(sock, chat, 'قم بالرد على مقطع صوتي او ارسل المقطع الصوتي بعد الامر');
    }
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    A.pending = { type: 'rec', chat };
    return waReply(sock, chat, 'ارسل الان المقطع الصوتي وسارسله لرقمك الشخصي كرساله صوتيه (ريكورد)\nللغاء ارسال (.الغاء)');
}
async function collectRec(num, sock, chat, inner, A) {
    A.pending = null;
    const dl = await downloadMedia(inner, 'audioMessage') || await downloadMedia(inner);
    if (!dl) return waReply(sock, chat, 'تأكد انك ارسلت مقطع صوتي');
    return sendRec(num, sock, chat, dl);
}
async function sendRec(num, sock, chat, dl) {
    try {
        await sock.sendMessage(selfJidOf(num), { audio: dl.buffer, ptt: true, mimetype: dl.mimetype || 'audio/ogg; codecs=opus' });
        return waReply(sock, chat, 'تم ارسال الريكورد (المقطع الصوتي) لرقمك الشخصي');
    } catch (_) {
        return waReply(sock, chat, 'فشل ارسال الريكورد ، حاول مرة أخرى');
    }
}

// .اونلاين : الحساب يفضل نشط اونلاين بشكل دائم
function startOnline(num, sock) {
    const A = getAcct(num);
    stopOnline(num, false);
    setSetting(`online:${num}`, '1');
    const tick = async () => {
        const s = sockets[num];
        if (!s) return;
        try { await s.sendPresenceUpdate('available'); } catch (_) {}
    };
    A.online = { timer: setInterval(tick, 50000) };
    tick().catch(() => {});
    console.log(`🟢 اونلاين دائم مفعيل لـ ${num}`);
}
function stopOnline(num, sendOff = true) {
    const A = getAcct(num);
    if (A.online) { clearInterval(A.online.timer); A.online = null; }
    delSetting(`online:${num}`);
    if (sendOff) {
        const s = sockets[num];
        if (s) s.sendPresenceUpdate('unavailable').catch(() => {});
    }
}
async function cmdOnlineOn(num, sock, chat, A) {
    if (A.online) return waReply(sock, chat, 'الاونلاين مفعيل بالفعل\nلايقافه ارسل (.ايقاف الاونلاين)');
    startOnline(num, sock);
    return waReply(sock, chat, 'تم تفعيل الاونلاين\nحسابك هيفضل نشط اونلاين بشكل دائم وبيتم تحديث الحضور كل 50 ثانيه\nلايقافه ارسل (.ايقاف الاونلاين)');
}
async function cmdOnlineOff(num, sock, chat, A) {
    if (!A.online) return waReply(sock, chat, 'الاونلاين غير مفعيل حاليا');
    stopOnline(num);
    return waReply(sock, chat, 'تم ايقاف الاونلاين');
}

// ─── .نص : اختيار شكل نص جميع رسايل البوت (كل اشكال واتساب) ───
async function cmdTextStyle(num, sock, chat, arg, A) {
    const pick = String(arg || '').trim();
    if (/^[0-4]$/.test(pick)) return applyTextStyle(num, sock, chat, parseInt(pick), A);
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    A.pending = { type: 'textstyle', chat };
    return waReply(sock, chat,
        `اختر شكل النص لجميع رسايل البوت المرسلة للمستخدمين :\n\n` +
        `نص 0 — النص العادي لا يفعل شئ\n` +
        `نص 1 — نص عريض Bold\n` +
        `نص 2 — نص مائل منحني Italic\n` +
        `نص 3 — نص مشطب Strikethrough\n` +
        `نص 4 — نص داخل إطار Monospace\n\n` +
        `بمجرد الاختيار يتم تعديل شكل جميع رسايل البوت فورا وتبعت لك رسالة عينة بالشكل الجديد\n` +
        `ارسل الرقم من 0 الى 4 او استخدم (.نص 1) مباشرة\n` +
        `ولايقاف التنسيق في اي وقت ارسل (.ايقاف النص)\n` +
        `للغاء ارسال (.الغاء)`);
}

// تطبيق شكل النص على جميع رسايل البوت فورا + رسالة عينة
function applyTextStyle(num, sock, chat, val, A) {
    A.pending = null;
    val = [0, 1, 2, 3, 4].includes(val) ? val : 0;
    setSetting(`textstyle:${num}`, String(val));
    if (sock) sock.__textStyle = val;
    const labels = { 0: 'نص عادي بدون تنسيق', 1: 'نص عريض Bold', 2: 'نص مائل منحني', 3: 'نص مشطب', 4: 'نص داخل إطار' };
    waReply(sock, chat, 'دي رسالة عينة بالشكل الجديد لجميع رسايل البوت');
    return waReply(sock, chat, `تم تحديد شكل النص : ${labels[val]}\nتم تطبيق الشكل فورا على جميع رسايل البوت\nلايقافه ارسل (.ايقاف النص)`);
}

// ─── .التحديثات : اشعارات تغيير الصور والاسامي والاستوري لرقمك الشخصي (الحافظة) ───
async function cmdUpdatesOn(num, sock, chat, A) {
    if (A.updates) return waReply(sock, chat, 'التحديثات مفعلة بالفعل\nلايقافها ارسل (.ايقاف التحديثات)');
    startUpdatesScan(num, sock);
    return waReply(sock, chat,
        `تم تفعيل التحديثات\n\n` +
        `الخدمة دي بتشتغل فقط على الارقام والحسابات اللي بتكلمها فعلا في حسابك (رسايل بتبعتها لهم) — مش على كل جهات الاتصال\n\n` +
        `هيتم ارسال اشعارات لرقمك الشخصي (الحافظة) عند :\n` +
        `1 : اي حساب بتكلمه يغير صورته الشخصية او يحذفها\n` +
        `2 : اي حساب بتكلمه يغير اسم حسابه\n` +
        `3 : اي حساب بتكلمه ينشر استوري جديد\n` +
        `4 : اي حساب بتكلمه يحذف الاستوري الخاص بيه بعد النشر\n\n` +
        `كل اشعار فيه اسم الشخص ورقم هاتفه ووقت النشر ووقت الحذف\n` +
        `وفي الحذف يتم ارسال ما تم حذفه (الصورة او الفيديو او النص او الصوت)\n` +
        `ملاحظة : سجل الحسابات بيتبنى اولا وبعد الفحص الاول بتبدا الاشعارات\n` +
        `لايقافها ارسل (.ايقاف التحديثات)`);
}
async function cmdUpdatesOff(num, sock, chat, A) {
    if (!A.updates) return waReply(sock, chat, 'التحديثات غير مفعلة حاليا');
    A.updates = false;
    stopUpdatesScan(num);
    delSetting(`updates:${num}`);
    return waReply(sock, chat, 'تم ايقاف التحديثات');
}

// ─── .وقت (الدقائق) : عد تنازلي بالتعديل على نفس الرسالة بصيغة دقائق:ثواني ───
// .وقت 1 = دقيقة كاملة بتعد 1:00 → 0:59 → ... → 0:00 ثم تم انتهاء الوقت
// بيدعم كمان .وقت 1:30 (دقيقة ونص) — اي عدد دقائق بدون حد اقصى
async function cmdCountdown(num, sock, chat, arg, A) {
    const m = String(arg || '').trim().match(/^(\d+)(?::(\d{1,2}))?$/);
    if (!m || Number(m[1]) < 1 || (m[2] !== undefined && Number(m[2]) > 59)) {
        return waReply(sock, chat,
            'استخدام : .وقت (عدد الدقائق)\n' +
            'مثال : .وقت 1 يعد دقيقة كاملة بالثواني\n' +
            'ويمكن : .وقت 1:30 يعد دقيقة ونص\n' +
            'العد بيتم بالتعديل على نفس الرسالة وبعدها يكتب تم انتهاء الوقت');
    }
    const total = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
    // لو فيه عد شغال في نفس المحادثة نوقفه ونبدأ جديد
    stopCountdown(num, chat);
    const fmt = (r) => `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
    let sent = null;
    try {
        sent = await sock.sendMessage(chat, { text: styleText(sock, fmt(total)) });
    } catch (_) {
        return waReply(sock, chat, 'فشل بدء العد التنازلي ، حاول مرة أخرى');
    }
    let remain = total;
    const timer = setInterval(async () => {
        try {
            remain--;
            if (remain >= 0) {
                await sock.sendMessage(chat, { text: styleText(sock, fmt(remain)), edit: sent.key });
            } else {
                stopCountdown(num, chat);
                await sock.sendMessage(chat, { text: styleText(sock, 'تم انتهاء الوقت ✅'), edit: sent.key });
            }
        } catch (_) { /* فشل تعديل مؤقت — المحاولة الجاية ممكن تنجح */ }
    }, 1000);
    A.countdowns.set(chat, { timer, key: sent.key });
}

function stopCountdown(num, chat) {
    const A = getAcct(num);
    const c = A.countdowns && A.countdowns.get(chat);
    if (!c) return false;
    clearInterval(c.timer);
    A.countdowns.delete(chat);
    return true;
}
function stopAllCountdowns(num) {
    const A = acct[num];
    if (!A || !A.countdowns) return;
    for (const c of A.countdowns.values()) clearInterval(c.timer);
    A.countdowns.clear();
}

// .وقف الوقت — ايقاف العد التنازلي في هذه المحادثة
async function cmdStopCountdown(num, sock, chat, A) {
    const c = A.countdowns && A.countdowns.get(chat);
    if (!c) return waReply(sock, chat, 'لا يوجد عد تنازلي شغال في هذه المحادثه');
    clearInterval(c.timer);
    A.countdowns.delete(chat);
    try { await sock.sendMessage(chat, { text: styleText(sock, 'تم ايقاف العد التنازلي'), edit: c.key }); } catch (_) {}
    return waReply(sock, chat, 'تم ايقاف العد التنازلي');
}

// ─── المعالج الذكي الدوري : يقرا طوابير الرد التلقائي ويعيد المحاولة تلقائيا ───
// يشتغل كل 4 ثواني على كل الحسابات المربوطة
setInterval(() => {
    for (const num of Object.keys(acct)) {
        const A = acct[num];
        if (!A || !A.autoreply || !A.replyQueue || !A.replyQueue.length) continue;
        const s = sockets[num];
        if (!s) continue;
        const now = Date.now();
        A.replyQueue = A.replyQueue.filter((item) => {
            if (now - item.ts > 10 * 60 * 1000) return false; // قديمة جدا
            const last = A.lastAuto.get(item.chat) || 0;
            if (now - last < 6000) return true; // مستني الكولداون
            if (item.tries >= 3) return false;
            item.tries++;
            A.lastAuto.set(item.chat, now);
            s.sendMessage(item.chat, { text: styleText(s, A.autoreply) }).catch(() => {});
            return false;
        });
    }
}, 4000);

// .صوره / .فيد : التقاط عرض مرة واحدة
async function cmdViewOnce(num, sock, msg, chat, kind, A) {
    const want = kind === 'image' ? 'imageMessage' : 'videoMessage';
    let dl = null;
    let fromNum = null;
    // 1) من الرسالة المردود عليها (فك التغليف كامل : عرض مرة واحدة / ايفيمرال ...)
    const q = getQuoted(msg);
    if (q) {
        fromNum = q.participant ? numFromJid(q.participant) : numFromJid(chat);
        dl = await downloadMedia(q.msg, want) || await downloadMedia(q.msg);
    }
    // 2) احتياط : من الكاش (الكاش بيخزن المحتوى مفكوك لكل الرسايل بما فيها عرض مرة واحدة)
    const cached = q && q.stanzaId ? findCached(A, chat, q.stanzaId) : null;
    if (!dl && cached && cached.inner) {
        fromNum = cached.senderNum || fromNum;
        dl = await downloadMedia(cached.inner, want) || await downloadMedia(cached.inner);
    }
    // 3) احتياط اخر : اخر رسالة عرض مرة واحدة من نفس النوع في المحادثة
    if (!dl) {
        const arr = A.msgCache.get(chat) || [];
        for (let i = arr.length - 1; i >= 0; i--) {
            const e = arr[i];
            if (!e.viewOnce || !e.inner) continue;
            const has = kind === 'image' ? !!e.inner.imageMessage : !!e.inner.videoMessage;
            if (!has) continue;
            dl = await downloadMedia(e.inner, want);
            if (dl) { fromNum = e.senderNum || fromNum; break; }
        }
    }
    if (!dl) {
        return waReply(sock, chat, kind === 'image'
            ? 'قم بالرد على الصورة التي تعرض لمره واحده ب امر (.صوره)\nيجب ان تكون الصورة قد اترسلت في نفس المحادثة والبوت متصل وقتها'
            : 'قم بالرد على الفيديو الذي يعرض لمره واحده ب امر (.فيد)\nيجب ان يكون الفيديو قد اترسل في نفس المحادثة والبوت متصل وقتها');
    }
    if (kind === 'image') {
        await sock.sendMessage(selfJidOf(num), { image: dl.buffer, caption: `تم التقاط الصوره | من : ${displayNum(A, fromNum)}` }).catch(() => {});
        return waReply(sock, chat, 'تم التقاط الصوره وارسالها لرقم هاتفك');
    }
    await sock.sendMessage(selfJidOf(num), { video: dl.buffer, mimetype: dl.mimetype || 'video/mp4', caption: `تم التقاط الفيديو | من : ${displayNum(A, fromNum)}` }).catch(() => {});
    return waReply(sock, chat, 'تم التقاط الفيديو وارساله لرقم هاتفك');
}

// .نشر (الرساله) : لجميع المحادثات وليس المجموعات
async function cmdBroadcast(num, sock, chat, text, A) {
    if (!text) return waReply(sock, chat, 'استخدام : .نشر (الرساله)\nمثال : .نشر مرحبا بالجميع');
    const targets = [...A.contacts].filter(j => j.endsWith('@s.whatsapp.net') && numFromJid(j) !== num);
    if (!targets.length) return waReply(sock, chat, 'لا توجد محادثات محفوظه للنشر\nالمحادثات تتسجل تلقائيا بعد اي رساله جديدة');
    let ok = 0;
    for (const j of targets) {
        try { await sock.sendMessage(j, { text }); ok++; } catch (_) {}
        await sleep(1200);
    }
    return waReply(sock, chat, `تم النشر الى ${ok} محادثه`);
}

// .نشر للمجموعات (الرساله)
async function cmdBroadcastGroups(num, sock, chat, text, A) {
    if (!text) return waReply(sock, chat, 'استخدام : .نشر للمجموعات (الرساله)');
    let groups = [];
    try { groups = await sock.groupFetchAllParticipating(); } catch (_) {}
    const ids = Object.keys(groups || {});
    if (!ids.length) return waReply(sock, chat, 'لا توجد مجموعات');
    let ok = 0;
    for (const id of ids) {
        try { await sock.sendMessage(id, { text }); ok++; } catch (_) {}
        await sleep(1500);
    }
    return waReply(sock, chat, `تم النشر الى ${ok} مجموعه`);
}

// تفعيل الوقت : قائمة زخارف الارقام (الوقت 1 الى الوقت 4)
async function cmdClockOn(num, sock, chat, A) {
    if (A.clock) return waReply(sock, chat, 'الوقت مفعيل بالفعل\nلايقافه ارسل (.الغاء الوقت)');
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    const now = gizaTime();
    A.pending = { type: 'clockpick', chat };
    return waReply(sock, chat,
        `اختر نوع زخرفة الوقت للساعة بجانب اسم حسابك :\n\n` +
        `الوقت 1 — ${decorateClock(now, 1)}\n\n` +
        `الوقت 2 — ${decorateClock(now, 2)}\n\n` +
        `الوقت 3 — ${decorateClock(now, 3)}\n\n` +
        `الوقت 4 — ${decorateClock(now, 4)}\n\n` +
        `كل اختيار فيه زخرفة ارقام مختلفة والساعة تتحدث كل دقيقة بدون اي ايموجي\n` +
        `اسمك الحالي هيفضل موجود والساعة تتضاف بجانبه\n` +
        `ارسل رقم الزخرفة من 1 الى 4 لتفعيل الوقت\n` +
        `للغاء ارسال (.الغاء)`);
}

// بدء الساعة بالزخرفة المختارة
function finishClockPick(num, sock, chat, style, A) {
    A.pending = null;
    startClock(num, sock, (sock.user && sock.user.name) || '', style);
    return waReply(sock, chat,
        `تم تفعيل الوقت بزخرفة الوقت ${style}\n` +
        `الساعة بتتحدث كل دقيقة بجانب اسم حسابك بدون اي ايموجي\n` +
        `اسمك الاصلي محفوظ ولما تلغي بامر (.الغاء الوقت) بيرجع زي ما كان بالظبط`);
}

// .الغاء الوقت — يشيل الساعة ويرجع الاسم الاصلي بدون اي ساعة او ايموجي
async function cmdClockOff(num, sock, chat, A) {
    if (!A.clock) return waReply(sock, chat, 'الوقت غير مفعيل حاليا');
    stopClock(num);
    return waReply(sock, chat, 'تم الغاء الوقت وحذف الساعه\nتم استرجاع اسم حسابك الاصلي زي ما كان');
}

// .بروفايل : صورة ومعلومات الحساب ترسل لرقم المستخدم نفسه
async function cmdProfile(num, sock, msg, chat, arg, A) {
    let targetJid = null;
    if (arg && /^\d+$/.test(arg.replace(/\+/g, ''))) {
        targetJid = `${arg.replace(/\D/g, '')}@s.whatsapp.net`;
    } else {
        const q = getQuoted(msg);
        if (q && q.participant) targetJid = numFromJid(q.participant) + '@s.whatsapp.net';
        else targetJid = chat;
    }
    if (targetJid === 'status@broadcast') return;
    const targetNum = numFromJid(targetJid);
    const name = A.nameCache.get(targetNum) || (targetNum === num ? (sock.user?.name || '') : '') || '(غير معروف)';
    const bio = await getBio(sock, targetJid);
    let pic = null;
    try { pic = await sock.profilePictureUrl(targetJid, 'image'); } catch (_) {}
    const info = `معلومات الحساب\nالاسم : ${name}\nالرقم : ${fmtPhone(targetNum)}\nالبايو : ${bio || '(لا يوجد)'}`;
    if (pic) {
        try {
            const buf = await httpsGetBuffer(pic);
            await sock.sendMessage(selfJidOf(num), { image: buf, caption: info }).catch(() => {});
            return;
        } catch (_) {}
    }
    await sock.sendMessage(selfJidOf(num), { text: info }).catch(() => {});
}

function httpsGetBuffer(url, timeoutMs = 15000, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    });
}

function httpsGetJson(url, timeoutMs = 15000, headers = {}) {
    return httpsGetBuffer(url, timeoutMs, headers).then(b => JSON.parse(b.toString('utf8')));
}

// ==========================================
// 🧠 وضع الذكاء الاصطناعي (.تفعيل وضع الذكاء الاصطناعي)
// ==========================================
// مزودين مجانيين بدون اي مفاتيح (Pollinations) + مفاتيح اختيارية من متغيرات البيئة
// (OPENROUTER_API_KEY / GROQ_API_KEY) — البوت بيتبادل بينهم تلقائيا ليستحمل الضغط
const AI_STATE = { inFlight: 0, rr: 0, maxConcurrent: 4 };
const AI_SYSTEM = 'انتي مساعد شخصي على واتساب بترد مكان صاحب الحساب. رد على المستخدم بلغة رسالته (عربي او اي لغة تاني) رد طبيعي ومختصر كأنك شخص حقيقي بتتكلم واتساب، بدون شرح انك ذكاء اصطناعي وبدون رموز ماركداون. لو السؤال مش واضح اطلب توضيح بشرح قصير.';

function httpsPostJson(url, body, headers = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(e); }
        const data = Buffer.from(JSON.stringify(body));
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
            timeout: timeoutMs
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + raw.slice(0, 120)));
                try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}
function httpsGetText(url, timeoutMs = 30000) {
    return httpsGetBuffer(url, timeoutMs).then(b => b.toString('utf8'));
}
function aiOpenAICompatible(url, key, model, msgs) {
    return httpsPostJson(url, { model, messages: msgs }, { Authorization: `Bearer ${key}` })
        .then(res => {
            const t = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
            if (!t) throw new Error('رد فارغ من المزود');
            return String(t).trim();
        });
}
function aiPollinationsOpenAI(msgs, model) {
    return httpsPostJson('https://text.pollinations.ai/openai', { model: model || 'openai', messages: msgs, referrer: 'watxbot' })
        .then(res => {
            const t = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
            if (!t) throw new Error('رد فارغ من المزود');
            return String(t).trim();
        });
}
function aiPollinationsText(msgs) {
    const last = msgs[msgs.length - 1];
    const q = encodeURIComponent(String((last && last.content) || '').slice(0, 700));
    return httpsGetText(`https://text.pollinations.ai/${q}?model=mistral&system=${encodeURIComponent(AI_SYSTEM.slice(0, 180))}`)
        .then(t => {
            if (!t) throw new Error('رد فارغ من المزود');
            return String(t).trim();
        });
}
function aiProviders() {
    const list = [];
    // المفاتيح الاختيارية الاولى (اقوى وافضل ضغط) لو صاحب البوت حطها في متغيرات البيئة
    if (process.env.OPENROUTER_API_KEY) {
        list.push((msgs) => aiOpenAICompatible('https://openrouter.ai/api/v1/chat/completions',
            process.env.OPENROUTER_API_KEY, 'meta-llama/llama-3.3-70b-instruct:free', msgs));
    }
    if (process.env.GROQ_API_KEY) {
        list.push((msgs) => aiOpenAICompatible('https://api.groq.com/openai/v1/chat/completions',
            process.env.GROQ_API_KEY, 'llama-3.3-70b-versatile', msgs));
    }
    // مزودين مجانيين بدون مفاتيح — بيتبدلوا تلقائيا تحت الضغط
    list.push((msgs) => aiPollinationsOpenAI(msgs, 'openai'));
    list.push((msgs) => aiPollinationsOpenAI(msgs, 'mistral'));
    list.push((msgs) => aiPollinationsText(msgs));
    return list;
}
function aiHistoryPush(A, chat, role, content) {
    let h = A.aiHistory.get(chat);
    if (!h) { h = []; A.aiHistory.set(chat, h); }
    h.push({ role, content: String(content).slice(0, 500) });
    while (h.length > 8) h.shift();
}
async function aiReply(num, sock, chat, senderName, userText) {
    const A = getAcct(num);
    if (AI_STATE.inFlight >= AI_STATE.maxConcurrent) return; // تحمل الضغط : بدون طابور لانهائي
    AI_STATE.inFlight++;
    try {
        aiHistoryPush(A, chat, 'user', userText);
        const msgs = [
            { role: 'system', content: AI_SYSTEM + (senderName ? ` اسم الشخص اللي بيكلمك: ${senderName}.` : '') },
            ...(A.aiHistory.get(chat) || [])
        ];
        const providers = aiProviders();
        let text = null;
        let lastErr = null;
        for (let i = 0; i < providers.length; i++) {
            const p = providers[(AI_STATE.rr + i) % providers.length];
            try {
                text = await withTimeout(p.call(msgs), 45000);
                AI_STATE.rr = (AI_STATE.rr + i + 1) % providers.length;
                break;
            } catch (e) { lastErr = e; }
        }
        if (!text) throw lastErr || new Error('مفيش مزود ذكاء اصطناعي متاح');
        aiHistoryPush(A, chat, 'assistant', text);
        await sock.sendMessage(chat, { text: styleText(sock, text) });
    } finally {
        AI_STATE.inFlight--;
    }
}
async function cmdAiOn(num, sock, chat, A) {
    if (A.ai) return waReply(sock, chat, 'وضع الذكاء الاصطناعي مفعيل بالفعل\nلايقافه ارسل (.ايقاف وضع الذكاء الاصطناعي)');
    A.ai = true;
    setSetting(`ai:${num}`, '1');
    // لو الرد التلقائي شغال نوقفه عشان الرد الذكي يشتغل مكانه بدون تعارض
    if (A.autoreply) { A.autoreply = ''; saveAutoreply(num, A); }
    return waReply(sock, chat,
        'تم تفعيل وضع الذكاء الاصطناعي\n\n' +
        'الحساب هيرد مكانه على اي حد يكلمه في الخاص بلغة رسالته وبسياق المحادثة\n' +
        'الرد بيشتغل على رسايل الخاص فقط والبوت بيتبادل بين اكتر من مزود مجاني ليستحمل الضغط\n' +
        'ملاحظة : لو الرد التلقائي كان شغال تم ايقافه عشان مايتضاربوش\n' +
        'لايقافه ارسل (.ايقاف وضع الذكاء الاصطناعي)');
}
async function cmdAiOff(num, sock, chat, A) {
    if (!A.ai) return waReply(sock, chat, 'وضع الذكاء الاصطناعي غير مفعيل حاليا');
    A.ai = false;
    delSetting(`ai:${num}`);
    return waReply(sock, chat, 'تم ايقاف وضع الذكاء الاصطناعي');
}

// ==========================================
// 🌤️ الطقس (.الطقس) — Open-Meteo مجاني بدون مفتاح
// ==========================================
const WEATHER_CODES = {
    0: 'صافي', 1: 'صافي جزئيا', 2: 'غائم جزئيا', 3: 'غائم', 45: 'ضباب', 48: 'ضباب متجمد',
    51: 'رشات خفيفة', 53: 'رشات متوسطة', 55: 'رشات كثيفة', 56: 'رشات متجمدة', 57: 'رشات متجمدة كثيفة',
    61: 'مطر خفيف', 63: 'مطر متوسط', 65: 'مطر غزير', 66: 'مطر متجمد', 67: 'مطر متجمد غزير',
    71: 'ثلوج خفيفة', 73: 'ثلوج متوسطة', 75: 'ثلوج كثيفة', 77: 'حبات ثلج',
    80: 'زخات مطر خفيفة', 81: 'زخات مطر متوسطة', 82: 'زخات مطر غزيرة',
    85: 'زخات ثلج خفيفة', 86: 'زخات ثلج كثيفة', 95: 'عاصفة رعدية', 96: 'عاصفة رعدية مع برد', 99: 'عاصفة رعدية قوية مع برد'
};
// بحث جغرافي بسلسلة 3 مزودين مجانيين — لو واحد مات الباقي بيكمل
async function geocodePlace(place) {
    const q = encodeURIComponent(place);
    // 1) Open-Meteo geocoding
    try {
        const geo = await withTimeout(httpsGetJson(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=ar&format=json`), 12000);
        const g = geo && geo.results && geo.results[0];
        if (g) return { lat: g.latitude, lon: g.longitude, name: g.name || place, country: g.country || '' };
    } catch (_) {}
    // 2) Photon (komoot)
    try {
        const geo = await withTimeout(httpsGetJson(`https://photon.komoot.io/api/?q=${q}&limit=1&lang=default`), 12000);
        const f = geo && geo.features && geo.features[0];
        if (f && f.geometry && f.geometry.coordinates) {
            const p = f.properties || {};
            return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: p.name || p.city || place, country: p.country || p.state || '' };
        }
    } catch (_) {}
    // 3) Nominatim (OpenStreetMap) — بيدعم عربي وبيحتاج User-Agent
    try {
        const geo = await withTimeout(httpsGetJson(
            `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&accept-language=ar`,
            12000, { 'User-Agent': 'WATxBot/3.0 (whatsapp bot)', 'Accept-Language': 'ar' }), 12000);
        const g = geo && geo[0];
        if (g && g.lat && g.lon) {
            const parts = String(g.display_name || '').split(',');
            return { lat: Number(g.lat), lon: Number(g.lon), name: (parts[0] || place).trim(), country: (parts[1] || '').trim() };
        }
    } catch (_) {}
    return null;
}
async function weatherFor(place) {
    const g = await geocodePlace(place);
    if (!g) return null;
    const w = await withTimeout(
        httpsGetJson(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`), 15000);
    const c = w && w.current;
    if (!c) return null;
    return {
        place: g.name,
        country: g.country,
        temp: Math.round(c.temperature_2m),
        feels: Math.round(c.apparent_temperature),
        hum: c.relative_humidity_2m,
        wind: Math.round(c.wind_speed_10m),
        desc: WEATHER_CODES[c.weather_code] || 'حالة جو غير معروفة'
    };
}
async function cmdWeather(num, sock, chat, arg, A) {
    const place = String(arg || '').trim();
    if (!place) {
        if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
        A.pending = { type: 'weather', chat };
        return waReply(sock, chat,
            'اكتب اسم الدولة او المدينة التي تريد عرض حالة الطقس فيها\n' +
            'يمكن اي دولة عربية او اجنبية مثال : مصر او ايران او المغرب او العراق او تونس\n' +
            'للغاء ارسال (.الغاء)');
    }
    return doWeather(num, sock, chat, place, A);
}
async function doWeather(num, sock, chat, place, A) {
    if (A.pending && A.pending.type === 'weather') A.pending = null;
    let w = null;
    try { w = await weatherFor(place); } catch (_) {}
    if (!w) return waReply(sock, chat, `لم استطع العثور على الطقس لـ : ${place}\nتأكد من اسم الدولة او المدينة وحاول مرة اخرى`);
    return waReply(sock, chat,
        `حالة الطقس في : ${w.place}${w.country ? ` - ${w.country}` : ''}\n\n` +
        `الحالة : ${w.desc}\n` +
        `درجة الحرارة : ${w.temp} درجة\n` +
        `الاحساس الحراري : ${w.feels} درجة\n` +
        `الرطوبة : ${w.hum}%\n` +
        `سرعة الرياح : ${w.wind} كم/س`);
}

// ==========================================
// 💲 سعر الدولار (.سعر الدولار) — APIs مجانية بدون مفتاح
// ==========================================
const CURRENCY_WORDS = {
    'مصري': 'EGP', 'مصر': 'EGP', 'جنيه': 'EGP',
    'سعودي': 'SAR', 'السعودية': 'SAR', 'ريال سعودي': 'SAR',
    'اماراتي': 'AED', 'الامارات': 'AED', 'درهم': 'AED',
    'كويتي': 'KWD', 'قطري': 'QAR', 'عماني': 'OMR', 'بحريني': 'BHD',
    'اردني': 'JOD', 'لبناني': 'LBP', 'سوري': 'SYP', 'عراقي': 'IQD',
    'مغربي': 'MAD', 'المغرب': 'MAD', 'تونسي': 'TND', 'جزائري': 'DZD',
    'ليبي': 'LYD', 'سوداني': 'SDG', 'يمني': 'YER', 'تركي': 'TRY', 'يورو': 'EUR'
};
const CURRENCY_NAMES = {
    EGP: 'الجنيه المصري', SAR: 'الريال السعودي', AED: 'الدرهم الاماراتي', KWD: 'الدينار الكويتي',
    QAR: 'الريال القطري', OMR: 'الريال العماني', BHD: 'الدينار البحريني', JOD: 'الدينار الاردني',
    LBP: 'الليرة اللبنانية', SYP: 'الليرة السورية', IQD: 'الدينار العراقي', MAD: 'الدرهم المغربي',
    TND: 'الدينار التونسي', DZD: 'الدينار الجزائري', LYD: 'الدينار الليبي', SDG: 'الجنيه السوداني',
    YER: 'الريال اليمني', TRY: 'الليرة التركية', EUR: 'اليورو'
};
const RATES_CACHE = new Map(); // code -> { rate, ts } كاش 10 دقايق عشان الضغط
async function usdRateFor(code) {
    const c = RATES_CACHE.get(code);
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.rate;
    let rate = null;
    try {
        const j = await withTimeout(httpsGetJson('https://open.er-api.com/v6/latest/USD'), 15000);
        if (j && j.rates && j.rates[code]) rate = j.rates[code];
    } catch (_) {}
    if (rate == null) {
        try {
            const j = await withTimeout(httpsGetJson(`https://api.frankfurter.app/latest?from=USD&to=${code}`), 15000);
            if (j && j.rates && j.rates[code]) rate = j.rates[code];
        } catch (_) {}
    }
    if (rate == null) return null;
    RATES_CACHE.set(code, { rate, ts: Date.now() });
    return rate;
}
async function cmdUsdPrice(num, sock, chat, arg) {
    const s = String(arg || '');
    let code = 'EGP';
    for (const [word, c] of Object.entries(CURRENCY_WORDS)) {
        if (s.includes(word)) { code = c; break; }
    }
    const rate = await usdRateFor(code);
    if (rate == null) return waReply(sock, chat, 'تعذر جلب سعر الدولار الآن ، حاول بعد قليل');
    const name = CURRENCY_NAMES[code] || code;
    const shown = Number(rate) >= 10 ? Number(rate).toFixed(2) : Number(rate).toFixed(4);
    return waReply(sock, chat, `سعر الدولار اليوم مقابل ${name} : ${shown}`);
}

// ==========================================
// 🧮 الحساب (.حساب 12 + 12) — تقييم آمن بدون eval خطير
// ==========================================
function calcExpr(raw) {
    let e = String(raw || '')
        .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**')
        .replace(/\s+/g, "")
        .replace(/(^|\D)0+(\d)/g, "$1$2") // شيل الاصفار القدامية عشان strict mode بيرفض الاصفار القدامية مثل 05
    if (!e || !/^[0-9+\-*/().%]+$/.test(e)) return null;
    if ((e.match(/\(/g) || []).length !== (e.match(/\)/g) || []).length) return null;
    try {
        const val = Function(`"use strict"; return (${e})`)();
        if (typeof val !== 'number' || !isFinite(val)) return null;
        return Math.round(val * 1e6) / 1e6;
    } catch (_) { return null; }
}
async function cmdCalc(num, sock, chat, arg) {
    const res = calcExpr(arg);
    if (res === null) {
        return waReply(sock, chat, 'استخدام : .حساب (العملية الحسابية)\nمثال : .حساب 12 + 12 او .حساب (5 × 3) + 2');
    }
    return waReply(sock, chat, `النتيجة : ${res}`);
}

// .تغيير صورة تلقائيا (عدد الصور)
async function cmdAutoPhoto(num, sock, chat, arg, A) {
    if (A.rot) return waReply(sock, chat, 'تغيير الصوره التلقائي شغال بالفعل\nلايقافه ارسل (.ايقاف تغيير صورة)');
    if (A.pending) return waReply(sock, chat, 'فيه عملية شغالة بالفعل\nيمكنك الغاؤها ب امر (.الغاء العمليه)');
    const count = parseInt(arg);
    if (!count || count < 1 || count > 20) {
        return waReply(sock, chat, 'استخدام : .تغيير صورة تلقائيا (عدد الصور)\nمثال : .تغيير صورة تلقائيا 5');
    }
    A.pending = { type: 'photocollect', chat, need: count, got: 0 };
    return waReply(sock, chat,
        `ارسل ${count} صوره الان وسيتم حفظها على السيرفر في مجلد باسم رقم هاتفك\n` +
        `بعد اكمال العدد كله سيتم طلب عدد الثواني بين كل تغيير للصوره\n` +
        `يمكنك الغاء العملية ب امر (الغاء العمليه)`);
}

// استلام صور العملية
async function collectPhoto(num, sock, chat, inner, A) {
    const P = A.pending;
    const dl = await downloadMedia(inner, 'imageMessage');
    if (!dl) return waReply(sock, chat, 'تأكد انك ارسلت صوره');
    const dir = photosDir(num);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    P.got++;
    const fp = path.join(dir, `photo_${P.got}_${Date.now()}.jpg`);
    try { fs.writeFileSync(fp, dl.buffer); } catch (_) {}
    if (P.got < P.need) {
        return waReply(sock, chat, `تم استلام (${P.got}/${P.need}) صوره`);
    }
    A.pending = { type: 'photointerval', chat };
    return waReply(sock, chat,
        `تم حفظ جميع الصور (${P.need}) في مجلد باسم رقمك\n` +
        `الان ارسل عدد الثواني بين كل تغيير للصوره\n` +
        `ثانيتين ب حد ادنى و 600 ثانية (10 دقائق) ب حد اقصى\n` +
        `يمكنك الغاء العملية ب امر (الغاء العمليه)`);
}

// اختيار المدة وبدء التغيير العشوائي
async function finishPhotoInterval(num, sock, chat, sec, A) {
    A.pending = null;
    sec = Math.max(2, Math.min(600, sec));
    const dir = photosDir(num);
    try {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
        if (!files.length) return waReply(sock, chat, 'لا توجد صور محفوظه');
    } catch (_) { return waReply(sock, chat, 'لا يوجد مجلد صور'); }
    startRotation(num, sock, sec);
    // تغيير أول صورة فورا
    try {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
        const f = files[Math.floor(Math.random() * files.length)];
        const buf = fs.readFileSync(path.join(dir, f));
        await setProfilePictureSafe(sock, selfJidOf(num), buf, path.join(dataDir, `tmp_${num}.jpg`));
    } catch (_) {}
    return waReply(sock, chat,
        `تم بدء تغيير صورة البروفايل تلقائيا كل ${sec} ثانية بالصور الموجودة عشوائيا\n` +
        `لايقافه ارسل (.ايقاف تغيير صورة)\n` +
        `ولحذف مجلد الصور ارسل (.حذف مجلد الصور الخاص بي)`);
}

// ==========================================
// 🛡️ مراقب اتصال التليجرام الذاتي
// ==========================================
let tgLaunching = false;
let tgFailCount = 0;

async function startTelegramPolling() {
    if (tgLaunching) return;
    tgLaunching = true;
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
        bot.launch({
            allowedUpdates: ['message', 'callback_query', 'chat_member'],
            dropPendingUpdates: false
        }).catch((err) => {
            console.error('⚠️ توقف Polling التليجرام، جاري إعادة التشغيل خلال 5 ثواني:', err?.message || err);
            tgLaunching = false;
            setTimeout(() => startTelegramPolling(), 5000);
        });
        console.log('✅ بوت التليجرام شغال وجاهز لاستقبال الرسايل!');
    } catch (e) {
        console.error('❌ خطأ في تشغيل التليجرام:', e.message);
        tgLaunching = false;
        setTimeout(() => startTelegramPolling(), 5000);
    }
}

setInterval(async () => {
    try {
        await withTimeout(bot.telegram.getMe(), 15000, 'Telegram ping timeout');
        tgFailCount = 0;
    } catch (e) {
        tgFailCount++;
        console.warn(`⚠️ فشل فحص اتصال التليجرام (${tgFailCount}): ${e.message}`);
        if (tgFailCount >= 3) {
            tgFailCount = 0;
            try { bot.stop('restart'); } catch (_) {}
            tgLaunching = false;
            setTimeout(() => startTelegramPolling(), 2000);
        }
    }
}, 45000);

// ==========================================
// 🚀 التشغيل
// ==========================================
(async () => {
    console.log('🤖 WhatsApp Bot - Telegram Panel v2');
    await initDb();
    console.log('🗄️ قاعدة البيانات جاهزة');

    // وضع فحص بدون تشغيل (للتجربة فقط)
    if (process.env.START_BOT === '0') {
        console.log('✅ Dry-run OK : الملف سليم وقاعدة البيانات جاهزة');
        process.exit(0);
    }

    await startTelegramPolling();
    restoreAll().catch(e => console.error('❌ خطأ أثناء استعادة الجلسات:', e.message));

    const shutdown = () => {
        try { bot.stop('SIGTERM'); } catch (_) {}
        try { if (db) fs.writeFileSync(dbFile, Buffer.from(db.export())); } catch (_) {}
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
})();

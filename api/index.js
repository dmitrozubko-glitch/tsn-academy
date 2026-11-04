const crypto = require('crypto');
const mysql = require('mysql2/promise');

let pool;
let schemaReady;
const json = (res, status, body) => res.status(status).json(body);
const readBody = async req => {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Некоректний JSON')); } });
  });
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
  const i = item.indexOf('='); return [item.slice(0, i).trim(), decodeURIComponent(item.slice(i + 1))];
}));
function secret() { return process.env.SESSION_SECRET || process.env.MYSQL_PASSWORD || 'change-session-secret'; }
function sign(value) { return crypto.createHmac('sha256', secret()).update(value).digest('base64url'); }
function setSession(res, user) {
  const payload = Buffer.from(JSON.stringify({ id:user.id, name:user.name, email:user.email, role:user.role, exp:Date.now() + 604800000 })).toString('base64url');
  res.setHeader('Set-Cookie', `tsn_session=${payload}.${sign(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
}
function getUser(req) {
  const token = cookies(req).tsn_session;
  if (!token) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try { const user = JSON.parse(Buffer.from(payload, 'base64url').toString()); return user.exp > Date.now() ? user : null; } catch { return null; }
}
function clearSession(res) { res.setHeader('Set-Cookie', 'tsn_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'); }
function need(req, res, admin = false) { const user = getUser(req); if (!user) { json(res, 401, { error:'Потрібна авторизація' }); return null; } if (admin && user.role !== 'admin') { json(res,403,{error:'Недостатньо прав'}); return null; } return user; }
const hash = password => new Promise((resolve, reject) => { const salt=crypto.randomBytes(16).toString('hex'); crypto.scrypt(password,salt,64,(e,key)=>e?reject(e):resolve(`${salt}:${key.toString('hex')}`)); });
const verify = (password, value) => new Promise((resolve,reject) => { const [salt, stored] = value.split(':'); crypto.scrypt(password,salt,64,(e,key)=>e?reject(e):resolve(crypto.timingSafeEqual(Buffer.from(stored,'hex'),key))); });

async function database() {
  if (pool) return pool;
  const { MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD } = process.env;
  if (!MYSQL_HOST || !MYSQL_DATABASE || !MYSQL_USER) throw new Error('Не налаштовані змінні MySQL на Vercel');
  const ssl = process.env.MYSQL_SSL === 'true' ? {
    rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== 'false',
    ...(process.env.MYSQL_CA ? { ca: process.env.MYSQL_CA.replace(/\\n/g, '\n') } : {})
  } : undefined;
  pool = mysql.createPool({ host:MYSQL_HOST, port:Number(process.env.MYSQL_PORT || 3306), database:MYSQL_DATABASE, user:MYSQL_USER, password:MYSQL_PASSWORD || '', ssl, waitForConnections:true, connectionLimit:3, enableKeepAlive:true, charset:'utf8mb4' });
  return pool;
}
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async() => {
    const db = await database();
    await db.query(`CREATE TABLE IF NOT EXISTS users (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,name VARCHAR(120) NOT NULL,email VARCHAR(160) NOT NULL UNIQUE,password_hash VARCHAR(255) NOT NULL,role ENUM('admin','user') NOT NULL DEFAULT 'user',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await db.query(`CREATE TABLE IF NOT EXISTS attempts (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,user_id INT UNSIGNED NOT NULL,exam_slug VARCHAR(80) NOT NULL,exam_title VARCHAR(180) NOT NULL,score SMALLINT UNSIGNED NOT NULL,max_score SMALLINT UNSIGNED NOT NULL,correct_answers SMALLINT UNSIGNED NOT NULL,passed BOOLEAN NOT NULL,started_at DATETIME NOT NULL,finished_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,answers_json JSON,INDEX(user_id),FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    const [columns] = await db.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='attempts'`);
    const present = new Set(columns.map(column => column.COLUMN_NAME));
    for (const [name, definition] of [['verification_code','VARCHAR(32) NULL UNIQUE'],['integrity_status',"VARCHAR(24) NOT NULL DEFAULT 'completed'"],['violation_reason','VARCHAR(255) NULL']]) {
      if (!present.has(name)) await db.query(`ALTER TABLE attempts ADD COLUMN ${name} ${definition}`);
    }
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const [exists] = await db.execute('SELECT id FROM users WHERE email=?',[process.env.ADMIN_EMAIL.toLowerCase()]);
      if (!exists.length) await db.execute(`INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,'admin')`,[process.env.ADMIN_NAME || 'Адмін TSN',process.env.ADMIN_EMAIL.toLowerCase(),await hash(process.env.ADMIN_PASSWORD)]);
    }
  })();
  return schemaReady;
}
async function discord(data) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;
  const response = await fetch(process.env.DISCORD_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'TSN Academy',embeds:[{title:data.passed?'✅ ІСПИТ СКЛАДЕНО':'❌ ІСПИТ НЕ СКЛАДЕНО',description:`**${data.exam}**`,color:data.passed?0xC8FF42:0xFF5C8A,fields:[{name:'👤 Учасник',value:data.user,inline:true},{name:'🎯 Результат',value:`**${data.score} / ${data.max}**`,inline:true},{name:'📌 Прохідний бал',value:`${data.passingScore} / ${data.max}`,inline:true}],footer:{text:'TSN Academy · Автоматичний результат'},timestamp:new Date().toISOString()}]})});
  if (!response.ok) throw new Error('Discord webhook недоступний');
}

module.exports = async (req, res) => {
  try {
    const path = new URL(req.url, `https://${req.headers.host}`).pathname.replace(/^\/api/, '') || '/';
    if (req.method === 'GET' && path === '/me') return json(res,200,{user:getUser(req)});
    await ensureSchema(); const db = await database();
    if (req.method === 'POST' && path === '/auth/login') { const {email,password}=await readBody(req); const [rows]=await db.execute('SELECT * FROM users WHERE email=? LIMIT 1',[String(email || '').toLowerCase()]); if (!rows.length || !(await verify(password || '',rows[0].password_hash))) return json(res,401,{error:'Неправильна пошта або пароль'}); const user={id:rows[0].id,name:rows[0].name,email:rows[0].email,role:rows[0].role}; setSession(res,user); return json(res,200,{user}); }
    if (req.method === 'POST' && path === '/auth/register') { const {name,email,password}=await readBody(req); if(!name || !email || String(password).length < 6) return json(res,400,{error:'Вкажіть ім’я, пошту та пароль від 6 символів'}); try { const [r]=await db.execute('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)',[String(name).slice(0,120),String(email).toLowerCase(),await hash(password)]); const user={id:r.insertId,name:String(name).slice(0,120),email:String(email).toLowerCase(),role:'user'}; setSession(res,user); return json(res,201,{user}); } catch { return json(res,409,{error:'Ця пошта вже зареєстрована'}); } }
    if (req.method === 'POST' && path === '/auth/logout') { clearSession(res); return json(res,200,{ok:true}); }
    if (req.method === 'GET' && path === '/dashboard') { const user=need(req,res); if(!user)return; const [history]=await db.execute('SELECT * FROM attempts WHERE user_id=? ORDER BY finished_at DESC',[user.id]); const best={}; history.forEach(x=>{if(!best[x.exam_slug]||best[x.exam_slug].score<x.score)best[x.exam_slug]=x}); const achievements=[]; if(history.some(x=>x.passed))achievements.push({icon:'✦',title:'Перший успіх',text:'Іспит складено'}); if(history.some(x=>x.exam_slug==='ppe'&&x.score===38))achievements.push({icon:'⚡',title:'Ідеальний ППО/ППЕ',text:'38 із 38 балів'}); if(history.filter(x=>x.passed).length>=3)achievements.push({icon:'🔥',title:'Серія знань',text:'3 успішні іспити'}); return json(res,200,{history,best,achievements}); }
    if (req.method === 'GET' && path.startsWith('/verify/')) { const code=path.split('/').pop(); const [rows]=await db.execute(`SELECT a.verification_code,a.exam_title,a.score,a.max_score,a.passed,a.finished_at,a.integrity_status,u.name FROM attempts a JOIN users u ON u.id=a.user_id WHERE a.verification_code=? LIMIT 1`,[code]); if(!rows.length) return json(res,404,{valid:false,error:'Сертифікат не знайдено'}); const certificate=rows[0]; return json(res,200,{valid:Boolean(certificate.passed)&&certificate.integrity_status==='completed',certificate}); }
    if (req.method === 'GET' && path === '/admin/results') { const user=need(req,res,true); if(!user)return; const [results]=await db.query('SELECT a.*,u.name,u.email FROM attempts a JOIN users u ON u.id=a.user_id ORDER BY a.finished_at DESC LIMIT 200'); return json(res,200,{results}); }
    if (req.method === 'POST' && path === '/results') { const user=need(req,res); if(!user)return; const b=await readBody(req), maxAttempts=Number(b.maxAttempts)||3; const [count]=await db.execute('SELECT COUNT(*) n FROM attempts WHERE user_id=? AND exam_slug=?',[user.id,String(b.examSlug||'')]); if(count[0].n >= maxAttempts)return json(res,429,{error:`Доступно лише ${maxAttempts} спроби для цього іспиту`}); const result={examSlug:String(b.examSlug||'unknown').slice(0,80),exam:String(b.exam||'Іспит').slice(0,180),score:Number(b.score)||0,max:Number(b.max)||0,correct:Number(b.correct)||0,passed:!!b.passed,startedAt:new Date(b.startedAt||Date.now()),durationSeconds:Number(b.durationSeconds)||0,answers:Array.isArray(b.answers)?b.answers:[],passingScore:Number(b.passingScore)||0,user:user.name,integrityStatus:b.integrityStatus==='annulled'?'annulled':'completed',violationReason:String(b.violationReason||'').slice(0,255)}; const code=result.passed&&result.integrityStatus==='completed'?crypto.randomBytes(9).toString('base64url'):null; await db.execute('INSERT INTO attempts(user_id,exam_slug,exam_title,score,max_score,correct_answers,passed,started_at,duration_seconds,answers_json,verification_code,integrity_status,violation_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[user.id,result.examSlug,result.exam,result.score,result.max,result.correct,result.passed,result.startedAt,result.durationSeconds,JSON.stringify(result.answers),code,result.integrityStatus,result.violationReason||null]); try{await discord(result)}catch(error){console.error(error.message)} return json(res,201,{ok:true,verificationCode:code}); }
    return json(res,404,{error:'API не знайдено'});
  } catch (error) { console.error(error); return json(res,500,{error:error.message || 'Помилка сервера'}); }
};

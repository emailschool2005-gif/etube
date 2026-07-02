// ============================================================
//  eTube — Servidor Node.js + Express  (server.js)
//  Versão melhorada com integração PeerTube real
// ============================================================

const express  = require('express');
const cors     = require('cors');
const sqlite3  = require('sqlite3').verbose();
const path     = require('path');
const https    = require('https');
const http     = require('http');

const app = express();

// ── Configuração PeerTube ────────────────────────────────────
// Altere para o URL da sua instância PeerTube interna
const PEERTUBE_BASE = process.env.PEERTUBE_URL || 'https://peertube.tv';

// Conta de serviço criada no PeerTube para upload automático
// Configure com variáveis de ambiente em produção (nunca hardcode!)
const PT_CLIENT_KEY    = process.env.PT_CLIENT_KEY    || '';
const PT_CLIENT_SECRET = process.env.PT_CLIENT_SECRET || '';
const PT_USERNAME      = process.env.PT_USERNAME      || 'etube_service';
const PT_PASSWORD      = process.env.PT_PASSWORD      || '';

// Cache simples do token OAuth2 em memória
let ptToken = null;        // access_token
let ptRefreshToken = null; // refresh_token
let ptTokenExpiry = 0;     // timestamp de expiração

// ── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── Base de Dados SQLite ─────────────────────────────────────
const dbPath = path.resolve(__dirname, 'etube.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) console.error('Erro ao abrir SQLite:', err.message);
  else     console.log('✅ SQLite ligado em', dbPath);
});

// Helper para correr queries com Promise
const dbRun  = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e ? rej(e) : res(this); }));
const dbGet  = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r)  => e ? rej(e) : res(r)));
const dbAll  = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,rs) => e ? rej(e) : res(rs)));

// ── Inicialização das Tabelas ────────────────────────────────
async function initDB() {
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT UNIQUE,
    email              TEXT UNIQUE,
    password           TEXT,
    avatar_bg          TEXT,
    can_publish        INTEGER DEFAULT 0,
    can_create_channel INTEGER DEFAULT 0,
    peertube_channel_id TEXT,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS local_videos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid         TEXT UNIQUE NOT NULL,
    name         TEXT,
    description  TEXT,
    username     TEXT,
    category     TEXT DEFAULT 'Geral',
    course       TEXT,
    views        INTEGER DEFAULT 0,
    duration     INTEGER DEFAULT 0,
    thumbnail    TEXT,
    peertube_url TEXT,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_uuid TEXT,
    username   TEXT,
    avatar_bg  TEXT,
    text       TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Conta admin por defeito
  await dbRun(`INSERT OR IGNORE INTO users
    (username,email,password,avatar_bg,can_publish,can_create_channel)
    VALUES ('etube','etube@etpm.pt','etpm@2026','#C8102E',1,1)`);

  // Contas de curso
  const courses = ['tis','tgei','tcp','tpc','tagd','tae'];
  for (const c of courses) {
    await dbRun(`INSERT OR IGNORE INTO users
      (username,email,password,avatar_bg,can_publish,can_create_channel)
      VALUES (?,?,?,?,1,0)`, [c, `${c}@etpm.pt`, 'etpm@2026', '#104EC8']);
  }

  // Vídeos de exemplo (apenas se tabela vazia)
  const count = await dbGet(`SELECT COUNT(*) as n FROM local_videos`);
  if (count.n === 0) {
    const samples = [
      { uuid:'LjhESXm-8Wc', name:'Introdução às Tecnologias Multimédia', category:'Multimédia', course:'TIS' },
      { uuid:'dQw4w9WgXcQ', name:'Animação Digital e Efeitos Visuais',    category:'Animação',   course:'TAGD' },
      { uuid:'9bZkp7q19f0', name:'Desenvolvimento Web — Projeto ETube',   category:'Programação',course:'TIS'  }
    ];
    for (const v of samples) {
      await dbRun(`INSERT OR IGNORE INTO local_videos (uuid,name,category,course,username)
        VALUES (?,?,?,?,'etube')`, [v.uuid, v.name, v.category, v.course]);
    }
  }

  console.log('✅ Base de dados inicializada');
}

// ── PeerTube OAuth2 ──────────────────────────────────────────

// Faz um pedido HTTP/HTTPS simples (sem dependências extras)
function httpRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib  = url.protocol === 'https:' ? https : http;
    const req  = lib.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Obtém (ou renova) o token OAuth2 do PeerTube
async function getPeerTubeToken() {
  if (ptToken && Date.now() < ptTokenExpiry - 60000) return ptToken;

  // Tenta refresh primeiro
  if (ptRefreshToken) {
    try {
      const body = new URLSearchParams({
        client_id:     PT_CLIENT_KEY,
        client_secret: PT_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: ptRefreshToken
      }).toString();

      const r = await httpRequest(`${PEERTUBE_BASE}/api/v1/users/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, body);

      if (r.status === 200 && r.data.access_token) {
        ptToken        = r.data.access_token;
        ptRefreshToken = r.data.refresh_token;
        ptTokenExpiry  = Date.now() + r.data.expires_in * 1000;
        return ptToken;
      }
    } catch (_) { /* continua para login completo */ }
  }

  // Login completo (password grant)
  // Precisamos do client_id e client_secret da instância
  const oauthInfo = await httpRequest(`${PEERTUBE_BASE}/api/v1/oauth-clients/local`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });

  const clientId     = oauthInfo.data?.client_id     || PT_CLIENT_KEY;
  const clientSecret = oauthInfo.data?.client_secret || PT_CLIENT_SECRET;

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'password',
    username:      PT_USERNAME,
    password:      PT_PASSWORD
  }).toString();

  const r = await httpRequest(`${PEERTUBE_BASE}/api/v1/users/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, body);

  if (r.status !== 200 || !r.data.access_token) {
    throw new Error('Falha ao obter token PeerTube: ' + JSON.stringify(r.data));
  }

  ptToken        = r.data.access_token;
  ptRefreshToken = r.data.refresh_token;
  ptTokenExpiry  = Date.now() + r.data.expires_in * 1000;
  return ptToken;
}

// ── Proxy de Thumbnail (evita CORS nas miniaturas) ───────────
app.get('/api/proxy/thumbnail/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const url = `${PEERTUBE_BASE}/lazy-static/previews/${uuid}.jpg`;
  try {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, imgRes => {
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      imgRes.pipe(res);
    }).on('error', () => res.redirect('https://placehold.co/640x360?text=ETube'));
  } catch {
    res.redirect('https://placehold.co/640x360?text=ETube');
  }
});

// ── Proxy de Metadados PeerTube (evita CORS no frontend) ────
// O frontend chama /api/proxy/video/:uuid em vez de bater direto no PeerTube
app.get('/api/proxy/video/:uuid', async (req, res) => {
  try {
    const r = await httpRequest(`${PEERTUBE_BASE}/api/v1/videos/${req.params.uuid}`, { method:'GET' });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: 'Não foi possível contactar o PeerTube.' });
  }
});

// ── API: Canal PeerTube (criação automática) ──────────────────
// Cria um canal no PeerTube para um utilizador/curso
app.post('/api/peertube/channel', async (req, res) => {
  const { email, adminPassword, displayName, description, support } = req.body;
  if (!email || !adminPassword) return res.status(400).json({ error: 'Dados incompletos.' });
  if (adminPassword !== 'etpm@2026') return res.status(403).json({ error: 'Acesso negado.' });

  try {
    const token = await getPeerTubeToken();
    const r = await httpRequest(`${PEERTUBE_BASE}/api/v1/video-channels`, {
      method:  'POST',
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` }
    }, { name: displayName.toLowerCase().replace(/\s+/g,'_'), displayName, description: description || '', support: support || '' });

    if (r.status === 200 || r.status === 204) {
      // Guarda o ID do canal na BD do utilizador
      await dbRun(`UPDATE users SET peertube_channel_id = ? WHERE email = ?`, [r.data.videoChannel?.id, email]);
      res.json({ success: true, channel: r.data.videoChannel });
    } else {
      res.status(r.status).json({ error: r.data?.error || 'Erro ao criar canal.' });
    }
  } catch (err) {
    console.error('PeerTube channel error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com PeerTube.' });
  }
});

// ── API: Upload de vídeo para PeerTube ───────────────────────
// Recebe multipart/form-data com o ficheiro e metadados.
// Requer o pacote 'multer': npm install multer
// Se não tiver multer instalado, devolve instrução clara.
app.post('/api/videos/upload', async (req, res) => {
  // Verificar se o utilizador tem permissão
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()]).catch(() => null);
  if (!user || !user.can_publish) return res.status(403).json({ error: 'Sem permissão para publicar.' });

  // Verifica se multer está disponível
  try {
    require.resolve('multer');
  } catch {
    return res.status(501).json({
      error: 'Instale o multer: npm install multer',
      hint:  'O upload de ficheiros requer o pacote multer.'
    });
  }

  // Se multer estiver disponível, o upload é gerido aqui.
  // Veja o exemplo completo no guia de integração PeerTube.
  res.status(501).json({ error: 'Configure o multer para uploads de ficheiro.' });
});

// ── API: Sincronização PeerTube → SQLite ─────────────────────
// Puxa os vídeos do PeerTube e sincroniza com a BD local
app.post('/api/sync/peertube', async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== 'etpm@2026') return res.status(403).json({ error: 'Acesso negado.' });

  try {
    const r = await httpRequest(
      `${PEERTUBE_BASE}/api/v1/videos?count=50&sort=-publishedAt&nsfw=false`,
      { method: 'GET' }
    );

    if (r.status !== 200) throw new Error('PeerTube offline ou inacessível.');

    const videos = r.data.data || [];
    let sincronizados = 0;

    for (const v of videos) {
      try {
        await dbRun(`INSERT OR IGNORE INTO local_videos
          (uuid, name, description, username, category, duration, thumbnail, published_at)
          VALUES (?,?,?,?,?,?,?,?)`, [
          v.uuid,
          v.name,
          v.description || '',
          v.account?.name || 'ETube',
          'Geral',
          v.duration || 0,
          `${PEERTUBE_BASE}${v.previewPath}`,
          v.publishedAt
        ]);
        sincronizados++;
      } catch (_) { /* uuid duplicado — ignorar */ }
    }

    res.json({ success: true, total: videos.length, sincronizados });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── API: Atualizar metadados de um vídeo ─────────────────────
app.put('/api/videos/:uuid', async (req, res) => {
  const { name, category, course, description, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()]).catch(() => null);
  if (!user) return res.status(403).json({ error: 'Utilizador não encontrado.' });

  const video = await dbGet(`SELECT * FROM local_videos WHERE uuid = ?`, [req.params.uuid]).catch(() => null);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });

  // Só o autor ou admin pode editar
  const isAdmin = user.username === 'etube';
  if (!isAdmin && video.username !== user.username) return res.status(403).json({ error: 'Sem permissão.' });

  await dbRun(`UPDATE local_videos SET name=?, category=?, course=?, description=? WHERE uuid=?`,
    [name || video.name, category || video.category, course || video.course, description || video.description, req.params.uuid]);

  res.json({ success: true });
});

// ── API: Apagar vídeo ────────────────────────────────────────
app.delete('/api/videos/:uuid', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()]).catch(() => null);
  if (!user) return res.status(403).json({ error: 'Utilizador não encontrado.' });

  const video = await dbGet(`SELECT * FROM local_videos WHERE uuid = ?`, [req.params.uuid]).catch(() => null);
  if (!video) return res.status(404).json({ error: 'Vídeo não encontrado.' });

  const isAdmin = user.username === 'etube';
  if (!isAdmin && video.username !== user.username) return res.status(403).json({ error: 'Sem permissão.' });

  await dbRun(`DELETE FROM local_videos WHERE uuid = ?`, [req.params.uuid]);
  res.json({ success: true });
});

// ── API: Incrementar visualização ────────────────────────────
app.post('/api/videos/:uuid/view', async (req, res) => {
  await dbRun(`UPDATE local_videos SET views = views + 1 WHERE uuid = ?`, [req.params.uuid]).catch(() => {});
  res.json({ success: true });
});

// ── API: Listar vídeos ───────────────────────────────────────
app.get('/api/videos', async (req, res) => {
  try {
    const { search, category, course, sort } = req.query;
    let sql = `SELECT * FROM local_videos WHERE 1=1`;
    const p = [];

    if (search)   { sql += ` AND name LIKE ?`;     p.push(`%${search}%`); }
    if (category && category !== 'Todos') { sql += ` AND category = ?`; p.push(category); }
    if (course)   { sql += ` AND course = ?`;      p.push(course); }

    const orderMap = { recent: 'published_at DESC', views: 'views DESC', name: 'name ASC' };
    sql += ` ORDER BY ${orderMap[sort] || 'published_at DESC'}`;

    const rows = await dbAll(sql, p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Publicar vídeo (pelo UUID PeerTube) ─────────────────
app.post('/api/videos', async (req, res) => {
  try {
    const { uuid, name, email, category, course, description } = req.body;
    if (!uuid || !name || !email) return res.status(400).json({ error: 'uuid, nome e email são obrigatórios.' });

    const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()]);
    if (!user) return res.status(403).json({ error: 'Utilizador não encontrado.' });
    if (!user.can_publish && user.username !== 'etube') {
      return res.status(403).json({ error: 'Sem permissão para publicar vídeos.' });
    }

    // Tenta obter metadados reais do PeerTube
    let duration = 0, thumbnail = '';
    try {
      const r = await httpRequest(`${PEERTUBE_BASE}/api/v1/videos/${uuid}`, { method:'GET' });
      if (r.status === 200) {
        duration  = r.data.duration  || 0;
        thumbnail = r.data.previewPath ? `${PEERTUBE_BASE}${r.data.previewPath}` : '';
      }
    } catch (_) { /* PeerTube offline — continua sem metadados */ }

    const result = await dbRun(
      `INSERT INTO local_videos (uuid,name,description,username,category,course,duration,thumbnail)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuid, name, description||'', user.username, category||'Geral', course||'', duration, thumbnail]
    );

    res.json({ success: true, id: result.lastID });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Este UUID já existe na base de dados.' });
    res.status(500).json({ error: err.message });
  }
});

// ── API: Autenticação ────────────────────────────────────────
app.post('/api/auth/validate-and-login', async (req, res) => {
  try {
    const { username, password, mode } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    if (password.length < 4)    return res.status(400).json({ error: 'A palavra-passe deve ter pelo menos 4 caracteres.' });

    const email = username.trim().toLowerCase();
    if (!email.endsWith('@etpm.pt')) return res.status(400).json({ error: 'O email deve terminar em @etpm.pt.' });

    const row = await dbGet(`SELECT * FROM users WHERE email = ?`, [email]);

    if (mode === 'login') {
      if (!row)                   return res.status(404).json({ error: 'Email não encontrado.' });
      if (row.password !== password) return res.status(401).json({ error: 'Palavra-passe incorreta.' });
      return res.json({
        id: row.id, username: row.username, email: row.email,
        avatar_bg: row.avatar_bg,
        canPublish:       !!row.can_publish,
        canCreateChannel: !!row.can_create_channel,
        isAdmin:          row.username === 'etube',
        peertube_channel_id: row.peertube_channel_id
      });
    }

    if (mode === 'register') {
      if (email === 'etube@etpm.pt') return res.status(400).json({ error: 'Nome reservado ao administrador.' });
      if (row) return res.status(400).json({ error: 'Este email já está registado.' });

      const cores = ['#C8102E','#F5B700','#2E6930','#104EC8','#7310C8'];
      const cor = cores[Math.floor(Math.random() * cores.length)];
      const usernameFromEmail = email.split('@')[0];

      const result = await dbRun(
        `INSERT INTO users (username,email,password,avatar_bg,can_publish,can_create_channel) VALUES (?,?,?,?,0,0)`,
        [usernameFromEmail, email, password, cor]
      );
      return res.json({ id: result.lastID, username: usernameFromEmail, email, avatar_bg: cor, canPublish: false, canCreateChannel: false, isAdmin: false });
    }

    res.status(400).json({ error: 'Modo inválido.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Aprovar utilizador ───────────────────────────────────
app.post('/api/users/approve', async (req, res) => {
  try {
    const { adminEmail, adminPassword, userEmail, publish, createChannel } = req.body;
    if (!adminEmail || !adminPassword || !userEmail) return res.status(400).json({ error: 'Dados incompletos.' });

    const admin = await dbGet(`SELECT * FROM users WHERE email = ?`, [adminEmail.trim().toLowerCase()]);
    if (!admin || admin.username !== 'etube' || admin.password !== adminPassword) {
      return res.status(403).json({ error: 'Acesso de administrador negado.' });
    }

    const target = await dbGet(`SELECT * FROM users WHERE email = ?`, [userEmail.trim().toLowerCase()]);
    if (!target) return res.status(404).json({ error: 'Utilizador não encontrado.' });

    await dbRun(`UPDATE users SET can_publish=?, can_create_channel=? WHERE email=?`,
      [publish ? 1 : 0, createChannel ? 1 : 0, target.email]);

    res.json({ success: true, email: target.email, canPublish: !!publish, canCreateChannel: !!createChannel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Listar utilizadores (admin) ─────────────────────────
app.get('/api/users', async (req, res) => {
  const { adminPassword } = req.query;
  if (adminPassword !== 'etpm@2026') return res.status(403).json({ error: 'Acesso negado.' });
  const users = await dbAll(`SELECT id,username,email,avatar_bg,can_publish,can_create_channel,created_at FROM users ORDER BY created_at DESC`).catch(() => []);
  res.json(users);
});

// ── API: Comentários ─────────────────────────────────────────
app.get('/api/comments/:uuid', async (req, res) => {
  const rows = await dbAll(`SELECT * FROM comments WHERE video_uuid = ? ORDER BY created_at DESC`, [req.params.uuid]).catch(() => []);
  res.json(rows);
});

app.post('/api/comments', async (req, res) => {
  try {
    const { video_uuid, username, avatar_bg, text } = req.body;
    if (!video_uuid || !username || !text) return res.status(400).json({ error: 'Dados incompletos.' });
    if (text.trim().length < 1 || text.trim().length > 500) return res.status(400).json({ error: 'Comentário inválido (1–500 chars).' });

    const result = await dbRun(`INSERT INTO comments (video_uuid,username,avatar_bg,text) VALUES (?,?,?,?)`,
      [video_uuid, username, avatar_bg || '#555', text.trim()]);
    res.json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  const { email } = req.body;
  const user = await dbGet(`SELECT * FROM users WHERE email = ?`, [email?.trim().toLowerCase()]).catch(() => null);
  if (!user || user.username !== 'etube') return res.status(403).json({ error: 'Só o admin pode apagar comentários.' });

  await dbRun(`DELETE FROM comments WHERE id = ?`, [req.params.id]).catch(() => {});
  res.json({ success: true });
});

// ── API: Categorias disponíveis ───────────────────────────────
app.get('/api/categories', async (req, res) => {
  const rows = await dbAll(`SELECT DISTINCT category FROM local_videos WHERE category IS NOT NULL AND category != '' ORDER BY category`).catch(() => []);
  res.json(rows.map(r => r.category));
});

// ── Webhook PeerTube ─────────────────────────────────────────
// O PeerTube pode chamar este endpoint quando um vídeo é publicado/atualizado
// Configure em: Admin PeerTube > Plugins/Webhooks > URL: http://seu-servidor:3000/api/webhooks/peertube
app.post('/api/webhooks/peertube', async (req, res) => {
  const event = req.body;
  console.log('📩 Webhook PeerTube recebido:', event?.event);

  if (event?.event === 'video-published' && event?.video) {
    const v = event.video;
    try {
      await dbRun(`INSERT OR IGNORE INTO local_videos (uuid,name,description,username,duration,thumbnail,published_at)
        VALUES (?,?,?,?,?,?,?)`,
        [v.uuid, v.name, v.description||'', v.account?.name||'ETube', v.duration||0,
         v.previewPath ? `${PEERTUBE_BASE}${v.previewPath}` : '', v.publishedAt]);
      console.log(`✅ Vídeo sincronizado via webhook: ${v.name}`);
    } catch (_) { /* duplicado — normal */ }
  }

  res.json({ ok: true });
});

// ── Servir frontend SPA ───────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// Nota: Express 5 exige '/{*path}' em vez de '*'
app.get('/{*path}', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Arranque ──────────────────────────────────────────────────
initDB().then(() => {
  app.listen(3000, '0.0.0.0', () => {
    console.log('🚀 eTube a correr em http://127.0.0.1:3000');
    console.log(`📡 PeerTube configurado: ${PEERTUBE_BASE}`);
  });
}).catch(err => {
  console.error('Erro fatal na inicialização:', err);
  process.exit(1);
});

// ============================================================
//  eTube — Frontend JavaScript  (script.js)
//  Versão melhorada: proxy local, duração, categorias, delete
// ============================================================

// ── Configuração ─────────────────────────────────────────────
// O frontend nunca fala diretamente com o PeerTube — tudo passa pelo backend.
const SQL_SERVER      = 'http://127.0.0.1:3000';
const EMBED_BASE      = 'https://peertube.tv';   // Altere para a sua instância
const THUMBNAIL_PROXY = `${SQL_SERVER}/api/proxy/thumbnail`;
const VIDEO_PROXY     = `${SQL_SERVER}/api/proxy/video`;

let currentVideo  = null;
let currentUser   = null;
let currentAuthMode = 'login';
let currentSort   = 'recent';

// ── Arranque ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkUserLogin();
  fetchVideos();
  setupEventListeners();
  syncThemeWithBrowser();
  loadCategories();
});

// ── Utilitários ───────────────────────────────────────────────

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatViews(n) {
  if (!n) return '0 visualizações';
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M visualizações`;
  if (n >= 1000)    return `${(n/1000).toFixed(1)}K visualizações`;
  return `${n} visualização${n !== 1 ? 'ões' : ''}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const min  = Math.floor(diff / 60000);
  const h    = Math.floor(diff / 3600000);
  const d    = Math.floor(diff / 86400000);
  const w    = Math.floor(d / 7);
  const mo   = Math.floor(d / 30);
  if (min < 2)   return 'agora mesmo';
  if (min < 60)  return `há ${min} min`;
  if (h < 24)    return `há ${h}h`;
  if (d < 7)     return `há ${d} dia${d>1?'s':''}`;
  if (w < 5)     return `há ${w} semana${w>1?'s':''}`;
  if (mo < 12)   return `há ${mo} ${mo>1?'meses':'mês'}`;
  return `há ${Math.floor(mo/12)} ano${Math.floor(mo/12)>1?'s':''}`;
}

function showToast(msg, type = 'info') {
  let toast = document.getElementById('etubeToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'etubeToast';
    toast.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%) translateY(20px);
      background:#222; color:#fff; padding:10px 20px; border-radius:24px;
      font-size:13px; font-weight:600; z-index:9999; opacity:0;
      transition:all 0.3s ease; pointer-events:none; white-space:nowrap;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'error' ? '#C8102E' : type === 'success' ? '#1a7a2e' : '#222';
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 3000);
}

// ── Autenticação ──────────────────────────────────────────────

function checkUserLogin() {
  try {
    const saved = localStorage.getItem('etube_current_user');
    if (saved) {
      currentUser = JSON.parse(saved);
      renderAuthHeader();
      renderCommentBox();
    }
    renderAdminPanel();
  } catch { localStorage.removeItem('etube_current_user'); }
}

function renderAuthHeader() {
  const authArea = document.getElementById('authArea');
  const uploadBtn = document.getElementById('uploadBtn');
  if (!currentUser || !authArea) return;

  const canPublish = currentUser.canPublish || currentUser.isAdmin;
  if (uploadBtn) uploadBtn.style.display = canPublish ? 'flex' : 'none';

  const inicial = currentUser.username.charAt(0).toUpperCase();
  authArea.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <div class="avatar-sim" style="background:${currentUser.avatar_bg||'#555'};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:14px;cursor:default;" title="${currentUser.email}">${inicial}</div>
      <button id="logoutBtn" style="font-size:12px;color:var(--red);background:none;border:none;cursor:pointer;font-weight:600;">Sair</button>
    </div>`;

  document.getElementById('logoutBtn').addEventListener('click', () => {
    currentUser = null;
    localStorage.removeItem('etube_current_user');
    location.reload();
  });
}

function renderCommentBox() {
  const lock   = document.getElementById('commentLockMessage');
  const fields = document.getElementById('commentFields');
  const avatar = document.getElementById('userCommentAvatar');
  if (!currentUser || !fields || !lock) return;
  lock.style.display   = 'none';
  fields.style.display = 'flex';
  if (avatar) {
    avatar.textContent       = currentUser.username.charAt(0).toUpperCase();
    avatar.style.background  = currentUser.avatar_bg || '#555';
  }
}

function renderAdminPanel() {
  const panel = document.getElementById('adminPanel');
  if (panel) panel.style.display = (currentUser?.isAdmin) ? 'block' : 'none';
}

// ── Categorias ────────────────────────────────────────────────

async function loadCategories() {
  try {
    const res = await fetch(`${SQL_SERVER}/api/categories`);
    if (!res.ok) return;
    const cats = await res.json();
    renderCategoryBar(['Todos', ...cats]);
  } catch { /* silencioso */ }
}

function renderCategoryBar(categories) {
  const bar = document.querySelector('.category-bar');
  if (!bar) return;
  bar.innerHTML = '';
  categories.forEach(cat => {
    const pill = document.createElement('button');
    pill.className = 'category-pill' + (cat === 'Todos' ? ' active' : '');
    pill.textContent = cat;
    pill.addEventListener('click', () => {
      document.querySelectorAll('.category-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      fetchVideos('default', cat === 'Todos' ? '' : cat);
    });
    bar.appendChild(pill);
  });
}

// ── Vídeos ────────────────────────────────────────────────────

async function fetchVideos(mode = 'default', category = '', course = '') {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;
  grid.innerHTML = '<p style="padding:20px;color:#888;">A carregar vídeos...</p>';

  try {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (course)   params.set('course', course);
    params.set('sort', mode === 'trending' ? 'views' : currentSort);

    const res = await fetch(`${SQL_SERVER}/api/videos?${params}`);
    if (!res.ok) throw new Error();
    const videos = await res.json();
    renderVideoGrid(videos);
  } catch {
    grid.innerHTML = '<p style="padding:20px;color:#888;">Erro ao ligar ao servidor. Certifique-se que o servidor está a correr (<code>node server.js</code>).</p>';
  }
}

function renderVideoGrid(videos) {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!videos?.length) {
    grid.innerHTML = '<p style="padding:20px;color:#888;">Nenhum vídeo disponível.</p>';
    return;
  }

  videos.forEach(video => {
    const card = document.createElement('div');
    card.className = 'videoCard';

    const dur      = formatDuration(video.duration);
    const ago      = timeAgo(video.published_at);
    const thumbSrc = `${THUMBNAIL_PROXY}/${video.uuid}`;

    card.innerHTML = `
      <div class="thumbnail" style="position:relative;">
        <img src="${thumbSrc}" alt="${escHtml(video.name)}" loading="lazy"
          onerror="this.src='https://placehold.co/640x360/1a1a1a/888?text=ETube'">
        ${dur ? `<span style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.82);color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;">${dur}</span>` : ''}
        ${video.category ? `<span class="video-tag-cat">${escHtml(video.category)}</span>` : ''}
      </div>
      <div class="info">
        <h3 title="${escHtml(video.name)}">${escHtml(video.name)}</h3>
        <p>@${escHtml(video.username)}${video.course ? ` · ${escHtml(video.course)}` : ''}</p>
        <p style="font-size:11px;color:#999;">${formatViews(video.views)}${ago ? ' · ' + ago : ''}</p>
      </div>
      ${currentUser?.isAdmin ? `<button class="delete-video-btn" data-uuid="${video.uuid}" title="Apagar vídeo" style="position:absolute;top:8px;left:8px;background:rgba(200,16,46,.9);color:#fff;border:none;border-radius:50%;width:26px;height:26px;cursor:pointer;font-size:13px;display:none;">✕</button>` : ''}
    `;

    card.style.position = 'relative';

    // Mostrar botão de apagar ao passar o rato (admin)
    if (currentUser?.isAdmin) {
      const delBtn = card.querySelector('.delete-video-btn');
      card.addEventListener('mouseenter', () => delBtn && (delBtn.style.display = 'flex'));
      card.addEventListener('mouseleave', () => delBtn && (delBtn.style.display = 'none'));
      delBtn?.addEventListener('click', e => { e.stopPropagation(); deleteVideo(video.uuid, video.name); });
    }

    card.addEventListener('click', () => openVideo(video.uuid));
    grid.appendChild(card);
  });
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function deleteVideo(uuid, name) {
  if (!confirm(`Apagar o vídeo "${name}"? Esta ação não pode ser desfeita.`)) return;
  try {
    const res = await fetch(`${SQL_SERVER}/api/videos/${uuid}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentUser.email })
    });
    if (res.ok) {
      showToast('Vídeo apagado.', 'success');
      fetchVideos();
    } else {
      const d = await res.json();
      showToast(d.error || 'Erro ao apagar.', 'error');
    }
  } catch {
    showToast('Erro de ligação.', 'error');
  }
}

// ── Abrir / Reproduzir Vídeo ──────────────────────────────────

async function openVideo(uuid) {
  const homePage = document.getElementById('homePage');
  const watchPage = document.getElementById('watchPage');
  if (!homePage || !watchPage) return;

  homePage.style.display  = 'none';
  watchPage.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  currentVideo = { uuid, title: 'A carregar...', username: 'ETube' };

  // Player — embed do PeerTube
  const player = document.getElementById('mainPlayer');
  if (player) {
    player.innerHTML = `<iframe
      src="${EMBED_BASE}/videos/embed/${uuid}?autoplay=1&warningTitle=0&peertubeLink=0&title=0&controlBar=1"
      style="width:100%;height:100%;border:none;"
      allowfullscreen
      sandbox="allow-same-origin allow-scripts allow-popups">
    </iframe>`;
  }

  // Metadados via proxy (evita CORS)
  const titleEl = document.getElementById('videoTitle');
  const metaEl  = document.getElementById('videoMeta');
  if (titleEl) titleEl.textContent = 'A carregar...';
  if (metaEl)  metaEl.textContent  = '';

  try {
    const res = await fetch(`${VIDEO_PROXY}/${uuid}`);
    if (res.ok) {
      const data = await res.json();
      const title    = data.name || 'Vídeo Local';
      const views    = formatViews(data.views);
      const duration = formatDuration(data.duration);
      const pubDate  = timeAgo(data.publishedAt);
      const channel  = data.channel?.displayName || data.account?.name || 'ETube';

      if (titleEl) titleEl.textContent = title;
      if (metaEl)  metaEl.innerHTML = `
        <span>${views}</span>
        ${duration ? `<span style="margin-left:10px;">⏱ ${duration}</span>` : ''}
        ${pubDate   ? `<span style="margin-left:10px;color:#999;">${pubDate}</span>` : ''}
        <span style="margin-left:10px;color:#999;">por ${escHtml(channel)}</span>`;

      currentVideo.title    = title;
      currentVideo.username = channel;
    }
  } catch { /* PeerTube offline — mostra título da BD local */ }

  // Fallback: título da BD local
  if (currentVideo.title === 'A carregar...') {
    try {
      const res = await fetch(`${SQL_SERVER}/api/videos?search=${uuid}`);
      const list = await res.json();
      const local = list.find(v => v.uuid === uuid);
      if (local) {
        currentVideo.title    = local.name;
        currentVideo.username = local.username;
        if (titleEl) titleEl.textContent = local.name;
        if (metaEl)  metaEl.textContent  = `${formatViews(local.views)} · ${local.category || ''}`;
      }
    } catch { /* silencioso */ }
  }

  // Incrementar visualização
  fetch(`${SQL_SERVER}/api/videos/${uuid}/view`, { method: 'POST' }).catch(() => {});

  saveWatchHistory(currentVideo);
  loadComments(uuid);
  loadRecommended(uuid);
  setActiveSidebar('');
}

function saveWatchHistory(entry) {
  if (!entry?.uuid) return;
  try {
    const history = JSON.parse(localStorage.getItem('etube_watch_history') || '[]');
    const idx = history.findIndex(i => i.uuid === entry.uuid);
    if (idx !== -1) history.splice(idx, 1);
    history.unshift({ uuid: entry.uuid, title: entry.title, username: entry.username, viewedAt: new Date().toISOString() });
    localStorage.setItem('etube_watch_history', JSON.stringify(history.slice(0, 20)));
  } catch { /* silencioso */ }
}

// ── Recomendados ──────────────────────────────────────────────

async function loadRecommended(currentUuid) {
  const container = document.getElementById('recommendedVideos');
  if (!container) return;
  container.innerHTML = '';

  try {
    const res = await fetch(`${SQL_SERVER}/api/videos?sort=recent`);
    if (!res.ok) return;
    const videos = (await res.json()).filter(v => v.uuid !== currentUuid).slice(0, 10);

    videos.forEach(video => {
      const card = document.createElement('div');
      card.className = 'recommended-card';
      card.innerHTML = `
        <img src="${THUMBNAIL_PROXY}/${video.uuid}" alt="${escHtml(video.name)}" loading="lazy"
          onerror="this.src='https://placehold.co/120x72/1a1a1a/888?text=ETube'">
        <div>
          <h4>${escHtml(video.name)}</h4>
          <p>@${escHtml(video.username)}</p>
          <p style="font-size:10px;color:#999;">${formatViews(video.views)}</p>
        </div>`;
      card.addEventListener('click', () => openVideo(video.uuid));
      container.appendChild(card);
    });
  } catch { /* silencioso */ }
}

// ── Histórico ─────────────────────────────────────────────────

function renderHistory() {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;

  let history = [];
  try { history = JSON.parse(localStorage.getItem('etube_watch_history') || '[]'); } catch {}

  if (!history.length) {
    grid.innerHTML = '<p style="padding:20px;color:#888;">Ainda não tens histórico de visualizações.</p>';
    return;
  }

  grid.innerHTML = '';
  history.forEach(item => {
    const card = document.createElement('div');
    card.className = 'videoCard';
    card.innerHTML = `
      <div class="thumbnail">
        <img src="${THUMBNAIL_PROXY}/${item.uuid}" alt="${escHtml(item.title || 'Vídeo')}" loading="lazy"
          onerror="this.src='https://placehold.co/640x360/1a1a1a/888?text=Histórico'">
      </div>
      <div class="info">
        <h3>${escHtml(item.title || 'Vídeo visto')}</h3>
        <p>@${escHtml(item.username || 'ETube')} · ${timeAgo(item.viewedAt)}</p>
      </div>`;
    card.addEventListener('click', () => openVideo(item.uuid));
    grid.appendChild(card);
  });
}

// ── Trending ──────────────────────────────────────────────────

function renderTrending(videos) {
  const sorted = Array.isArray(videos) ? [...videos].sort((a, b) => (b.views||0) - (a.views||0)) : [];
  renderVideoGrid(sorted);
}

// ── Comentários ───────────────────────────────────────────────

async function loadComments(uuid) {
  const container = document.getElementById('commentsList');
  if (!container) return;
  container.innerHTML = '<p style="color:#888;font-size:13px;padding:8px 0;">A carregar comentários...</p>';

  try {
    const res = await fetch(`${SQL_SERVER}/api/comments/${uuid}`);
    if (!res.ok) throw new Error();
    const list = await res.json();
    container.innerHTML = '';

    if (!list.length) {
      container.innerHTML = '<p style="color:#888;font-size:13px;padding:8px 0;">Ainda não há comentários. Seja o primeiro!</p>';
      return;
    }

    list.forEach(c => {
      const item = document.createElement('div');
      item.className = 'comment-item';
      item.innerHTML = `
        <div class="avatar-sim" style="background:${escHtml(c.avatar_bg||'#555')};width:35px;height:35px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:14px;flex-shrink:0;">
          ${escHtml(c.username.charAt(0).toUpperCase())}
        </div>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong style="font-size:13px;">@${escHtml(c.username)}</strong>
            <span style="font-size:11px;color:#999;">${timeAgo(c.created_at)}</span>
            ${currentUser?.isAdmin ? `<button onclick="deleteComment(${c.id},this)" style="background:none;border:none;cursor:pointer;color:#C8102E;font-size:11px;padding:0;">apagar</button>` : ''}
          </div>
          <p style="font-size:13px;margin-top:4px;line-height:1.5;">${escHtml(c.text)}</p>
        </div>`;
      container.appendChild(item);
    });
  } catch {
    container.innerHTML = '<p style="color:#888;font-size:13px;padding:8px 0;">Não foi possível carregar comentários.</p>';
  }
}

async function deleteComment(id, btn) {
  if (!currentUser?.isAdmin) return;
  try {
    const res = await fetch(`${SQL_SERVER}/api/comments/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentUser.email })
    });
    if (res.ok) {
      btn.closest('.comment-item').remove();
      showToast('Comentário apagado.', 'success');
    }
  } catch { showToast('Erro ao apagar.', 'error'); }
}

async function enviarComentarioManual() {
  const input = document.getElementById('commentInput');
  if (!input || !currentVideo || !currentUser) return;
  const text = input.value.trim();
  if (!text) return;

  const submitBtn = document.getElementById('submitComment');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch(`${SQL_SERVER}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_uuid: currentVideo.uuid,
        username:   currentUser.username,
        avatar_bg:  currentUser.avatar_bg,
        text
      })
    });

    if (res.ok) {
      input.value = '';
      const btns = document.querySelector('.form-buttons');
      if (btns) btns.style.display = 'none';
      loadComments(currentVideo.uuid);
      showToast('Comentário publicado!', 'success');
    } else {
      const d = await res.json();
      showToast(d.error || 'Erro ao enviar.', 'error');
    }
  } catch {
    showToast('Erro de ligação ao servidor.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ── Aprovação de Utilizadores ─────────────────────────────────

async function approveUserAccess() {
  const emailInput    = document.getElementById('approveEmailInput');
  const publishCheck  = document.getElementById('approvePublishCheck');
  const channelCheck  = document.getElementById('approveChannelCheck');
  const passwordInput = document.getElementById('approveAdminPassword');
  const message       = document.getElementById('approveUserMessage');
  if (!emailInput || !currentUser) return;

  const targetEmail   = emailInput.value.trim().toLowerCase();
  const adminPassword = passwordInput?.value.trim();

  if (!targetEmail.endsWith('@etpm.pt')) {
    showMessage(message, 'Insira um email válido @etpm.pt.', 'error'); return;
  }
  if (!adminPassword) {
    showMessage(message, 'Informe a palavra-passe do admin.', 'error'); return;
  }

  try {
    const res = await fetch(`${SQL_SERVER}/api/users/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminEmail: currentUser.email,
        adminPassword,
        userEmail: targetEmail,
        publish:       publishCheck?.checked,
        createChannel: channelCheck?.checked
      })
    });
    const data = await res.json();
    if (!res.ok) { showMessage(message, data.error || 'Erro.', 'error'); return; }

    showMessage(message, `✓ Permissões atualizadas para ${data.email}.`, 'success');
    emailInput.value = '';
    if (publishCheck)  publishCheck.checked  = false;
    if (channelCheck)  channelCheck.checked  = false;
    if (passwordInput) passwordInput.value   = '';
  } catch {
    showMessage(message, 'Erro de ligação ao servidor.', 'error');
  }
}

function showMessage(el, text, type) {
  if (!el) return;
  el.textContent    = text;
  el.style.color    = type === 'error' ? '#ff6b6b' : '#7cfc00';
  el.style.display  = 'block';
}

// ── Tema ──────────────────────────────────────────────────────

function syncThemeWithBrowser() {
  const saved    = localStorage.getItem('theme');
  const themeBtn = document.getElementById('themeBtn');
  if (saved === 'light') {
    document.body.classList.remove('dark');
    document.body.classList.add('light');
    if (themeBtn) themeBtn.textContent = '☀️';
  } else {
    document.body.classList.add('dark');
    document.body.classList.remove('light');
    if (themeBtn) themeBtn.textContent = '🌙';
  }
}

// ── Secções / Navegação ───────────────────────────────────────

function setActiveSidebar(activeId) {
  ['btnHome','btnTrending','btnHistory'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === activeId);
  });
}

function showSection(section) {
  const home  = document.getElementById('homePage');
  const watch = document.getElementById('watchPage');
  if (!home || !watch) return;
  watch.style.display = 'none';
  home.style.display  = 'block';

  const titleEl = document.getElementById('pageTitle');
  const map = { home: 'Vídeos em Destaque', trending: 'Tendências', history: 'Histórico de Visualizações' };
  if (titleEl) titleEl.textContent = map[section] || '';

  if (section === 'home')     { fetchVideos(); setActiveSidebar('btnHome'); }
  if (section === 'trending') { fetchVideos('trending'); setActiveSidebar('btnTrending'); }
  if (section === 'history')  { renderHistory(); setActiveSidebar('btnHistory'); }
}

function showCourseSection(course) {
  const home  = document.getElementById('homePage');
  const watch = document.getElementById('watchPage');
  if (!home || !watch) return;
  watch.style.display = 'none';
  home.style.display  = 'block';
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = `Curso ${course}`;
  fetchVideos('default', '', course);
  setActiveSidebar('btnHome');
}

// ── Event Listeners ───────────────────────────────────────────

function setupEventListeners() {
  // Tema
  const themeBtn = document.getElementById('themeBtn');
  themeBtn?.addEventListener('click', () => {
    const isDark = document.body.classList.contains('dark');
    document.body.classList.toggle('dark', !isDark);
    document.body.classList.toggle('light', isDark);
    themeBtn.textContent = isDark ? '☀️' : '🌙';
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
  });

  // Tabs Auth
  const tabLogin    = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const subtitle    = document.getElementById('modalSubtitle');
  const submitBtn   = document.getElementById('modalSubmitBtn');

  tabLogin?.addEventListener('click', () => {
    currentAuthMode = 'login';
    tabLogin.style.cssText    += ';border-bottom:2px solid var(--red);color:var(--text-color);';
    tabRegister.style.cssText += ';border-bottom:none;color:#888;';
    if (subtitle)  subtitle.textContent  = 'Introduza os seus dados para aceder à sua conta.';
    if (submitBtn) submitBtn.textContent = 'Entrar';
  });

  tabRegister?.addEventListener('click', () => {
    currentAuthMode = 'register';
    tabRegister.style.cssText += ';border-bottom:2px solid var(--red);color:var(--text-color);';
    tabLogin.style.cssText    += ';border-bottom:none;color:#888;';
    if (subtitle)  subtitle.textContent  = 'Crie a sua conta institucional @etpm.pt.';
    if (submitBtn) submitBtn.textContent = 'Criar Conta';
  });

  // Modal Auth abrir/fechar
  const authModal   = document.getElementById('authModal');
  const loginBtn    = document.getElementById('loginBtn');
  const inlineLogin = document.getElementById('inlineLoginLink');
  const closeModal  = document.getElementById('closeModalBtn');

  const openAuth  = () => authModal?.classList.add('mostrar');
  const closeAuth = () => { authModal?.classList.remove('mostrar'); clearModalError(); };

  loginBtn?.addEventListener('click', openAuth);
  inlineLogin?.addEventListener('click', e => { e.preventDefault(); openAuth(); });
  closeModal?.addEventListener('click', closeAuth);
  authModal?.addEventListener('click', e => { if (e.target === authModal) closeAuth(); });

  // Modal Upload abrir/fechar
  const uploadBtn        = document.getElementById('uploadBtn');
  const uploadModal      = document.getElementById('uploadModal');
  const closeUploadModal = document.getElementById('closeUploadModalBtn');

  uploadBtn?.addEventListener('click', () => uploadModal?.classList.add('mostrar'));
  closeUploadModal?.addEventListener('click', () => {
    uploadModal?.classList.remove('mostrar');
    clearUploadForm();
  });
  uploadModal?.addEventListener('click', e => { if (e.target === uploadModal) { uploadModal.classList.remove('mostrar'); clearUploadForm(); } });

  // Submit Auth
  submitBtn?.addEventListener('click', handleAuthSubmit);
  document.getElementById('modalPassword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAuthSubmit();
  });

  // Submit Upload
  document.getElementById('submitVideoBtn')?.addEventListener('click', handleVideoSubmit);

  // Navegação
  document.getElementById('logoBtn')?.addEventListener('click', () => showSection('home'));
  document.getElementById('btnHome')?.addEventListener('click', e => { e.preventDefault(); showSection('home'); });
  document.getElementById('btnTrending')?.addEventListener('click', e => { e.preventDefault(); showSection('trending'); });
  document.getElementById('btnHistory')?.addEventListener('click', e => { e.preventDefault(); showSection('history'); });

  // Cursos
  const courseBubble = document.getElementById('courseBubble');
  courseBubble?.addEventListener('click', e => { e.stopPropagation(); courseBubble.classList.toggle('active'); });
  document.querySelectorAll('.course-dropdown-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const course = btn.dataset.course;
      if (course) showCourseSection(course);
      courseBubble?.classList.remove('active');
    });
  });
  document.addEventListener('click', e => {
    if (courseBubble && !courseBubble.contains(e.target)) courseBubble.classList.remove('active');
  });

  // Aprovação admin
  document.getElementById('approveUserBtn')?.addEventListener('click', approveUserAccess);

  // Pesquisa
  const searchInput = document.getElementById('searchInput');
  const searchBtn   = document.getElementById('searchBtn');
  let searchTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(searchInput.value.trim()), 400);
  });
  searchBtn?.addEventListener('click', () => runSearch(searchInput?.value.trim() || ''));
  searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(searchInput.value.trim()); });

  // Comentários
  const commentInput = document.getElementById('commentInput');
  const formButtons  = document.querySelector('.form-buttons');
  const cancelBtn    = document.getElementById('cancelComment');
  const submitComment = document.getElementById('submitComment');

  commentInput?.addEventListener('focus', () => { if (formButtons) formButtons.style.display = 'flex'; });
  cancelBtn?.addEventListener('click', () => {
    if (commentInput) commentInput.value = '';
    if (formButtons) formButtons.style.display = 'none';
  });
  submitComment?.addEventListener('click', enviarComentarioManual);
  commentInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) enviarComentarioManual();
  });

  // Ordenação
  document.querySelector('.sort-select')?.addEventListener('change', e => {
    currentSort = e.target.value;
    fetchVideos();
  });
}

async function runSearch(q) {
  const home  = document.getElementById('homePage');
  const watch = document.getElementById('watchPage');
  const grid  = document.getElementById('videoGrid');
  const title = document.getElementById('pageTitle');

  if (!home || !grid) return;
  if (watch) watch.style.display = 'none';
  home.style.display = 'block';
  setActiveSidebar('');

  if (!q) { fetchVideos(); if (title) title.textContent = 'Vídeos em Destaque'; return; }

  if (title) title.textContent = `Resultados para "${q}"`;
  grid.innerHTML = '<p style="padding:20px;color:#888;">A pesquisar...</p>';

  try {
    const res = await fetch(`${SQL_SERVER}/api/videos?search=${encodeURIComponent(q)}`);
    const videos = await res.json();
    renderVideoGrid(videos);
  } catch {
    grid.innerHTML = '<p style="padding:20px;color:#888;">Erro na pesquisa.</p>';
  }
}

// ── Auth Submit ───────────────────────────────────────────────

async function handleAuthSubmit() {
  const emailVal    = document.getElementById('modalEmail')?.value.trim();
  const passwordVal = document.getElementById('modalPassword')?.value.trim();
  const errorMsg    = document.getElementById('modalError');
  const submitBtn   = document.getElementById('modalSubmitBtn');

  clearModalError();

  if (!emailVal || !passwordVal) {
    setModalError('Preencha todos os campos.'); return;
  }
  if (!emailVal.toLowerCase().endsWith('@etpm.pt')) {
    setModalError('O email deve terminar em @etpm.pt.'); return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'A carregar...'; }

  try {
    const res = await fetch(`${SQL_SERVER}/api/auth/validate-and-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: emailVal, password: passwordVal, mode: currentAuthMode })
    });
    const data = await res.json();

    if (!res.ok) {
      setModalError(data.error || 'Erro de validação.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = currentAuthMode === 'login' ? 'Entrar' : 'Criar Conta'; }
      return;
    }

    localStorage.setItem('etube_current_user', JSON.stringify(data));
    document.getElementById('authModal')?.classList.remove('mostrar');
    location.reload();
  } catch {
    setModalError('Erro: O servidor não está acessível (porta 3000).');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = currentAuthMode === 'login' ? 'Entrar' : 'Criar Conta'; }
  }
}

function setModalError(msg) {
  const el = document.getElementById('modalError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function clearModalError() {
  const el = document.getElementById('modalError');
  if (el) el.style.display = 'none';
}

// ── Video Submit ──────────────────────────────────────────────

async function handleVideoSubmit() {
  const titleInput  = document.getElementById('videoTitleInput');
  const urlInput    = document.getElementById('videoUrlInput');
  const catInput    = document.getElementById('videoCategoryInput');
  const courseInput = document.getElementById('videoCourseInput');
  const uploadError = document.getElementById('uploadError');

  if (!titleInput || !urlInput || !currentUser) return;

  const title = titleInput.value.trim();
  let   uuid  = urlInput.value.trim();

  // Extrai UUID se for URL completo (ex: https://peertube.tv/videos/watch/abc-123)
  const matchUuid = uuid.match(/(?:videos\/watch\/|videos\/embed\/)([a-zA-Z0-9_-]{8,})/);
  if (matchUuid) uuid = matchUuid[1];

  if (!title || !uuid) {
    if (uploadError) { uploadError.textContent = 'Preencha o título e o ID/URL do vídeo.'; uploadError.style.display = 'block'; }
    return;
  }

  const submitBtn = document.getElementById('submitVideoBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'A publicar...'; }

  try {
    const res = await fetch(`${SQL_SERVER}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid,
        name:        title,
        email:       currentUser.email,
        category:    catInput?.value.trim()   || 'Geral',
        course:      courseInput?.value.trim() || '',
      })
    });
    const data = await res.json();

    if (!res.ok) {
      if (uploadError) { uploadError.textContent = data.error || 'Erro ao publicar.'; uploadError.style.display = 'block'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Publicar na Grelha'; }
      return;
    }

    document.getElementById('uploadModal')?.classList.remove('mostrar');
    clearUploadForm();
    showToast('Vídeo publicado com sucesso!', 'success');
    fetchVideos();
  } catch {
    if (uploadError) { uploadError.textContent = 'Erro de ligação ao servidor.'; uploadError.style.display = 'block'; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Publicar na Grelha'; }
  }
}

function clearUploadForm() {
  ['videoTitleInput','videoUrlInput','videoCategoryInput','videoCourseInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const err = document.getElementById('uploadError');
  if (err) err.style.display = 'none';
  const btn = document.getElementById('submitVideoBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Publicar na Grelha'; }
}

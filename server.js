'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

function id(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function token(prefix = 'tok') {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function timeHuman() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const seedRooms = [
  {
    id: 'room_navigation',
    title: 'Навигация по продуктам',
    subtitle: 'Актуальный перечень продуктов с мотивацией',
    category: 'Главная витрина',
    image: '/assets/nav-products.png'
  },
  {
    id: 'room_permanent_shelf',
    title: 'Постоянная полка',
    subtitle: 'Действующие продукты и готовые предложения',
    category: 'Продуктовая полка',
    image: '/assets/permanent-shelf.png'
  },
  {
    id: 'room_service_products',
    title: 'Сервисные продукты',
    subtitle: 'Юридические, финансовые и сопровождающие решения',
    category: 'Сервисы',
    image: '/assets/service-products.png'
  },
  {
    id: 'room_realty_partners',
    title: 'Партнеры по подбору недвижимости',
    subtitle: 'Подбор недвижимости и партнёрские направления',
    category: 'Недвижимость',
    image: '/assets/realty-partners.png'
  },
  {
    id: 'room_community_exclusives',
    title: 'Эксклюзивы комьюнити',
    subtitle: 'Закрытые возможности и специальные проекты',
    category: 'Эксклюзивы',
    image: '/assets/community-exclusives.png'
  },
  {
    id: 'room_referral',
    title: 'Комьюнити и реферальная программа',
    subtitle: 'Дополнительная мотивация для партнёров',
    category: 'Комьюнити',
    image: '/assets/referral-community.png'
  }
];

let db = loadDb();
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || db.adminSecret || '').trim();
const adminSessions = new Map();
const sseClients = new Map(); // roomId -> Set(client)

function loadDb() {
  ensureDir();
  let loaded = null;
  if (fs.existsSync(DB_PATH)) {
    try { loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { loaded = null; }
  }
  const base = loaded || { rooms: [], createdAt: nowIso() };
  base.rooms = Array.isArray(base.rooms) ? base.rooms : [];
  if (!base.adminSecret) base.adminSecret = token('adminlink');

  for (const seed of seedRooms) {
    let room = base.rooms.find(r => r.id === seed.id);
    if (!room) {
      room = {
        ...seed,
        createdAt: nowIso(),
        messages: [],
        invites: [],
        securityEvents: []
      };
      base.rooms.push(room);
    } else {
      room.title = room.title || seed.title;
      room.subtitle = room.subtitle || seed.subtitle;
      room.category = room.category || seed.category;
      room.image = room.image || seed.image;
      room.messages = Array.isArray(room.messages) ? room.messages : [];
      room.invites = Array.isArray(room.invites) ? room.invites : [];
      room.securityEvents = Array.isArray(room.securityEvents) ? room.securityEvents : [];
      room.bannedTerms = Array.isArray(room.bannedTerms) ? room.bannedTerms : [];
      room.allowImages = Boolean(room.allowImages);
    }
    ensureInviteMeta(room);
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(base, null, 2));
  return base;
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function roomById(roomId) {
  return db.rooms.find(r => r.id === roomId);
}

function ensureInviteMeta(room) {
  room.invites = Array.isArray(room.invites) ? room.invites : [];
  let changed = false;
  for (let i = 0; i < room.invites.length; i++) {
    const inv = room.invites[i];
    if (!inv.publicCode) {
      inv.publicCode = `U-${String(i + 1).padStart(3, '0')}`;
      changed = true;
    }
  }
  return changed;
}

function onlineState(roomId) {
  const set = sseClients.get(roomId) || new Set();
  const participants = new Map();
  let admins = 0;
  for (const client of set) {
    if (client.role === 'admin') { admins += 1; continue; }
    if (!client.inviteToken) continue;
    const found = findInvite(client.inviteToken);
    if (!found) continue;
    participants.set(client.inviteToken, {
      token: client.inviteToken,
      label: found.invite.label,
      publicCode: found.invite.publicCode || null,
      connectedAt: client.createdAt
    });
  }
  return {
    roomId,
    totalOnline: participants.size + admins,
    participantOnline: participants.size,
    adminOnline: admins,
    participants: Array.from(participants.values()).sort((a,b)=>a.label.localeCompare(b.label,'ru'))
  };
}

function sendPresence(roomId) {
  const presence = onlineState(roomId);
  broadcast(roomId, { type: 'presence', presence });
}

function findInvite(inviteToken) {
  for (const room of db.rooms) {
    const invite = (room.invites || []).find(i => i.token === inviteToken);
    if (invite) return { room, invite };
  }
  return null;
}

function normalizeSessionId(value) {
  return String(value || '').trim().slice(0, 120);
}

function checkInviteSession(invite, sessionId) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return { ok: false, error: 'Нет идентификатора устройства' };
  if (invite.sessionId && invite.sessionId !== sid) {
    return { ok: false, error: 'Эта ссылка уже используется другим участником', alreadyUsed: true };
  }
  return { ok: true, sessionId: sid };
}

function lockInviteSession(invite, sessionId) {
  const check = checkInviteSession(invite, sessionId);
  if (!check.ok) return check;
  if (!invite.sessionId) {
    invite.sessionId = check.sessionId;
    invite.sessionLockedAt = nowIso();
  }
  invite.lastSeenAt = nowIso();
  return check;
}

function publicRoom(room, invite) {
  const presence = onlineState(room.id);
  return {
    id: room.id,
    title: room.title,
    subtitle: room.subtitle,
    category: room.category,
    image: room.image,
    blocked: Boolean(invite && invite.blocked),
    inviteToken: invite ? invite.token : null,
    inviteLabel: invite ? invite.label : null,
    inviteCode: invite ? (invite.publicCode || null) : null,
    termsAccepted: Boolean(invite && invite.termsAcceptedAt),
    onlineCount: presence.totalOnline,
    participantOnline: presence.participantOnline,
    messages: room.messages.map(m => publicMessageForParticipant(m, invite ? invite.token : null))
  };
}

function adminRoom(room) {
  const presence = onlineState(room.id);
  return {
    ...room,
    onlineCount: presence.totalOnline,
    participantOnline: presence.participantOnline,
    adminOnline: presence.adminOnline,
    inviteUrlBase: '/join/'
  };
}

function publicMessageForParticipant(m, inviteToken = null) {
  if (m.kind === 'security') {
    return {
      id: m.id,
      kind: 'security',
      role: 'system',
      text: 'Система заблокировала попытку обмена контактными данными.',
      time: m.time,
      ts: m.ts
    };
  }
  if (m.role === 'admin') {
    return { id: m.id, role: 'admin', text: m.text, time: m.time, ts: m.ts };
  }
  return {
    id: m.id,
    role: 'participant',
    own: Boolean(inviteToken && m.authorToken === inviteToken),
    authorCode: m.authorCode || null,
    text: m.text,
    time: m.time,
    ts: m.ts
  };
}

function formatPayloadForClient(client, payload) {
  if (payload.type === 'message' && payload.message) {
    if (client.role === 'admin') return payload;
    return { ...payload, message: publicMessageForParticipant(payload.message, client.inviteToken) };
  }
  return payload;
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store'
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error('Слишком большой запрос'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const raw = req.headers['x-admin-token'] || req.headers['authorization'] || '';
  const header = String(raw).startsWith('Bearer ') ? String(raw).slice(7) : String(raw);
  if (!header) return false;
  const session = adminSessions.get(String(header));
  if (!session) return false;
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 12) {
    adminSessions.delete(String(header));
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    sendJson(res, 401, { error: 'Нужен администраторский доступ' });
    return false;
  }
  return true;
}

function detectContact(text, room = null) {
  const value = String(text || '').toLowerCase();
  const raw = String(text || '');

  const checks = [
    ['email', /[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}/i],
    ['ссылка', /(https?:\/\/|www\.|\.ru\b|\.com\b|\.net\b|\.org\b|\.io\b|\.me\b|\.рф\b|t\.me|wa\.me)/i],
    ['телефон', /(\+?\d[\d\s()\-]{8,}\d)/],
    ['ник или соцсеть', /(^|\s)@[a-zа-яё0-9_.]{3,}/i],
    ['мессенджер или контакт', /(telegram|телеграм|телега|whatsapp|ватсап|вацап|viber|вайбер|instagram|инстаграм|insta|vk|вконтакте|почта|email|e-mail|номер|телефон|созвон|напиши мне|мой контакт|мой ник|мой тг|тг|личка|личку)/i],
    ['разбитый телефон', /(?:\d[\s\-.]*){9,}/],
    ['ФИО или имя человека', /(^|[^А-Яа-яЁё])(?:меня\s+зовут\s+)?[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё]{2,})?(?=$|[^А-Яа-яЁё])/],
    ['название компании или юрлица', /\b(ооо|ао|пао|зао|ип|огрн|инн|кпп|общество с ограниченной ответственностью|компания|бренд|название компании|клиент называется)\b/i],
    ['адрес или локация', /\b(адрес|улица|ул\.|проспект|пр-т|переулок|дом\s*\d|д\.\s*\d|корпус|к\.\s*\d|офис|этаж|бц|бизнес-центр|жк|жилой комплекс)\b/i],
    ['паспортные или регистрационные данные', /\b(паспорт|серия|номер паспорта|снилс|инн|огрн|кпп|р\/с|расчетный счет|бик)\b/i]
  ];

  if (room && Array.isArray(room.bannedTerms)) {
    for (const term of room.bannedTerms) {
      const t = String(term || '').trim().toLowerCase();
      if (t && value.includes(t)) return `запрещённое слово/название: ${term}`;
    }
  }

  const found = checks.find(([, re]) => re.test(raw));
  return found ? found[0] : null;
}

function sanitizeAttempt(text) {
  return String(text || '')
    .replace(/[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}/gi, '[email скрыт]')
    .replace(/(https?:\/\/\S+|www\.\S+|t\.me\/\S+|wa\.me\/\S+)/gi, '[ссылка скрыта]')
    .replace(/\+?\d[\d\s()\-]{8,}\d/g, '[телефон скрыт]')
    .replace(/(^|\s)@[a-zа-яё0-9_.]{3,}/gi, ' [ник скрыт]');
}

function broadcast(roomId, payload, predicate = null) {
  const set = sseClients.get(roomId);
  if (!set) return;
  for (const client of set) {
    if (predicate && !predicate(client)) continue;
    try {
      const outgoing = formatPayloadForClient(client, payload);
      client.res.write(`event: ${outgoing.type}\n`);
      client.res.write(`data: ${JSON.stringify(outgoing)}\n\n`);
    } catch (e) {
      set.delete(client);
    }
  }
}

function addMessage(room, message) {
  room.messages.push(message);
  saveDb();
  broadcast(room.id, { type: 'message', message });
}

function addSecurityEvent(room, invite, reason, rawText) {
  invite.blocked = true;
  invite.blockedAt = nowIso();
  const event = {
    id: id('security'),
    type: 'blocked_contact_attempt',
    roomId: room.id,
    inviteToken: invite.token,
    inviteLabel: invite.label,
    reason,
    sanitized: sanitizeAttempt(rawText),
    rawText: String(rawText || '').slice(0, 2000),
    time: timeHuman(),
    ts: Date.now(),
    createdAt: nowIso()
  };
  room.securityEvents.push(event);
  const securityMessage = {
    id: id('msg'),
    kind: 'security',
    role: 'system',
    authorToken: null,
    authorLabel: 'Система безопасности',
    text: `Попытка обмена контактами заблокирована. Участник: ${invite.label}. Причина: ${reason}. Фрагмент для админа: ${event.rawText}`,
    time: event.time,
    ts: event.ts
  };
  room.messages.push(securityMessage);
  saveDb();

  broadcast(room.id, { type: 'message', message: securityMessage });
  broadcast(room.id, { type: 'blocked', inviteToken: invite.token, event }, c => c.inviteToken === invite.token);
  broadcast(room.id, { type: 'security', event }, c => c.role === 'admin');
  return event;
}

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/join/')) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else {
    filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, app: 'private-community-chat', adminLink: '/admin/' + encodeURIComponent(ADMIN_SECRET) });
    }

    if (req.method === 'POST' && pathname === '/api/admin/session') {
      const body = await readBody(req);
      const submittedSecret = String(body.secret || '').trim();
      if (!submittedSecret || submittedSecret !== ADMIN_SECRET) {
        return sendJson(res, 403, { error: 'Администраторская ссылка недействительна' });
      }
      const sessionToken = token('admin');
      adminSessions.set(sessionToken, { createdAt: Date.now() });
      return sendJson(res, 200, { ok: true, token: sessionToken });
    }

    if (req.method === 'GET' && pathname === '/api/admin/rooms') {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, { rooms: db.rooms.map(adminRoom) });
    }

    if (req.method === 'POST' && pathname === '/api/admin/rooms') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const title = String(body.title || '').trim() || 'Новый чат';
      const room = {
        id: id('room'),
        title,
        subtitle: String(body.subtitle || '').trim() || 'Закрытое анонимное обсуждение',
        category: String(body.category || '').trim() || 'Пользовательский чат',
        image: String(body.image || '').trim() || '/assets/hero.jpg',
        bannedTerms: Array.isArray(body.bannedTerms) ? body.bannedTerms.map(String).filter(Boolean) : [],
        allowImages: Boolean(body.allowImages),
        createdAt: nowIso(),
        messages: [],
        invites: [],
        securityEvents: []
      };
      db.rooms.unshift(room);
      saveDb();
      return sendJson(res, 200, { room: adminRoom(room) });
    }

    const inviteMatch = pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/invites$/);
    if (req.method === 'POST' && inviteMatch) {
      if (!requireAdmin(req, res)) return;
      const room = roomById(inviteMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'Чат не найден' });
      const body = await readBody(req);
      const count = Math.max(1, Math.min(50, Number(body.count || 1)));
      const baseLabel = String(body.label || '').trim() || 'Участник';
      const created = [];
      for (let i = 0; i < count; i++) {
        const nextIndex = room.invites.length + 1;
        const invite = {
          token: token('invite'),
          label: count === 1 ? baseLabel : `${baseLabel} ${nextIndex}`,
          publicCode: `U-${String(nextIndex).padStart(3, '0')}`,
          createdAt: nowIso(),
          blocked: false,
          termsAcceptedAt: null
        };
        room.invites.push(invite);
        created.push(invite);
      }
      saveDb();
      return sendJson(res, 200, { invites: created, room: adminRoom(room) });
    }


    const updateRoomMatch = pathname.match(/^\/api\/admin\/rooms\/([^/]+)$/);
    if (req.method === 'PATCH' && updateRoomMatch) {
      if (!requireAdmin(req, res)) return;
      const room = roomById(updateRoomMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'Чат не найден' });
      const body = await readBody(req);
      if ('title' in body) room.title = String(body.title || '').trim() || room.title;
      if ('subtitle' in body) room.subtitle = String(body.subtitle || '').trim();
      if ('category' in body) room.category = String(body.category || '').trim();
      if ('image' in body) room.image = String(body.image || '').trim() || '/assets/hero.jpg';
      if ('bannedTerms' in body) {
        room.bannedTerms = Array.isArray(body.bannedTerms)
          ? body.bannedTerms.map(v => String(v).trim()).filter(Boolean).slice(0, 200)
          : String(body.bannedTerms || '').split('\n').map(v => v.trim()).filter(Boolean).slice(0, 200);
      }
      if ('allowImages' in body) room.allowImages = Boolean(body.allowImages);
      saveDb();
      return sendJson(res, 200, { room: adminRoom(room) });
    }

    const securityMatch = pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/security$/);
    if (req.method === 'GET' && securityMatch) {
      if (!requireAdmin(req, res)) return;
      const room = roomById(securityMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'Чат не найден' });
      return sendJson(res, 200, { events: room.securityEvents || [] });
    }

    const deleteMatch = pathname.match(/^\/api\/admin\/rooms\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      if (!requireAdmin(req, res)) return;
      const roomId = deleteMatch[1];
      const room = roomById(roomId);
      if (!room) return sendJson(res, 404, { error: 'Чат не найден' });
      db.rooms = db.rooms.filter(r => r.id !== roomId);
      saveDb();
      broadcast(roomId, { type: 'room_deleted' });
      return sendJson(res, 200, { ok: true });
    }

    const clearMatch = pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/clear$/);
    if (req.method === 'POST' && clearMatch) {
      if (!requireAdmin(req, res)) return;
      const room = roomById(clearMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'Чат не найден' });
      room.messages = [];
      room.securityEvents = [];
      saveDb();
      broadcast(room.id, { type: 'clear' });
      return sendJson(res, 200, { ok: true, room: adminRoom(room) });
    }

    const adminSendMatch = pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/send$/);
    if (req.method === 'POST' && adminSendMatch) {
      if (!requireAdmin(req, res)) return;
      const room = roomById(adminSendMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'Чат не найден' });
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });
      const message = {
        id: id('msg'),
        role: 'admin',
        authorToken: null,
        authorLabel: 'Администратор',
        text: text.slice(0, 2000),
        time: timeHuman(),
        ts: Date.now()
      };
      addMessage(room, message);
      return sendJson(res, 200, { message });
    }

    const inviteInfoMatch = pathname.match(/^\/api\/invite\/([^/]+)$/);
    if (req.method === 'GET' && inviteInfoMatch) {
      const found = findInvite(inviteInfoMatch[1]);
      if (!found) return sendJson(res, 404, { error: 'Приглашение не найдено' });
      const sessionId = normalizeSessionId(url.searchParams.get('session'));
      if (found.invite.sessionId && sessionId && found.invite.sessionId !== sessionId) {
        return sendJson(res, 403, { error: 'Эта ссылка уже занята другим участником', alreadyUsed: true });
      }
      return sendJson(res, 200, { room: publicRoom(found.room, found.invite) });
    }

    if (req.method === 'POST' && pathname === '/api/accept-terms') {
      const body = await readBody(req);
      const inviteToken = String(body.token || '');
      const accepted = Boolean(body.accepted);
      const found = findInvite(inviteToken);
      if (!found) return sendJson(res, 404, { error: 'Приглашение не найдено' });
      if (found.invite.blocked) return sendJson(res, 403, { error: 'Доступ закрыт', blocked: true });
      const locked = lockInviteSession(found.invite, body.sessionId);
      if (!locked.ok) return sendJson(res, 403, { error: locked.error, alreadyUsed: locked.alreadyUsed });
      if (!accepted) return sendJson(res, 400, { error: 'Необходимо принять условия' });
      found.invite.termsAcceptedAt = found.invite.termsAcceptedAt || nowIso();
      found.invite.termsAcceptedIp = req.socket.remoteAddress || '';
      found.invite.termsAcceptedUserAgent = String(req.headers['user-agent'] || '').slice(0, 300);
      saveDb();
      return sendJson(res, 200, { ok: true, room: publicRoom(found.room, found.invite) });
    }

    if (req.method === 'POST' && pathname === '/api/my-rooms') {
      const body = await readBody(req);
      const tokens = Array.isArray(body.tokens) ? body.tokens.map(String) : [];
      const rooms = [];
      for (const t of tokens) {
        const found = findInvite(t);
        if (found) rooms.push(publicRoom(found.room, found.invite));
      }
      return sendJson(res, 200, { rooms });
    }

    if (req.method === 'POST' && pathname === '/api/send') {
      const body = await readBody(req);
      const inviteToken = String(body.token || '');
      const text = String(body.text || '').trim();
      const found = findInvite(inviteToken);
      if (!found) return sendJson(res, 404, { error: 'Приглашение не найдено' });
      if (found.invite.blocked) return sendJson(res, 403, { error: 'Доступ закрыт', blocked: true });
      const locked = checkInviteSession(found.invite, body.sessionId);
      if (!locked.ok) return sendJson(res, 403, { error: locked.error, alreadyUsed: locked.alreadyUsed });
      if (!found.invite.termsAcceptedAt) return sendJson(res, 403, { error: 'Необходимо принять условия участия', termsRequired: true });
      if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

      const violation = detectContact(text, found.room);
      if (violation) {
        const event = addSecurityEvent(found.room, found.invite, violation, text);
        return sendJson(res, 403, { error: 'Контактные данные запрещены', blocked: true, event });
      }

      const message = {
        id: id('msg'),
        role: 'participant',
        authorToken: found.invite.token,
        authorLabel: found.invite.label,
        authorCode: found.invite.publicCode || null,
        text: text.slice(0, 2000),
        time: timeHuman(),
        ts: Date.now()
      };
      addMessage(found.room, message);
      return sendJson(res, 200, { message: publicMessageForParticipant(message, found.invite.token) });
    }

    if (req.method === 'GET' && pathname === '/events') {
      const roomId = String(url.searchParams.get('roomId') || '');
      const role = String(url.searchParams.get('role') || 'participant');
      const room = roomById(roomId);
      if (!room) {
        res.writeHead(404); res.end('room not found'); return;
      }

      let inviteToken = null;
      if (role === 'admin') {
        const session = String(url.searchParams.get('session') || '');
        if (!adminSessions.has(session)) { res.writeHead(401); res.end('unauthorized'); return; }
      } else {
        inviteToken = String(url.searchParams.get('token') || '');
        const found = findInvite(inviteToken);
        if (!found || found.room.id !== roomId || found.invite.blocked) {
          res.writeHead(403); res.end('blocked or invalid'); return;
        }
        const sessionId = normalizeSessionId(url.searchParams.get('session'));
        const locked = checkInviteSession(found.invite, sessionId);
        if (!locked.ok) { res.writeHead(403); res.end('already used'); return; }
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      const client = { res, roomId, role, inviteToken, createdAt: Date.now() };
      if (!sseClients.has(roomId)) sseClients.set(roomId, new Set());
      sseClients.get(roomId).add(client);
      const initialPresence = formatPayloadForClient(client, { type: 'presence', presence: onlineState(roomId) });
      client.res.write(`event: ${initialPresence.type}
`);
      client.res.write(`data: ${JSON.stringify(initialPresence)}

`);
      sendPresence(roomId);
      req.on('close', () => {
        const set = sseClients.get(roomId);
        if (set) set.delete(client);
        sendPresence(roomId);
      });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || 'Ошибка сервера' });
  }
}

const server = http.createServer(route);

function startServer(port) {
  server.listen(port, () => {
    const actualPort = server.address().port;
    console.log(`Private Community chat is running: http://localhost:${actualPort}`);
    const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${actualPort}`;
    console.log(`Admin link: ${publicUrl}/admin/${ADMIN_SECRET}`);
    console.log('Keep this admin link private. Change with ADMIN_SECRET=...');
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && Number(PORT) !== 0) {
    console.log(`Port ${PORT} is busy. Trying a free port automatically...`);
    startServer(0);
    return;
  }
  console.error(err);
  process.exit(1);
});

startServer(PORT);

// AI Video Assets Worker v3 — batch, tags, relations, usage, search
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    const C = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: C });
    const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', ...C } });
    const E = (msg, s = 400) => J({ error: msg }, s);

    try {
      if (m === 'GET' && p === '/api/assets') return handleList(url, env, J);
      if (m === 'POST' && p === '/api/assets') return handleUpload(request, env, J, E);
      if (m === 'POST' && p === '/api/assets/batch') return handleBatchUpload(request, env, J, E);
      if (m === 'PUT' && p.startsWith('/api/assets/') && p.endsWith('/usage')) return handleUsage(p, request, env, J, E);
      if (m === 'PUT' && p.startsWith('/api/assets/') && p.endsWith('/relations')) return handleRelations(p, request, env, J, E);
      const dm = p.match(/^\/api\/assets\/(.+)\/download$/);
      if (m === 'GET' && dm) return handleDownload(dm[1], env, E);
      const del = p.match(/^\/api\/assets\/(.+)$/);
      if (m === 'DELETE' && del) return handleDelete(del[1], env, J, E);
      return J({ ok: true, version: 'v3' });
    } catch (e) {
      console.error(e);
      return E('服务器错误: ' + (e.message || '未知'), 500);
    }
  },
};

// ===== Auto-migrate schema =====
async function ensureSchema(env) {
  const migrations = [
    "ALTER TABLE assets ADD COLUMN tags TEXT DEFAULT '[]'",
    "ALTER TABLE assets ADD COLUMN related_assets TEXT DEFAULT '[]'",
    "ALTER TABLE assets ADD COLUMN usage_history TEXT DEFAULT '[]'",
  ];
  for (const sql of migrations) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* column exists */ }
  }
}

// ===== Helpers =====
function ghHeaders(env) { return { 'Authorization': 'Bearer ' + env.GH_TOKEN, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ai-video-worker' }; }
async function gh(env, path, opts = {}) {
  const h = ghHeaders(env);
  if (opts.body && typeof opts.body === 'string') h['Content-Type'] = 'application/json';
  const r = await fetch('https://api.github.com' + path, { ...opts, headers: h });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || 'GitHub error ' + r.status);
  return d;
}
function b64(buf) { const B = new Uint8Array(buf); const C = []; for (let i = 0; i < B.length; i += 8192) C.push(String.fromCharCode(...B.slice(i, i + 8192))); return btoa(C.join('')); }

// ===== List with search =====
async function handleList(url, env, J) {
  await ensureSchema(env);
  const type = url.searchParams.get('type') || '';
  const search = url.searchParams.get('search') || '';
  const dateFrom = url.searchParams.get('dateFrom') || '';
  const dateTo = url.searchParams.get('dateTo') || '';
  const tag = url.searchParams.get('tag') || '';

  let q = 'SELECT * FROM assets WHERE 1=1';
  const params = [];

  if (type) { q += ' AND type = ?' + (params.length + 1); params.push(type); }
  if (search) { q += ' AND (name LIKE ?' + (params.length + 1) + ' OR owner LIKE ?' + (params.length + 2) + ' OR note LIKE ?' + (params.length + 3) + ' OR tags LIKE ?' + (params.length + 4) + ')'; params.push('%' + search + '%', '%' + search + '%', '%' + search + '%', '%' + search + '%'); }
  if (dateFrom) { q += ' AND created_at >= ?' + (params.length + 1); params.push(dateFrom); }
  if (dateTo) { q += ' AND created_at <= ?' + (params.length + 1); params.push(dateTo + 'T23:59:59Z'); }
  if (tag) { q += ' AND tags LIKE ?' + (params.length + 1); params.push('%"' + tag + '"%'); }

  q += ' ORDER BY created_at DESC LIMIT 200';

  const stmt = env.DB.prepare(q);
  const { results } = params.length ? await stmt.bind(...params).all() : await stmt.all();

  const assets = results.map(r => ({
    id: r.id, type: r.type, name: r.name, owner: r.owner,
    note: r.note || '',
    tags: safeParse(r.tags, []),
    relatedAssets: safeParse(r.related_assets, []),
    usageHistory: safeParse(r.usage_history, []),
    file: r.file_name ? { name: r.file_name, size: r.file_size, sizeBytes: r.file_size_bytes, ext: r.file_ext, downloadURL: r.download_url } : null,
    createdAt: r.created_at,
  }));
  return J({ assets, total: assets.length });
}

function safeParse(str, fallback) { try { return JSON.parse(str || ''); } catch { return fallback; } }

// ===== Upload single =====
async function handleUpload(request, env, J, E) {
  await ensureSchema(env);
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) return E('需要 multipart/form-data');
  const fd = await request.formData();
  const result = await processAsset(fd, env);
  if (result.error) return E(result.error);
  return J(result);
}

// ===== Batch upload =====
async function handleBatchUpload(request, env, J, E) {
  await ensureSchema(env);
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) return E('需要 multipart/form-data');
  const fd = await request.formData();

  // Expect: files[] (multiple), type, owner, tags, note
  const files = fd.getAll('files');
  const type = fd.get('type')?.toString().trim();
  const owner = fd.get('owner')?.toString().trim();
  const note = fd.get('note')?.toString().trim() || '';
  const tags = fd.get('tags')?.toString().trim() || '[]';

  if (!files.length) return E('没有文件');
  if (!type) return E('缺少资产类型');
  if (!owner) return E('缺少负责人');

  const results = [];
  for (const file of files) {
    if (!file.name) continue;
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_\-]/g, ' ');
    const fd2 = new FormData();
    fd2.append('type', type);
    fd2.append('name', name);
    fd2.append('owner', owner);
    fd2.append('note', note);
    fd2.append('tags', tags);
    fd2.append('file', file);
    try { results.push(await processAsset(fd2, env)); } catch (e) { results.push({ error: e.message, name: file.name }); }
  }
  return J({ results, total: results.length, success: results.filter(r => !r.error).length });
}

async function processAsset(fd, env) {
  const type = fd.get('type')?.toString().trim();
  const name = fd.get('name')?.toString().trim();
  const owner = fd.get('owner')?.toString().trim();
  const note = fd.get('note')?.toString().trim() || '';
  const tags = fd.get('tags')?.toString().trim() || '[]';
  const relatedStr = fd.get('relatedAssets')?.toString().trim() || '[]';
  const file = fd.get('file');

  if (!type || !name || !owner) return { error: '缺少必填字段' };
  if (!['场景', '人物', '道具'].includes(type)) return { error: '类型无效' };

  // Validate JSON
  try { JSON.parse(tags); } catch { return { error: 'tags 格式错误' }; }
  try { JSON.parse(relatedStr); } catch { return { error: 'relatedAssets 格式错误' }; }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let fileData = null;

  if (file && file.name) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const safeName = id + (ext ? '.' + ext : '');
    const repoPath = 'ai-video-assets/files/' + safeName;
    const buf = await file.arrayBuffer();
    const enc = b64(buf);

    await gh(env, '/repos/linkseinschlafen-dot/linkseinschlafen-dot.github.io/contents/' + repoPath, {
      method: 'PUT',
      body: JSON.stringify({ message: 'upload: ' + (file.name || 'file'), content: enc }),
    });

    const sb = file.size, smb = sb / (1024 * 1024);
    fileData = {
      name: file.name,
      size: smb >= 1 ? smb.toFixed(2) + ' MB' : (sb / 1024).toFixed(0) + ' KB',
      sizeBytes: sb, ext,
      downloadURL: 'https://raw.githubusercontent.com/linkseinschlafen-dot/linkseinschlafen-dot.github.io/main/' + repoPath,
    };
  }

  await env.DB.prepare('INSERT INTO assets (id, type, name, owner, note, tags, related_assets, usage_history, file_name, file_size, file_size_bytes, file_ext, download_url, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)')
    .bind(id, type, name, owner, note, tags, relatedStr, '[]',
      fileData?.name || null, fileData?.size || null, fileData?.sizeBytes || null,
      fileData?.ext || null, fileData?.downloadURL || null, now).run();

  return { success: true, id, file: fileData };
}

// ===== Usage tracking =====
async function handleUsage(p, request, env, J, E) {
  const m = p.match(/^\/api\/assets\/(.+)\/usage$/);
  const id = m[1];
  const body = await request.json();
  const { videoName } = body;
  if (!videoName) return E('缺少 videoName');

  const row = await env.DB.prepare('SELECT usage_history FROM assets WHERE id = ?1').bind(id).first();
  if (!row) return E('资产不存在', 404);

  const history = safeParse(row.usage_history, []);
  history.push({ videoName, date: new Date().toISOString(), id: crypto.randomUUID() });

  await env.DB.prepare('UPDATE assets SET usage_history = ?1 WHERE id = ?2').bind(JSON.stringify(history), id).run();
  return J({ success: true, usageHistory: history });
}

// ===== Relations =====
async function handleRelations(p, request, env, J, E) {
  const m = p.match(/^\/api\/assets\/(.+)\/relations$/);
  const id = m[1];
  const body = await request.json();
  const { relatedAssets } = body;
  if (!Array.isArray(relatedAssets)) return E('relatedAssets 必须是数组');

  await env.DB.prepare('UPDATE assets SET related_assets = ?1 WHERE id = ?2').bind(JSON.stringify(relatedAssets), id).run();
  return J({ success: true });
}

// ===== Download =====
async function handleDownload(id, env, E) {
  const row = await env.DB.prepare('SELECT file_name, download_url FROM assets WHERE id = ?1').bind(id).first();
  if (!row || !row.download_url) return E('文件不存在', 404);
  return Response.redirect(row.download_url, 302);
}

// ===== Delete =====
async function handleDelete(id, env, J, E) {
  const row = await env.DB.prepare('SELECT download_url FROM assets WHERE id = ?1').bind(id).first();
  if (!row) return E('资产不存在', 404);
  if (row.download_url) {
    try {
      const rp = row.download_url.replace('https://raw.githubusercontent.com/linkseinschlafen-dot/linkseinschlafen-dot.github.io/main/', '');
      const fi = await gh(env, '/repos/linkseinschlafen-dot/linkseinschlafen-dot.github.io/contents/' + rp);
      if (fi.sha) await gh(env, '/repos/linkseinschlafen-dot/linkseinschlafen-dot.github.io/contents/' + rp, { method: 'DELETE', body: JSON.stringify({ message: 'delete: ' + rp, sha: fi.sha }) });
    } catch (e) { /* ok */ }
  }
  await env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(id).run();
  return J({ success: true });
}

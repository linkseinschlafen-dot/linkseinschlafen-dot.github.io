// Cloudflare Worker - AI视频资产管理 API 代理
// D1 存元数据，GitHub API 存文件，token 在服务端安全存储
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const _json = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    };

    const _err = (msg, status = 400) => _json({ error: msg }, status);

    try {
      // GET /api/assets — 列表
      if (method === 'GET' && path === '/api/assets') {
        const type = url.searchParams.get('type') || '';
        let query = 'SELECT * FROM assets ORDER BY created_at DESC';
        const params = type ? [type] : [];
        if (type) query = 'SELECT * FROM assets WHERE type = ?1 ORDER BY created_at DESC';
        const { results } = await (type
          ? env.DB.prepare(query).bind(...params).all()
          : env.DB.prepare(query).all());
        const assets = results.map(r => ({
          id: r.id, type: r.type, name: r.name, owner: r.owner,
          note: r.note || '',
          file: r.file_name ? { name: r.file_name, size: r.file_size, ext: r.file_ext, downloadURL: r.download_url } : null,
          createdAt: r.created_at,
        }));
        return _json({ assets, total: assets.length });
      }

      // POST /api/assets — 上传
      if (method === 'POST' && path === '/api/assets') {
        return handleUpload(request, env, _json, _err);
      }

      // GET /api/assets/:id/download — 下载
      const dlMatch = path.match(/^\/api\/assets\/(.+)\/download$/);
      if (method === 'GET' && dlMatch) {
        return handleDownload(dlMatch[1], env, _err);
      }

      // DELETE /api/assets/:id — 删除
      const delMatch = path.match(/^\/api\/assets\/(.+)$/);
      if (method === 'DELETE' && delMatch) {
        return handleDelete(delMatch[1], env, _json, _err);
      }

      return _json({ message: 'AI视频资产管理 API v2', status: 'ok' });
    } catch (e) {
      console.error(e);
      return _err('服务器错误: ' + (e.message || '未知'), 500);
    }
  },
};

async function ghAPI(env, path, options = {}) {
  const headers = {
    'Authorization': 'Bearer ' + env.GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-video-assets-worker',
  };
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('https://api.github.com' + path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'GitHub API error ' + res.status);
  return data;
}

async function handleUpload(request, env, _json, _err) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) return _err('请使用 multipart/form-data');

  const fd = await request.formData();
  const type = fd.get('type')?.toString().trim();
  const name = fd.get('name')?.toString().trim();
  const owner = fd.get('owner')?.toString().trim();
  const note = fd.get('note')?.toString().trim() || '';
  const file = fd.get('file');

  if (!type) return _err('缺少资产类型');
  if (!name) return _err('缺少资产名称');
  if (!owner) return _err('缺少负责人');
  if (!['场景', '人物', '道具'].includes(type)) return _err('类型必须为：场景、人物、道具');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let fileData = null;

  if (file && file.name) {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const safeName = id + '.' + ext;
    const repoPath = 'ai-video-assets/files/' + safeName;
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

    // Upload to GitHub repo
    await ghAPI(env, '/repos/linkseinschlafen-dot/linkseinschlafen-dot.github.io/contents/' + repoPath, {
      method: 'PUT',
      body: JSON.stringify({ message: 'upload: ' + (file.name || 'file'), content: b64 }),
    });

    const sizeB = file.size;
    const sizeMB = sizeB / (1024 * 1024);
    fileData = {
      name: file.name,
      size: sizeMB >= 1 ? sizeMB.toFixed(2) + ' MB' : (sizeB / 1024).toFixed(0) + ' KB',
      sizeBytes: sizeB,
      ext,
      downloadURL: 'https://raw.githubusercontent.com/linkseinschlafen-dot/linkseinschlafen-dot.github.io/main/' + repoPath,
    };
  }

  await env.DB.prepare(`INSERT INTO assets (id, type, name, owner, note, file_name, file_size, file_size_bytes, file_ext, download_url, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
    .bind(id, type, name, owner, note,
      fileData?.name || null, fileData?.size || null, fileData?.sizeBytes || null,
      fileData?.ext || null, fileData?.downloadURL || null, now).run();

  return _json({ success: true, id, file: fileData });
}

async function handleDownload(id, env, _err) {
  const row = await env.DB.prepare('SELECT file_name, download_url FROM assets WHERE id = ?1').bind(id).first();
  if (!row || !row.download_url) return _err('文件不存在', 404);
  return Response.redirect(row.download_url, 302);
}

async function handleDelete(id, env, _json, _err) {
  const row = await env.DB.prepare('SELECT download_url FROM assets WHERE id = ?1').bind(id).first();
  if (!row) return _err('资产不存在', 404);

  // Try to delete file from GitHub
  if (row.download_url) {
    try {
      const repoPath = row.download_url.replace('https://raw.githubusercontent.com/linkseinschlafen-dot/linkseinschlafen-dot.github.io/main/', '');
      const fileInfo = await ghAPI(env, '/repos/linkseinschlafen-dot/linkseinschlafen-dot.github.io/contents/' + repoPath);
      if (fileInfo.sha) {
        await ghAPI(env, '/repos/linkseinschlafen-dot/linkseinschlafen-dot.github.io/contents/' + repoPath, {
          method: 'DELETE',
          body: JSON.stringify({ message: 'delete: ' + repoPath, sha: fileInfo.sha }),
        });
      }
    } catch (e) { console.error('Delete file error:', e); }
  }

  await env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(id).run();
  return _json({ success: true });
}
